# TLS / HTTPS

dev-oidc serves HTTPS by auto-provisioning certs from your local mkcert root CA, or from cert/key files you provide explicitly. This guide covers both modes plus the host setup that makes them work.

## Overview

Two modes:

- **Auto-mkcert** (default when TLS is enabled). dev-oidc detects mkcert in `PATH`, signs leaf certs from your mkcert root CA for the configured hostnames, and caches them. Browsers trust the result automatically because you've already installed the mkcert root via `mkcert -install`.
- **BYO** (Bring Your Own). You supply a cert + key file path. dev-oidc reads them once at startup and uses them as-is. Use this when you have a corporate CA, an ACME client, or anything other than mkcert producing your local certs.

When no `tls` config is set (legacy v0.2 behavior), dev-oidc serves plain HTTP.

## Quick start (host install)

One-time per dev machine, lifetime, across all dev tools that use mkcert:

| OS                    | Command                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                 | `brew install mkcert && mkcert -install`                                                                                                                                                                                |
| Linux (Ubuntu/Debian) | `sudo apt install libnss3-tools && curl -L https://github.com/FiloSottile/mkcert/releases/latest/download/mkcert-v1.4.4-linux-amd64 -o /usr/local/bin/mkcert && sudo chmod +x /usr/local/bin/mkcert && mkcert -install` |
| WSL                   | Same as Linux                                                                                                                                                                                                           |
| Windows               | `choco install mkcert && mkcert -install`                                                                                                                                                                               |

`mkcert -install` adds the root CA to your OS trust store. Browsers (Chromium, Firefox, Safari) trust certs signed by that root.

## Native (no Docker)

```bash
dev-oidc start --config dev-oidc.config.json --tls
```

dev-oidc generates leaves for `[<host>, "localhost"]` via mkcert and caches them under `${XDG_CACHE_HOME:-~/.cache}/dev-oidc/certs/`. The cache key is a SHA-256 hash of the sorted hostname list — change the hostnames and you get a fresh pair.

To customize SANs:

```bash
dev-oidc start --config dev-oidc.config.json --tls --tls-hostname dev-oidc.localhost --tls-hostname myapp.local
```

## Docker

The published image bundles `mkcert`. Mount your host's mkcert root into the container so leaves are signed by the same root your browser already trusts. The CAROOT volume is also what makes the cert fingerprint stable across `docker compose down` / `up`: the cert cache lives in `/data` (already volume-mounted), but CAROOT lives at `~/.local/share/mkcert` — without a host mount, the container regenerates the CA on every recreate and the cached leaf no longer chains to it.

```yaml
services:
  dev-oidc:
    image: ghcr.io/camcima/dev-oidc:0.3.1
    ports:
      - '8095:8095'
    volumes:
      - ./hub.json:/config/hub.json:ro
      - dev-oidc-data:/data
      # Linux/WSL host mkcert root (read-only):
      - ${HOME}/.local/share/mkcert:/home/node/.local/share/mkcert:ro
      # macOS: replace the line above with:
      # - ${HOME}/Library/Application Support/mkcert:/home/node/.local/share/mkcert:ro
    command:
      - start
      - --hub-config
      - /config/hub.json

volumes:
  dev-oidc-data:
```

The corresponding `hub.json`:

```json
{
  "server": {
    "port": 8095,
    "host": "0.0.0.0",
    "publicUrl": "https://dev-oidc.localhost:8095",
    "tls": {
      "hostnames": ["dev-oidc.localhost", "localhost"]
    }
  },
  "tenants": []
}
```

Add `127.0.0.1 dev-oidc.localhost` to your `/etc/hosts` so the SAN resolves locally.

## Hub-mode `hub.json` schema

The `server.tls` block has four valid shapes:

| Value                             | Behavior                                        |
| --------------------------------- | ----------------------------------------------- |
| _absent_                          | HTTP listener (v0.2.x compat).                  |
| `{}`                              | Auto-mkcert with default hostnames.             |
| `{ "hostnames": ["..."] }`        | Auto-mkcert with explicit SANs.                 |
| `{ "cert": "...", "key": "..." }` | BYO mode; mkcert never invoked.                 |
| `{ "cert", "key", "hostnames" }`  | **Invalid**: BYO and `hostnames` are exclusive. |

