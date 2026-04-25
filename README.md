# dev-oidc

A minimal, config-driven OIDC provider for local development.

**Status:** Pre-release. npm publishing is automated locally with release-it.

[![CI](https://github.com/camcima/dev-oidc/actions/workflows/ci.yml/badge.svg)](https://github.com/camcima/dev-oidc/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dev-oidc.svg)](https://www.npmjs.com/package/dev-oidc)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

## Why

When you build an app that integrates with an OIDC provider (Azure AD / Entra, Auth0, Keycloak, Okta), local iteration is painful: you either bypass auth in dev (drift between dev and prod) or stand up a full IdP (slow). `dev-oidc` sits where the real IdP would — your app runs its real auth code path (redirect, token exchange, JWT verify, refresh) against a mock that you configure via a JSON file.

- **Full auth-code + PKCE** flow with redirect + login page + token exchange.
- **Refresh tokens** supported.
- **Profile tiles** on the login page — pick a user with one click, no password.
- **Hot reload** of the config file — edit the JSON on disk or from another tool, no restart.
- **Admin UI** at `/admin` for profile CRUD.
- **Persistent signing keys** (optional) so JWTs survive server restarts.
- **Permissive CORS** for browser apps running on `localhost:*`.
- **OIDC-conformant enough** for `oidc-client-ts`, MSAL, and standard JWT libraries to work against it.

---

## Using dev-oidc in your project

This is a five-minute walkthrough to point an existing app's OIDC integration at dev-oidc instead of a real IdP during development.

### 1. Run dev-oidc

Pick one of the three run modes below (Docker, CLI, programmatic). All three read the same JSON config.

### 2. Point your app at it

Wherever your app reads its OIDC settings (usually env vars), swap the provider URLs for dev-oidc's:

| Your app's config key       | Production value                                  | Dev value                                             |
| --------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| `OIDC_ISSUER` / `authority` | `https://login.microsoftonline.com/<tenant>/v2.0` | `http://localhost:8080`                               |
| `OIDC_CLIENT_ID`            | your app registration ID                          | matches `clients[].clientId` in dev-oidc config       |
| `OIDC_AUDIENCE`             | your API's audience                               | matches `clients[].audience` in dev-oidc config       |
| Redirect URI                | your prod callback URL                            | matches `clients[].redirectUris[]` in dev-oidc config |

### 3. Use the login flow

1. Your app redirects to `http://localhost:8080/authorize?client_id=...&redirect_uri=...&response_type=code&scope=openid&code_challenge=...&code_challenge_method=S256`.
2. dev-oidc renders a tile per `profile` in the config.
3. User clicks a tile → dev-oidc redirects to your app's `redirect_uri` with a `code`.
4. Your app exchanges the code for tokens at `http://localhost:8080/token`.
5. Your app verifies the JWT using the JWKS at `http://localhost:8080/.well-known/jwks.json`.

The same code path runs in production — only the URLs change.

---

## Run mode 1 — Docker (recommended for teams)

```bash
docker run --rm -p 8080:8080 \
  -v "$(pwd)/dev-oidc.config.json:/config/config.json:ro" \
  -v dev-oidc-data:/data \
  ghcr.io/camcima/dev-oidc:latest
```

- `/config/config.json` — your config file (see [Config reference](#config-reference)).
- `/data` — optional persistent volume for the signing key (see [Signing-key persistence](#signing-key-persistence)).

The image listens on port `8080` inside the container; map it to whatever you want on the host.

---

## Run mode 2 — docker-compose (recommended for projects)

```yaml
# docker-compose.yml
services:
  dev-oidc:
    image: ghcr.io/camcima/dev-oidc:latest
    volumes:
      - ./dev-oidc.config.json:/config/config.json:ro
      - dev-oidc-data:/data
    ports:
      - '8080:8080'
    healthcheck:
      test:
        - CMD-SHELL
        - 'wget -q -O- http://127.0.0.1:8080/.well-known/openid-configuration > /dev/null || exit 1'
      interval: 5s
      timeout: 2s
      retries: 10

  your-api:
    build: .
    depends_on:
      dev-oidc:
        condition: service_healthy
    environment:
      OIDC_ISSUER: http://dev-oidc:8080
      OIDC_CLIENT_ID: my-app
      OIDC_AUDIENCE: my-api

volumes:
  dev-oidc-data:
```

**Important notes:**

- Use `http://dev-oidc:8080` (the compose service name) for **server-to-server** calls between containers on the shared Docker network — for example, your API validating JWTs by fetching JWKS.
- Use `http://localhost:8080` for **browser-side** redirects and token calls — the user's browser doesn't resolve Docker service names.
- Your dev-oidc config's `issuer` must match whichever URL the JWT's recipients expect. For apps where both browser and server code need to reach dev-oidc, `http://localhost:8080` is usually the right choice (browsers require it, servers can still reach it via the mapped port).
- `"host": "0.0.0.0"` is required in the config so Fastify binds all interfaces inside the container.

---

## Run mode 3 — CLI (programmatic testing, or no Docker)

```bash
npm install --save-dev dev-oidc
npx dev-oidc start --config ./dev-oidc.config.json
```

Or programmatically, e.g. in a Vitest `globalSetup`:

```ts
import { createDevOidcServer, loadConfig } from 'dev-oidc';

const config = await loadConfig('./dev-oidc.config.json');
const server = await createDevOidcServer({ config });
await server.app.listen({ port: config.port, host: config.host });
```

---

## Config reference

Every field in `dev-oidc.config.json`:

```jsonc
{
  "issuer": "http://localhost:8080", // Required. Base URL of this instance.
  "port": 8080, // Default 8080. TCP port to listen on.
  "host": "127.0.0.1", // Default 127.0.0.1. Use 0.0.0.0 in containers.
  "signingKey": {
    "kid": "dev-key-1", // Required. Key ID surfaced in JWKS + JWT header.
    "alg": "RS256", // Default "RS256". Only RS256 supported today.
    "source": "generate", // Default "generate" (ephemeral) or "file:<path>" (persistent).
  },
  "clients": [
    // Required. One or more registered clients.
    {
      "clientId": "my-app", // What your app sends as `client_id`.
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

The canonical schema lives in [`src/config/schema.ts`](./src/config/schema.ts) — it validates every config file on load and on hot reload, so typos fail fast with a zod error pointing at the bad field.

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

---

## Endpoints

| Path                                    | Purpose                         |
| --------------------------------------- | ------------------------------- |
| `GET /.well-known/openid-configuration` | Discovery doc.                  |
| `GET /.well-known/jwks.json`            | Public keys.                    |
| `GET /authorize`                        | Renders the login page (tiles). |
| `POST /authorize/complete`              | Issues an auth code.            |
| `POST /token`                           | Code exchange + refresh.        |
| `GET` / `POST /logout`                  | Ends the session.               |
| `GET /admin`                            | Admin UI (profile CRUD).        |

All OIDC flows require **PKCE with S256**. No client secrets. No implicit flow.

CORS is permissive by default (`Access-Control-Allow-Origin` reflects the request's `Origin`) — browser-based OIDC clients can fetch the discovery doc, JWKS, and token endpoint without additional config.

---

## Admin UI

Visit `http://localhost:8080/admin` to:

- View all configured profiles.
- Add, edit, or delete profiles. Changes write atomically to the JSON config file on disk.
- View the full raw config.

The admin UI subscribes to a Server-Sent Events stream at `/admin/events`. When the JSON config file is edited externally (by another tool, another human, or a coding agent), a "Config changed on disk" banner appears so you can reload.

**No authentication on `/admin`** — the default `127.0.0.1` bind is the only protection. If you run dev-oidc somewhere network-reachable, put it behind a firewall, reverse-proxy auth, or a VPN. dev-oidc is a development tool, not a production service.

From the login page itself, a small "Manage profiles →" link jumps to `/admin` for quick iteration.

---

## Limitations

- **Development only.** Not suitable for production use under any circumstances.
- **Single tenant.** One issuer per instance.
- **No client authentication** at the token endpoint — trust is at the network layer.
- **Signing key rotates on every restart** unless `source: "file:<path>"` is set.
- **No authentication on `/admin`.**

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

## Contributing

Contributions welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, style, and commit conventions. Security issues: please read [SECURITY.md](./SECURITY.md) first.

## Releasing

Releases are cut locally with release-it, not from GitHub Actions.

```bash
npm run release
```

For the current alpha line:

```bash
npm run release:alpha
```

release-it runs typecheck, lint, formatting checks, and tests before selecting a version. After it bumps `package.json` and `package-lock.json`, it builds `dist`, verifies the npm package with `npm pack --dry-run`, commits, tags, pushes, and publishes to npm.

Use `npm run release:dry` to preview the release flow without writing changes or publishing.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT.
