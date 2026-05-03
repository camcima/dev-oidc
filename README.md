<div align="center">

<picture>
  <img alt="dev-oidc" src="assets/logo.svg" width="520">
</picture>

<br>

[![CI](https://github.com/camcima/dev-oidc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/camcima/dev-oidc/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/camcima/dev-oidc/graph/badge.svg)](https://codecov.io/gh/camcima/dev-oidc)
[![npm version](https://img.shields.io/npm/v/dev-oidc)](https://www.npmjs.com/package/dev-oidc)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)

</div>

A minimal, config-driven OIDC provider for local development.

## Why

When you build an app that integrates with an OIDC provider (Azure AD / Entra, Auth0, Keycloak, Okta), local iteration is painful: you either bypass auth in dev (drift between dev and prod) or stand up a full IdP (slow). `dev-oidc` sits where the real IdP would — your app runs its real auth code path (redirect, token exchange, JWT verify, refresh) against a mock that you configure via a JSON file.

- **Full auth-code + PKCE** flow with redirect + login page + token exchange.
- **Refresh tokens** with single-use rotation — each `/token` response carries a fresh `refresh_token`.
- **Profile tiles** on the login page — pick a user with one click, no password.
- **Hot reload** of the config file — edit the JSON on disk or from another tool, no restart.
- **Admin UI** at `/admin` for profile CRUD.
- **Persistent signing keys** (optional) so JWTs survive server restarts.
- **RS256 and ES256** signing algorithms, configurable per deployment.
- **Optional `clientSecret`** — public clients require no secret; confidential clients can use `client_secret_post` or `client_secret_basic`.
- **End-to-end scope propagation** — `scope` is reflected in the token response and as a claim in the access token.
- **Root landing page** at `GET /` listing discovery, JWKS, and (when admin is enabled) the admin link.
- **Permissive CORS** for browser apps running on `localhost:*`.
- **OIDC-conformant enough** for `oidc-client-ts`, MSAL, and standard JWT libraries to work against it.

---

## Using dev-oidc in your project

This is a five-minute walkthrough to point an existing app's OIDC integration at dev-oidc instead of a real IdP during development.

### 1. Run dev-oidc

Pick one of the run modes below (Hub, Docker, CLI, programmatic). All modes read the same project JSON config.

In **Hub mode** (the default — `dev-oidc start`), each registered project is served under a URL slug derived from its directory name. This walkthrough assumes a slug of `my-app`. In **legacy mode** (`dev-oidc start --config <path>`) and **Docker**, drop the `/<slug>` segment from every URL below.

### 2. Point your app at it

Wherever your app reads its OIDC settings (usually env vars), swap the provider URLs for dev-oidc's:

| Your app's config key       | Production value                                  | Dev value (Hub mode)                                  | Dev value (legacy / Docker)                           |
| --------------------------- | ------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `OIDC_ISSUER` / `authority` | `https://login.microsoftonline.com/<tenant>/v2.0` | `http://localhost:8095/my-app`                        | `http://localhost:8095`                               |
| `OIDC_CLIENT_ID`            | your app registration ID                          | matches `clients[].clientId` in dev-oidc config       | matches `clients[].clientId` in dev-oidc config       |
| `OIDC_AUDIENCE`             | your API's audience                               | matches `clients[].audience` in dev-oidc config       | matches `clients[].audience` in dev-oidc config       |
| Redirect URI                | your prod callback URL                            | matches `clients[].redirectUris[]` in dev-oidc config | matches `clients[].redirectUris[]` in dev-oidc config |

### 3. Use the login flow

URLs below show Hub mode; in legacy/Docker mode drop the `/my-app` segment.

1. Your app redirects to `http://localhost:8095/my-app/authorize?client_id=...&redirect_uri=...&response_type=code&scope=openid&code_challenge=...&code_challenge_method=S256`.
2. dev-oidc renders a tile per `profile` in the config.
3. User clicks a tile → dev-oidc redirects to your app's `redirect_uri` with a `code`.
4. Your app exchanges the code for tokens at `http://localhost:8095/my-app/token`.
5. Your app verifies the JWT using the JWKS at `http://localhost:8095/my-app/.well-known/jwks.json`.

The same code path runs in production — only the URLs change.

---

## Run mode 1 — Hub (recommended for many projects)

Run a single dev-oidc process that serves multiple project tenants concurrently. Each project keeps its own `dev-oidc.config.json` in its repo; a registry at `~/.config/dev-oidc/hub.json` tracks which projects are mounted.

**Setup:**

```bash
npm install -g dev-oidc                                # or run via npx
dev-oidc register /path/to/your/project                # accepts a project dir or a path to dev-oidc.config.json
# (optional) dev-oidc register /path/to/your/project --slug my-app
dev-oidc start                                         # listens on 127.0.0.1:8095
```

When given a directory, `register` looks for `dev-oidc.config.json` inside it. The slug defaults to a hyphenated form of the directory name; pass `--slug` to override.

Each tenant gets its own URL namespace:

- Discovery: `http://localhost:8095/<slug>/.well-known/openid-configuration`
- Authorize: `http://localhost:8095/<slug>/authorize`
- Token: `http://localhost:8095/<slug>/token`
- Admin: `http://localhost:8095/admin/<slug>`

The Hub's dashboard at `http://localhost:8095/admin` lists all registered tenants.

**Commands:**

| Command                      | What it does                              |
| ---------------------------- | ----------------------------------------- |
| `dev-oidc start`             | Start the Hub.                            |
| `dev-oidc register <path>`   | Mount a project's `dev-oidc.config.json`. |
| `dev-oidc unregister <slug>` | Remove a tenant from the registry.        |
| `dev-oidc list`              | List registered tenants.                  |

The Hub watches `hub.json` — `register`/`unregister` take effect within ~200 ms with no restart.

---

## TLS / HTTPS

dev-oidc serves HTTPS automatically when you enable it. The Docker image bundles `mkcert` so leaves are signed by your existing host CA — browsers trust them automatically once you've run `mkcert -install` once on your host.

Minimal `hub.json`:

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

Compose snippet (Linux/WSL):

```yaml
services:
  dev-oidc:
    image: ghcr.io/camcima/dev-oidc:0.3.1
    ports:
      - '8095:8095'
    volumes:
      - ./hub.json:/config/hub.json:ro
      - dev-oidc-data:/data
      - ${HOME}/.local/share/mkcert:/home/node/.local/share/mkcert:ro
    command: [start, --hub-config, /config/hub.json]

volumes:
  dev-oidc-data:
```

Same-port HTTP→HTTPS redirect via [`@httptoolkit/httpolyglot`](https://github.com/httptoolkit/httpolyglot): plain `http://...` requests get `301`'d to `https://...` automatically. See [docs/tls.md](https://github.com/camcima/dev-oidc/blob/main/docs/tls.md) for the full feature reference, BYO mode, troubleshooting, and per-OS volume mount paths.

---

## Run mode 2 — Docker (recommended for teams)

```bash
docker run --rm -p 8095:8095 \
  -v "$(pwd)/dev-oidc.config.json:/config/config.json:ro" \
  -v dev-oidc-data:/data \
  ghcr.io/camcima/dev-oidc:0.3.1
```

- `/config/config.json` — your config file (see [Config reference](#config-reference)).
- `/data` — optional persistent volume for the signing key (see [Signing-key persistence](#signing-key-persistence)).

The image listens on port `8095` inside the container. If you map it to a different host port (e.g. `-p 9000:8095`), pass `-e DEV_OIDC_PUBLIC_URL=http://localhost:9000` so the issuer dev-oidc advertises in discovery matches the URL relying parties actually call. The image's default `DEV_OIDC_PUBLIC_URL=http://localhost:8095` only fits the `8095:8095` mapping.

---

## Run mode 2b — docker-compose (recommended for projects)

```yaml
# docker-compose.yml
services:
  dev-oidc:
    image: ghcr.io/camcima/dev-oidc:0.3.1
    volumes:
      - ./dev-oidc.config.json:/config/config.json:ro
      - dev-oidc-data:/data
    ports:
      - '8095:8095'
    healthcheck:
      test:
        - CMD-SHELL
        - 'wget -q -O- http://127.0.0.1:8095/.well-known/openid-configuration > /dev/null || exit 1'
      interval: 5s
      timeout: 2s
      retries: 10

  your-api:
    build: .
    depends_on:
      dev-oidc:
        condition: service_healthy
    environment:
      OIDC_ISSUER: http://dev-oidc:8095
      OIDC_CLIENT_ID: my-app
      OIDC_AUDIENCE: my-api

volumes:
  dev-oidc-data:
```

**Important notes:**

- Use `http://dev-oidc:8095` (the compose service name) for **server-to-server** calls between containers on the shared Docker network — for example, your API validating JWTs by fetching JWKS.
- Use `http://localhost:8095` for **browser-side** redirects and token calls — the user's browser doesn't resolve Docker service names.
- The image's default `CMD` already passes `--host 0.0.0.0` so the published port is reachable from the host. The project config no longer accepts `host`/`port` fields — both are CLI/Hub concerns now.
- If your relying parties resolve dev-oidc through a name other than `localhost` (e.g. `dev-oidc` on the compose network), pass `--public-url http://dev-oidc:8095` so the issuer in discovery and JWTs matches the URL the RPs will use to fetch JWKS.

---

## Run mode 3 — Legacy single-tenant CLI

Use this mode when you want a single isolated OIDC server for one project, without the Hub registry.

```bash
npm install --save-dev dev-oidc
npx dev-oidc start --config ./dev-oidc.config.json
```

Optional flags:

| Flag                 | Default     | Purpose                                           |
| -------------------- | ----------- | ------------------------------------------------- |
| `--port <number>`    | `8095`      | TCP port to listen on.                            |
| `--host <address>`   | `127.0.0.1` | Address to bind.                                  |
| `--public-url <url>` | derived     | Issuer base URL reported in discovery and tokens. |

Or programmatically, e.g. in a Vitest `globalSetup`:

```ts
import { createDevOidcServer, loadConfig } from 'dev-oidc';
// import { readFileSync } from 'node:fs';

const config = await loadConfig('./dev-oidc.config.json');
const server = await createDevOidcServer({
  config,
  // Optional. Defaults to `publicUrl` or `http://${listenHost}:${listenPort}`.
  // Pass explicitly when relying parties resolve dev-oidc through a
  // different name than the listen address.
  // issuer: 'http://localhost:8095',
  listenHost: '127.0.0.1',
  listenPort: 8095,
  // v0.3+: Optional. When set, serves HTTPS via @httptoolkit/httpolyglot
  // multiplex (same-port HTTP→HTTPS redirect included). Both Buffers must
  // be PEM-formatted.
  // tls: {
  //   cert: readFileSync('./certs/cert.pem'),
  //   key:  readFileSync('./certs/key.pem'),
  // },
});
await server.app.listen({ port: 8095, host: '127.0.0.1' });
```

---

## Config reference

Every field in `dev-oidc.config.json`:

> **Hub mode vs Legacy mode:** In Hub mode, the listener address, port, and issuer base URL are owned by the Hub process (configured in `~/.config/dev-oidc/hub.json`). In Legacy single-tenant mode, pass `--port`, `--host`, and `--public-url` to `dev-oidc start --config <path>`. The project config file no longer accepts `issuer`, `port`, or `host` fields — configs that include them fail validation with a tailored error.

```jsonc
{
  "signingKey": {
    "kid": "dev-key-1", // Required. Key ID surfaced in JWKS + JWT header.
    "alg": "RS256", // Default "RS256". Also supports "ES256" — see Signing algorithm below.
    "source": "generate", // Default "generate" (ephemeral) or "file:<path>" (persistent).
  },
  "clients": [
    // Required. One or more registered clients.
    {
      "clientId": "my-app", // What your app sends as `client_id`.
      "clientSecret": "s3cr3t", // Optional. Omit for public clients (no secret required).
      "redirectUris": [
        // Exact-match allowlist.
        "http://localhost:5173/auth/callback",
      ],
      "postLogoutRedirectUris": [
        // Optional. Default [].
        "http://localhost:5173/",
      ],
      "audience": "my-api", // Required. Populates the JWT `aud` claim.
    },
  ],
  "subjectClaim": "sub", // Default "sub". Use "oid" for Azure AD / Entra compat.
  "tokenTtlSeconds": 900, // Default 900. Access-token lifetime.
  "refreshTokenTtlSeconds": 28800, // Default 28800. Refresh-token lifetime.
  "branding": {
    "title": "Dev OIDC Login", // Default "Dev OIDC Login".
    "accentColor": "#1f6feb", // Default #1f6feb.
    "logoUrl": null, // Default null.
  },
  "profiles": [
    // The users offered on the login page.
    {
      "id": "alice", // Goes into the `sub` (or `oid`) claim.
      "displayName": "Alice Developer",
      "email": "alice@example.com",
      "avatar": null, // Optional URL, default null.
      "claims": {
        // Optional. Merged into every JWT for this profile.
        "department": "Engineering",
        "platformRole": "admin",
      },
    },
  ],
}
```

The canonical schema lives in [`src/config/schema.ts`](https://github.com/camcima/dev-oidc/blob/main/src/config/schema.ts) — it validates every config file on load and on hot reload, so typos fail fast with a zod error pointing at the bad field.

### Signing-key persistence

By default (`signingKey.source: "generate"`) a fresh RSA keypair is created at every boot. That's fine for one-shot tests but disruptive during interactive development: every container restart rotates the key, which invalidates any JWTs your app had in browser storage **and** breaks your API's cached JWKS until it refetches.

To persist the key across restarts, set `source` to `"file:<path>"`:

```jsonc
{
  "signingKey": { "kid": "dev-key-1", "source": "file:/data/signing-key.json" },
}
```

On first boot, dev-oidc generates a keypair and writes it to the path as JSON (with `0600` permissions). On subsequent boots it loads the same key. Mount a Docker volume at `/data` (or your chosen path) to persist it across container rebuilds:

```yaml
services:
  dev-oidc:
    volumes:
      - dev-oidc-data:/data
    # ...
volumes:
  dev-oidc-data:
```

Rotate the key by either changing the `kid` (dev-oidc will refuse to load a file with a mismatched kid, forcing you to delete and regenerate) or just deleting the file.

### Claim mapping

`subjectClaim` controls which JWT claim carries the user's ID. Three choices in practice:

- `"sub"` (default) — standard OIDC. Most libraries (`oidc-client-ts`, Auth0, Keycloak) read this.
- `"oid"` — Entra / Azure AD convention. If your backend expects `oid`, set this.
- Anything else — for custom integrations. The profile's `id` still lands in `sub` too; `subjectClaim` just adds an alias.

Everything in `profile.claims` is merged into the issued JWT verbatim, with these reserved claim names protected from override: `sub`, `name`, `email`, `iat`, `exp`, `iss`, `aud`, `nonce`.

### Confidential clients

When a client entry includes `clientSecret`, dev-oidc requires the secret at the `/token` endpoint. Public clients (no `clientSecret`) continue to work without any secret, as before.

Two auth methods are accepted:

- **`client_secret_post`** — include `client_secret` as a form field in the `POST /token` body.
- **`client_secret_basic`** — HTTP Basic auth: `Authorization: Basic <base64(clientId:clientSecret)>`.

When the secret is missing or wrong, dev-oidc returns `401` with `WWW-Authenticate: Basic realm="dev-oidc"`.

Example config entry:

```json
{
  "clients": [
    {
      "clientId": "confidential-app",
      "clientSecret": "s3cr3t-value",
      "redirectUris": ["http://localhost:5173/auth/callback"],
      "audience": "my-api"
    }
  ]
}
```

### Signing algorithm

The `signingKey.alg` field accepts `"RS256"` (default) or `"ES256"`:

```json
{
  "signingKey": { "kid": "k1", "alg": "ES256", "source": "generate" }
}
```

File-backed key files written with `RS256` load unchanged when `alg` is `"RS256"`. ES256 key files written by this version are not loadable by alpha.2 — only forward-compatible within the same algorithm.

### Scope propagation

The `scope` parameter is propagated end-to-end:

- `/authorize` rejects requests whose `scope` does not include `openid` with `400 invalid_scope`.
- The `/token` response `scope` field reflects the scope the client actually requested, not a hardcoded string.
- Access tokens carry a `scope` claim with the same value.

### Refresh token rotation

dev-oidc rotates refresh tokens on every use. The consumed token becomes invalid as soon as `/token` returns the new one. Apps that previously cached a single refresh token must capture and store the new `refresh_token` from each `/token` response.

---

## Endpoints

In **Hub mode**, every OIDC route is namespaced under the tenant slug; replace `:slug` with the slug you registered. In **legacy/Docker mode** drop the `:slug/` segment.

| Path (Hub)                                    | Path (Legacy/Docker)                    | Purpose                                                  |
| --------------------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `GET /`                                       | `GET /`                                 | Hub landing page (lists tenants).                        |
| `GET /:slug/.well-known/openid-configuration` | `GET /.well-known/openid-configuration` | Discovery doc.                                           |
| `GET /:slug/.well-known/jwks.json`            | `GET /.well-known/jwks.json`            | Public keys.                                             |
| `GET /:slug/authorize`                        | `GET /authorize`                        | Renders the login page (tiles).                          |
| `POST /:slug/authorize/complete`              | `POST /authorize/complete`              | Issues an auth code.                                     |
| `POST /:slug/token`                           | `POST /token`                           | Code exchange + refresh.                                 |
| `GET` / `POST /:slug/logout`                  | `GET` / `POST /logout`                  | Ends the session.                                        |
| `GET /admin`                                  | `GET /admin`                            | Hub dashboard (Hub) / single admin page (Legacy/Docker). |
| `GET /admin/:slug`                            | —                                       | Per-tenant admin UI (profile CRUD).                      |

All OIDC flows require **PKCE with S256**. No implicit flow. Client secrets are optional — see [Confidential clients](#confidential-clients) below.

CORS is permissive by default (`Access-Control-Allow-Origin` reflects the request's `Origin`) — browser-based OIDC clients can fetch the discovery doc, JWKS, and token endpoint without additional config.

---

## Admin UI

Visit `http://localhost:8095/admin` to:

- View all configured profiles.
- Add, edit, or delete profiles. Changes write atomically to the JSON config file on disk.
- View the full raw config.

The admin UI subscribes to a Server-Sent Events stream at `/admin/events`. When the JSON config file is edited externally (by another tool, another human, or a coding agent), a "Config changed on disk" banner appears so you can reload.

**No authentication on `/admin`** — the default `127.0.0.1` bind is the only protection. If you run dev-oidc somewhere network-reachable, put it behind a firewall, reverse-proxy auth, or a VPN. dev-oidc is a development tool, not a production service.

From the login page itself, a small "Manage profiles →" link jumps to `/admin` for quick iteration.

---

## Limitations

- **Development only.** Not suitable for production use under any circumstances.
- **Single tenant per Docker container.** The Docker image runs in legacy single-tenant mode. Use Hub mode (CLI) for multi-tenant local development.
- **In-memory session state.** Authorization codes (60 s TTL) and refresh tokens (8 h default) are held in memory. A server restart invalidates all active codes and refresh tokens. Persistent session storage is intentionally out of scope. Signing keys can be persisted across restarts via `signingKey.source: "file:<path>"` (see [Signing-key persistence](#signing-key-persistence)).
- **Partial config hot-reload.** Edits to `clients`, `profiles`, `branding`, `subjectClaim`, and `tokenTtlSeconds` apply on the next request after the file watcher fires. Edits to `signingKey` (kid/alg/source) and `refreshTokenTtlSeconds` require a process restart — or, in Hub mode, `dev-oidc unregister <slug> && dev-oidc register <path>` — because they're baked into the per-tenant key material and refresh-token store at activation time. Live-rotating a signing key would invalidate every JWT minted before the rotation; that's not a hot-reload behavior we want.
- **Signing key rotates on every restart** unless `source: "file:<path>"` is set.
- **No authentication on `/admin`.**
- **Logout without redirect.** When `/logout` is called without a `post_logout_redirect_uri`, the server returns a 200 HTML "Signed out" page with a link back to `/`. If a registered `post_logout_redirect_uri` is provided, the normal 302 redirect applies.

---

## Library comparisons

- [`@navikt/mock-oauth2-server`](https://github.com/navikt/mock-oauth2-server) — JVM-based, highest protocol fidelity, generic login form UI. Use if you want JVM + stricter spec conformance.
- [`oauth2-mock-server`](https://github.com/axa-group/oauth2-mock-server) — Node, lighter footprint, programmatic hooks. Use if you don't need a login UI and want to drive auth programmatically in tests.
- [`node-oidc-provider`](https://github.com/panva/node-oidc-provider) — production-grade OIDC provider. Use if you want to build a real IdP, not a dev tool.
- **dev-oidc (this)** — Node, minimal, config-driven, login UI that lets you pick a profile with one click, admin UI, persistent keys. Use if that's what you want.

---

## Troubleshooting

**Browser shows `CORS error` when calling `/.well-known/openid-configuration`:**
dev-oidc enables permissive CORS by default. If you still see errors, the browser is probably loading a cached version of the page before dev-oidc added CORS headers. Hard-refresh (Cmd/Ctrl+Shift+R).

**API returns 401 "JWT verification failed" right after dev-oidc restarts:**
Your API's JWKS cache still has the old public key, but dev-oidc rotated it. Either restart your API, or enable [signing-key persistence](#signing-key-persistence).

**Inside Docker: `wget: can't connect to remote host: Connection refused` on healthcheck:**
Node binds IPv4-only when `host: "0.0.0.0"` but `localhost` can resolve to IPv6 inside Alpine. Use `127.0.0.1` in your healthcheck URL.

**`/authorize` returns 400 "redirect_uri does not match a registered value":**
The `redirect_uri` query param must exactly match one of `clients[].redirectUris[]` — no trailing slash tolerance, no path normalization.

**Config edits in the mounted file don't reload:**
Bind-mount file watching is unreliable on Docker Desktop for macOS/WSL2. `docker compose restart dev-oidc` after editing the config file is the simplest workaround; the admin UI (which writes via a Docker-internal path) doesn't hit this issue.

---

## Coding-agent skill

This repo ships a [Claude Code](https://claude.com/claude-code) skill that walks an agent through wiring dev-oidc into your app — detect the existing OIDC integration, generate a matching `dev-oidc.config.json`, pick a run mode, update env vars or compose files. Source: [`skills/dev-oidc-setup/`](https://github.com/camcima/dev-oidc/tree/main/skills/dev-oidc-setup).

Install with the [`skills`](https://github.com/vercel-labs/skills) CLI from Vercel Labs:

```bash
# Claude Code
npx skills add camcima/dev-oidc --skill dev-oidc-setup -a claude-code

# Other supported agents (Cursor, Codex, Cline, etc. — see `npx skills agents`)
npx skills add camcima/dev-oidc --skill dev-oidc-setup -a <agent>
```

Once installed, ask the agent to "set up dev-oidc in this project" (or any equivalent phrasing) and it picks up from there. The skill handles both first-time wire-ups (Hub mode, Docker compose, or legacy CLI) and edits to an existing `dev-oidc.config.json`.

To uninstall: `npx skills remove dev-oidc-setup -a claude-code`.

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](https://github.com/camcima/dev-oidc/blob/main/CONTRIBUTING.md) for setup, style, and commit conventions. Security issues: please read [SECURITY.md](https://github.com/camcima/dev-oidc/blob/main/SECURITY.md) first.

## Releasing

dev-oidc ships to two registries: **npm** (the `dev-oidc` package) and **GHCR** (`ghcr.io/camcima/dev-oidc`). Each registry has its own publish path, so you can release to either or both.

### npm only (release-it, local)

```bash
npm run release
```

`release-it` runs typecheck, lint, formatting checks, and tests; bumps `package.json` and `package-lock.json`; builds `dist`; verifies the npm package with `npm pack --dry-run`; then commits, tags `v${version}`, pushes, and publishes to npm.

For the current alpha line use `npm run release:alpha`. Use `npm run release:dry` to preview without writing changes.

### Docker only (GitHub Actions, GHCR)

```bash
npm run release:docker
```

This triggers the `release-docker.yml` workflow on GitHub Actions for the version currently in `package.json`. The workflow checks out the `v${version}` tag (which must already exist on origin), builds a multi-arch image (`linux/amd64`, `linux/arm64`), and pushes to `ghcr.io/camcima/dev-oidc:${version}` and `:latest`.

To backfill or re-publish a specific tag, dispatch the workflow directly:

```bash
gh workflow run release-docker.yml -f tag=v0.1.0           # also tags :latest
gh workflow run release-docker.yml -f tag=v0.1.0 -f latest=false
```

### npm + Docker

```bash
npm run release:all
```

Runs `npm run release` first (npm publish + tag push), then `npm run release:docker` (GitHub Actions multi-arch build + GHCR push) using the freshly-bumped version.

## Changelog

See [CHANGELOG.md](https://github.com/camcima/dev-oidc/blob/main/CHANGELOG.md).

## License

MIT.