BYO paths can be relative; they resolve against the directory containing `hub.json`. Absolute paths are recommended for clarity.

## Legacy CLI flags

| Flag                    | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `--tls`                 | Enable TLS with auto-mkcert (default hostnames).               |
| `--tls-hostname <host>` | Append a SAN to auto-mkcert mode. Repeatable. Implies `--tls`. |
| `--tls-cert <path>`     | BYO cert file. Must pair with `--tls-key`. Implies `--tls`.    |
| `--tls-key <path>`      | BYO key file. Must pair with `--tls-cert`.                     |

CLI paths resolve relative to CWD with tilde expansion (`~/foo` → `$HOME/foo`).

## HTTP→HTTPS redirect

When TLS is enabled, dev-oidc multiplexes both protocols on the same port via [`@httptoolkit/httpolyglot`](https://github.com/httptoolkit/httpolyglot). Plain HTTP requests get a `301 Moved Permanently` to the same path under `https://`:

```bash
$ curl -i http://localhost:8095/.well-known/openid-configuration
HTTP/1.1 301 Moved Permanently
Location: https://localhost:8095/.well-known/openid-configuration
```

This means bookmarks self-correct. There is no separate HTTP-redirect port.

## BYO mode

Use BYO when you can't or don't want to use mkcert:

```json
{
  "server": {
    "tls": {
      "cert": "/abs/path/cert.pem",
      "key": "/abs/path/key.pem"
    }
  }
}
```

dev-oidc reads both files **once at startup**. Editing them on disk requires a process restart. File permissions: the `node` user inside the container needs read access; mode `0644` for the cert and `0600` for the key is conventional.

## Troubleshooting

### "TLS requires mkcert"

You haven't installed mkcert, or it isn't on `PATH`. Install per the [Quick start](#quick-start-host-install) table.

### "run `mkcert -install` once on your host"

mkcert is installed but the root CA hasn't been generated. Run `mkcert -install` once. On Linux/WSL this also installs the root into `nss` (Firefox).

### Browser still warns about an untrusted cert

Most likely a CAROOT mismatch. dev-oidc's startup log includes the resolved CAROOT path. If it differs from the path your browser trusts, either:

- Set `CAROOT` env var explicitly (both when running `mkcert -install` and when starting dev-oidc).
- In Docker, ensure the volume mount points at the correct host CAROOT.

A common footgun: running `sudo mkcert -install` installs the root into `/root/.local/share/mkcert/`, not your user CAROOT. Rerun without sudo.

### Cert fingerprint changes after `docker compose down` / `up`

Symptom: browser warns "Your connection is not private" with `NET::ERR_CERT_AUTHORITY_INVALID` after recreating the container, even though it worked before. Or `curl` reports `unable to get local issuer certificate` against a CA you previously trusted.

Cause: the cert cache survives in `/data` (volume-mounted), but CAROOT at `~/.local/share/mkcert` is in the container's writable layer. On `down`/`up` (vs. `restart`), CAROOT regenerates → fresh CA → cached leaf no longer chains to it.

Fix: mount your host CAROOT into the container as shown in the [Docker](#docker) section. With the mount in place, both the cert cache and the CA persist, and the fingerprint stays stable.

### Port already in use

dev-oidc binds to one port (8095 by default). If another process is using it, change `server.port` in `hub.json` or `--port` in legacy CLI.

### Tests fail with "cert expired"

The fixture cert pair under `tests/fixtures/tls/` eventually expires (~825-day mkcert default). See `tests/fixtures/tls/README.md` for the regeneration recipe.

## Internals

The same-port multiplex uses [`@httptoolkit/httpolyglot`](https://www.npmjs.com/package/@httptoolkit/httpolyglot), the maintained fork of the original `httpolyglot` by HTTP Toolkit. It peeks the first byte of each TCP connection: `0x16` is a TLS ClientHello → route to `https.Server`; otherwise → route to `http.Server`. Both paths drive the same Fastify request handler; the redirect hook checks `req.socket.encrypted` to decide.

TLS material is loaded once at startup (no hot-reload). To pick up new certs or a different mkcert root, restart the process. dev-oidc logs a WARN when `hub.json`'s `tls` block changes on disk, reminding you to restart.
