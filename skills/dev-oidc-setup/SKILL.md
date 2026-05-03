---
name: dev-oidc-setup
description: Use this skill whenever the user wants to set up, configure, or edit dev-oidc — the local-development OIDC provider. Trigger on phrases like 'set up dev-oidc', 'wire dev-oidc into this app', 'use dev-oidc instead of Auth0/Entra/Keycloak/Okta locally', 'add a profile/user to dev-oidc', 'register a client', 'register this project with dev-oidc', 'add a tenant', 'edit dev-oidc.config.json', 'make signing key persist', 'switch to ES256 or oid claim', 'I need a fake/mock OIDC IdP for local dev' — dev-oidc is purpose-built for this, so use the skill even when the user only describes the symptom (e.g. 'I want to test login locally without hitting the real IdP'). Acts on the user's app repo, detects their existing OIDC integration, generates a matching dev-oidc.config.json, picks a run mode (Hub, Docker compose, or legacy CLI) based on what's already in the repo, and updates env vars or compose files so their auth code path runs unchanged.
---

# dev-oidc-setup

Wire `dev-oidc` into a developer's local environment, or edit an existing `dev-oidc.config.json`. Always work inside the **consumer app's** repo (the one that needs an OIDC provider) — not inside the dev-oidc repo itself. Read what's already there, mirror its OIDC settings, and add only what's needed so `docker compose up` (or the project's existing dev command) starts the app pointing at dev-oidc instead of the real IdP. The user's auth code path should not need to change — only configuration.

## What changed in v0.2 (read this first)

dev-oidc 0.2 introduced **Hub mode** as the default run mode. Three implications for any wire-up:

1. **`dev-oidc.config.json` no longer accepts `issuer`, `port`, or `host`.** The schema fails validation with a tailored error if any are present. Listener address and issuer URL are now CLI/Hub concerns.
2. **`dev-oidc start` (no flags) runs the Hub.** The Hub serves multiple project tenants concurrently from a registry at `~/.config/dev-oidc/hub.json`. Each tenant gets a URL slug derived from its directory name and routes are namespaced under `/<slug>/...`. Use `dev-oidc start --config <path>` for the prior single-tenant behavior.
3. **The Docker image still runs in legacy single-tenant mode.** Compose-based wire-ups continue to use the same single-tenant URLs (no slug); nothing changes there except dropping `issuer`/`host`/`port` from the config file.

If you encounter a `dev-oidc.config.json` from v0.1.x that has those three fields, removing them is part of any edit.

### v0.3 changes

1. **`server.tls`** is a new optional block in `hub.json` that enables HTTPS. Three valid auto-mkcert shapes (`{}` / `{ hostnames: [...] }`) plus BYO mode (`{ cert, key }`).
2. **Legacy CLI gains four flags**: `--tls`, `--tls-hostname` (repeatable), `--tls-cert`, `--tls-key`.
3. **URLs that consumers paste into MSAL / passport-azure-ad / oidc-client-ts config should be `https://...`** when TLS is enabled — typically `https://dev-oidc.localhost:8095` (with the SAN added to `/etc/hosts`) or `https://localhost:8095` (with `localhost` in the SAN list).
4. **Docker compose wire-ups should mount the host's mkcert state** so the container signs leaves with the user's already-trusted root: `${HOME}/.local/share/mkcert:/home/node/.local/share/mkcert:ro` (Linux/WSL) or `${HOME}/Library/Application Support/mkcert:/home/node/.local/share/mkcert:ro` (macOS).
5. **Project `dev-oidc.config.json` containing a top-level `tls` field fails Zod validation** with a tailored message pointing at `hub.server.tls`. Strip it as part of any v0.3 wire-up edit.

## Decision: wire-up or edit?

Before doing anything, look at the cwd:

- **No `dev-oidc.config.json` anywhere in the repo** → wire-up mode. Follow [Wire-up](#wire-up).
- **`dev-oidc.config.json` already exists** → edit mode. Read it first, then follow [Edit](#edit). Don't re-do wire-up; the user has invested in their config.
- **`dev-oidc.config.json` exists _and_ contains `issuer`, `host`, or `port`** → it's a v0.1.x leftover. Strip those three fields before anything else (they will fail schema validation), then proceed with the requested edit.

If unsure, ask. Don't blow away an existing config.

## Wire-up

Goal: a developer with a working OIDC integration against a real IdP can run their existing dev command and have their app's auth code path go through dev-oidc, with no app code changes.

### 1. Locate the app's existing OIDC settings

Grep the repo for any of the following. Pull out `clientId`, `audience` (called `apiIdentifier`, `resource`, or similar in some libraries), and at least one redirect URI.

| Stack / library                        | What to search for                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `oidc-client-ts`, `react-oidc-context` | `authority`, `client_id`, `redirect_uri`, `scope` keys in JS/TS                         |
| MSAL (`@azure/msal-*`)                 | `clientId`, `authority`, `redirectUri` inside an MSAL `Configuration` object            |
| Auth0 SDKs (`@auth0/*`)                | `domain`, `clientId`, `audience` in env or an `authConfig`                              |
| Passport `passport-openidconnect`      | `issuer`, `clientID`, `callbackURL`                                                     |
| Spring Security                        | `spring.security.oauth2.client.registration.*` and `provider.*` in `application.yml`    |
| ASP.NET Core                           | `Authentication:Schemes:OpenIdConnect` or `AzureAd` sections in `appsettings.json`      |
| Generic env vars                       | `OIDC_ISSUER`, `OIDC_AUTHORITY`, `OIDC_CLIENT_ID`, `OIDC_AUDIENCE`, `OIDC_REDIRECT_URI` |

If nothing turns up, ask the user for `clientId`, `audience`, and the redirect URI(s) to register.

Note which IdP they're currently using — it affects later choices:

- **Entra / Azure AD (MSAL)** → set `subjectClaim: "oid"` in dev-oidc so the JWT's `oid` claim carries the user's ID, matching what their backend expects. **Also**: MSAL refuses to talk to a non-Microsoft authority unless you set `protocolMode: 'OIDC'` and add the dev-oidc origin to `knownAuthorities`. Without those, MSAL throws `ClientAuthError: endpoints_resolution_error` at login. See [MSAL gotcha](#msal-gotcha-knownauthorities--protocolmode).
- **Auth0** → audiences are mandatory; make sure `audience` is set on the dev-oidc client entry.

### 2. Pick a run mode

Decide based on what's already in the repo. Don't introduce Docker into a project that's deliberately Docker-free, and don't add an npm dependency to a non-JS project.

| What's in the repo            | Recommended mode                          | URL shape                                                             |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `docker-compose.yml`          | **Compose** — add a `dev-oidc` service    | `http://localhost:8095` (no slug, single-tenant image)                |
| `Dockerfile` only, no compose | Bare `docker run` or a small compose file | `http://localhost:8095`                                               |
| `package.json`, no Docker     | **Hub** (default) or legacy CLI           | Hub: `http://localhost:8095/<slug>` · Legacy: `http://localhost:8095` |
| No JS toolchain, no Docker    | `docker run`                              | `http://localhost:8095`                                               |

When two paths are equally plausible, ask the user — the choice affects how the rest of the wire-up looks and whether the issuer URL has a slug.

Defaults to prefer when ambiguous:

- **Existing compose stack** → keep dev-oidc in compose. Adding a new service is one block in YAML; introducing Hub mode means asking the user to install something globally.
- **JS project, no Docker** → Hub mode. It's the v0.2 default and ergonomically simpler than `npx dev-oidc start --config ...` baked into a script. Fall back to legacy CLI if the user objects to a global install.

### 3. Generate `dev-oidc.config.json`

Write the file at the repo root using the [Config template](#config-template) below. Fill the template using the values discovered in step 1.

Field-by-field guidance for the wire-up case:

- `signingKey.kid` — any short string. `dev-key-1` is fine.
- `signingKey.source` — leave as `"generate"` for first wire-up. If the user already complains about re-login on every restart, set `"file:./.dev-oidc/signing-key.json"` (or `"file:/data/signing-key.json"` for Docker — see [Persist the signing key across restarts](#persist-the-signing-key-across-restarts)). Note: relative `file:` paths now resolve against the project config file's directory, not the process CWD.
- `subjectClaim` — `"oid"` for MSAL/Entra, `"sub"` (the default) otherwise.
- `clients` — one entry per client app (frontend). Use the `clientId`, redirect URI(s), and `audience` from step 1 verbatim. Redirect URIs are exact-match — copy strings byte-for-byte, no trailing-slash normalization.
- `profiles` — start with two or three sample users (`alice`, `bob`, optionally `admin`). One profile should carry an extra claim under `claims` to demonstrate the merge behavior (e.g. `{ "role": "admin" }`).

**Do not** add `issuer`, `port`, or `host` to the file. They were valid in v0.1.x but the v0.2 schema rejects them with errors pointing at the replacement (CLI flags or hub.json).

### 4. Wire the run mode into place

#### Compose

Append the [Compose service block](#compose-template) to the existing `docker-compose.yml`. If the user's API service should depend on dev-oidc being ready, add `depends_on: { dev-oidc: { condition: service_healthy } }` to that service. If they prefer to keep dev-only services out of the main `docker-compose.yml`, putting the `dev-oidc` block in `docker-compose.override.yml` (which Docker Compose merges automatically) is equally valid.

#### Hub mode

The user runs three commands once:

```bash
npm install -g dev-oidc                     # or: brew install / npx
dev-oidc register .                          # registers this project; slug derived from directory name
dev-oidc start                               # listens on 127.0.0.1:8095, watches hub.json
```

`dev-oidc register .` accepts either a project directory (and looks for `dev-oidc.config.json` inside) or a path to the JSON file directly. The slug defaults to a hyphenated form of the parent directory name. If that name would collide with a reserved slug (`admin`, `api`, `.well-known`, `_health`, `_internal`, `static`, or anything starting with `_`/`.`) or another registered tenant, pass `--slug <name>`. The slug must match `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`.

Other Hub commands worth knowing:

- `dev-oidc unregister <slug>` — remove a tenant. Required before changing `signingKey` or `refreshTokenTtlSeconds` (those are baked in at activation).
- `dev-oidc list` — print registered tenants with their slugs and computed issuer URLs.

The Hub watches `hub.json` (~200 ms debounce) — register/unregister take effect with no restart.

A typical `~/.config/dev-oidc/hub.json` looks like this (the `tls: {}` line is the v0.3+ opt-in for HTTPS):

```json
{
  "server": {
    "port": 8095,
    "host": "0.0.0.0",
    "publicUrl": "https://dev-oidc.localhost:8095",
    "tls": {}
  },
  "tenants": []
}
```

When you choose Hub mode, **edit a durable file** in the repo so the next contributor finds the commands. Append a "Local IdP" subsection to `README.md` (or `CONTRIBUTING.md`, or whatever local-dev doc the project already keeps) containing the three commands literally — `dev-oidc register …`, `dev-oidc start`, and the slug you chose. Hub mode has no `package.json` script and no compose service, so if you don't write the commands down, the only place they exist is your reply, which the user will lose. Treat this as part of the wire-up, not a "nice to have".

#### Legacy CLI (single project, no Docker, no Hub)

Install dev-oidc as a devDependency and add a script:

```jsonc
// package.json
{
  "scripts": {
    "dev:oidc": "dev-oidc start --config ./dev-oidc.config.json",
  },
  "devDependencies": {
    "dev-oidc": "^0.2.0",
  },
}
```

Optional flags: `--port <number>`, `--host <ip>`, `--public-url <url>`. `--public-url` replaces the v0.1 `issuer` config field — pass it whenever relying parties reach dev-oidc through a name other than the listen host.

TLS flags (v0.3+):

| Flag                    | Purpose                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `--tls`                 | Enable HTTPS with auto-mkcert. Implies same-port HTTP→HTTPS redirect.                  |
| `--tls-hostname <host>` | Append a SAN to auto-mkcert mode. Repeatable. Implies `--tls`.                         |
| `--tls-cert <path>`     | BYO cert file (absolute path; CWD-relative also accepted). Must pair with `--tls-key`. |
| `--tls-key <path>`      | BYO key file. Must pair with `--tls-cert`.                                             |

#### Bare Docker

```bash
docker run --rm -p 8095:8095 \
  -v "$(pwd)/dev-oidc.config.json:/config/config.json:ro" \
  camcima2/dev-oidc:latest
```

Document the command somewhere durable (project README's local-dev section, a `scripts/dev-oidc.sh`, etc.). Don't invent a new docs structure if one exists.

### 5. Update the app's dev environment variables

Locate the file the app reads OIDC config from in development. Common locations: `.env.local`, `.env.development`, `.env.example`, environment block in `docker-compose.yml`, or a `config/dev.json`-style file. Modify it (or create a sibling `*.example`) with values pointing at dev-oidc:

| App's config key          | Dev value (Compose / Docker / legacy CLI)                                   | Dev value (Hub mode)                                                 |
| ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `OIDC_ISSUER` / authority | `http://localhost:8095` (or `http://dev-oidc:8095` server-side — see below) | `http://localhost:8095/<slug>` (e.g. `http://localhost:8095/my-app`) |
| `OIDC_CLIENT_ID`          | matches `clients[].clientId` in dev-oidc config                             | matches `clients[].clientId` in dev-oidc config                      |
| `OIDC_AUDIENCE`           | matches `clients[].audience`                                                | matches `clients[].audience`                                         |
| Redirect URI              | matches `clients[].redirectUris[]` exactly                                  | matches `clients[].redirectUris[]` exactly                           |

When TLS is enabled (v0.3+), swap every `http://...` URL above for `https://...`. The recommended hostname is `https://dev-oidc.localhost:8095` (added to `/etc/hosts` as `127.0.0.1 dev-oidc.localhost`) or `https://localhost:8095` (provided `localhost` is in the SAN list). Examples:

- **passport-azure-ad** — `identityMetadata: 'https://dev-oidc.localhost:8095/.well-known/openid-configuration'` (without TLS: `http://localhost:8095/...`).
- **MSAL** — `authority: 'https://dev-oidc.localhost:8095'` and `knownAuthorities: ['dev-oidc.localhost:8095']` (without TLS: `http://localhost:8095` / `localhost:8095`).
- **oidc-client-ts** — `authority: 'https://dev-oidc.localhost:8095'` (without TLS: `http://localhost:8095`).
- **passport-openidconnect** — `issuer: 'https://dev-oidc.localhost:8095'` (without TLS: `http://localhost:8095`).

In Hub mode, every OIDC URL gains the `/<slug>/` prefix:

- Discovery (HTTP): `http://localhost:8095/<slug>/.well-known/openid-configuration`
- Discovery (HTTPS, v0.3+): `https://dev-oidc.localhost:8095/<slug>/.well-known/openid-configuration`
- Authorize: `http(s)://<host>:8095/<slug>/authorize`
- Token: `http(s)://<host>:8095/<slug>/token`
- JWKS: `http(s)://<host>:8095/<slug>/.well-known/jwks.json`
- Per-tenant admin: `http(s)://<host>:8095/admin/<slug>`

In legacy / Docker (compose) mode, drop the `/<slug>/` segment everywhere — the URLs match v0.1 exactly.

Don't overwrite production values. If the existing file holds prod values directly, prefer creating a `.env.development` (or `.env.local`) override and leave the prod file alone. `docker-compose.override.yml` is a fine place to repoint env vars in a compose stack.

### 6. Hand off

Print a short, copy-pasteable closer:

1. Start dev-oidc (the exact command for the run mode you set up).
2. Start the app the way the user already does (don't reinvent the dev command).
3. Sign in: visit the app's login route → click an `alice` / `bob` tile on dev-oidc's page → land back in the app authenticated.

Don't run anything yourself unless the user asks. The user is in control of their toolchain.

## Edit

The user wants to change something in an existing `dev-oidc.config.json`. Read the file first; the whole file is small enough to hold in context. If it carries `issuer`, `host`, or `port` (v0.1 leftovers), strip them as part of the edit — the v0.2 schema rejects them. Make the requested change in place. Common edits are listed in [Edit recipes](#edit-recipes).

After any edit, mention hot-reload behavior: `clients`, `profiles`, `branding`, `subjectClaim`, and `tokenTtlSeconds` reload live. Edits to `signingKey` (kid/alg/source) and `refreshTokenTtlSeconds` require a restart in legacy mode, or `dev-oidc unregister <slug> && dev-oidc register <path>` in Hub mode — they are baked into per-tenant key material and the refresh-token store at activation time.

Note: bind-mounted files in Docker Desktop on macOS / WSL2 sometimes miss the watch event, in which case `docker compose restart dev-oidc` is the simplest workaround. Mention this only if the user is on Docker.

## Config template

Use this as the canonical starting point. Strip any fields that aren't needed; the schema fills in defaults. The full schema is in `src/config/schema.ts` of the dev-oidc repo, validated on every load.

```jsonc
{
  "signingKey": {
    "kid": "dev-key-1",
    "alg": "RS256", // Or "ES256".
    "source": "generate", // Or "file:./.dev-oidc/signing-key.json"
    // (or "file:/data/signing-key.json" for Docker).
  },
  "subjectClaim": "sub", // "oid" for Entra/MSAL.
  "tokenTtlSeconds": 900,
  "refreshTokenTtlSeconds": 28800,
  "clients": [
    {
      "clientId": "<from app config>",
      "redirectUris": ["<from app config — exact match, no trailing-slash tolerance>"],
      "audience": "<from app config>",
    },
  ],
  "profiles": [
    { "id": "alice", "displayName": "Alice Developer", "email": "alice@example.com" },
    {
      "id": "bob",
      "displayName": "Bob Manager",
      "email": "bob@example.com",
      "claims": { "role": "admin" },
    },
  ],
}
```

> **Do not** include `issuer`, `port`, or `host`. v0.2 rejects all three with tailored errors. The Hub computes the issuer from `publicUrl + slug`; legacy mode takes `--public-url`/`--port`/`--host` flags.

Reserved JWT claim names that `profile.claims` cannot override: `sub`, `name`, `email`, `iat`, `exp`, `iss`, `aud`, `nonce`. Anything else gets merged into the JWT verbatim.

## Compose template

Append this service to an existing `docker-compose.yml` (or place it in `docker-compose.override.yml` if the project keeps dev-only services there). The healthcheck deliberately uses `127.0.0.1` — Alpine resolves `localhost` to IPv6 first and Node's Fastify binds IPv4-only when `host: "0.0.0.0"`, so a `localhost` healthcheck fails intermittently inside the container.

```yaml
services:
  dev-oidc:
    image: camcima2/dev-oidc:latest
    volumes:
      - ./dev-oidc.config.json:/config/config.json:ro
      # - dev-oidc-data:/data        # Uncomment if signingKey.source is "file:/data/..."
    ports:
      - '8095:8095'
    healthcheck:
      test:
        - CMD-SHELL
        - 'wget -q -O- http://127.0.0.1:8095/.well-known/openid-configuration > /dev/null || exit 1'
      interval: 5s
      timeout: 2s
      retries: 10

  # If your-api should wait for dev-oidc to be ready before starting:
  # your-api:
  #   depends_on:
  #     dev-oidc:
  #       condition: service_healthy
  #   environment:
  #     OIDC_ISSUER: http://dev-oidc:8095   # Server-side; browsers must use http://localhost:8095.

# volumes:
#   dev-oidc-data:                          # Pair with the commented `/data` mount above.
```

The image already passes `--host 0.0.0.0` in its default `CMD`, so the published port is reachable from the host without any flag in the compose file. If relying parties reach dev-oidc by a name other than `localhost` (e.g. `dev-oidc` on the compose network), set `command: ["start", "--config", "/config/config.json", "--public-url", "http://dev-oidc:8095"]` so discovery and JWT `iss` reflect that URL.

### With TLS (recommended for v0.3+)

Same shape as above, but mount the host's mkcert state and pass `--tls`. Browsers trust the leaves automatically because the leaf is signed by the user's already-installed mkcert root.

```yaml
services:
  dev-oidc:
    image: ghcr.io/camcima/dev-oidc:0.3.0
    ports:
      - '8095:8095'
    volumes:
      - ./dev-oidc.config.json:/config/config.json:ro
      - ./hub.json:/config/hub.json:ro
      - dev-oidc-data:/data
      # Linux/WSL:
      - ${HOME}/.local/share/mkcert:/home/node/.local/share/mkcert:ro
      # macOS: replace the line above with:
      # - ${HOME}/Library/Application Support/mkcert:/home/node/.local/share/mkcert:ro
    healthcheck:
      test:
        - CMD-SHELL
        - 'wget --no-check-certificate -q -O- https://127.0.0.1:8095/.well-known/openid-configuration > /dev/null || exit 1'
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  dev-oidc-data:
```

For Hub mode set `tls: { hostnames: ["dev-oidc.localhost", "localhost"] }` in `hub.json`. For legacy mode pass `--tls` (auto-mkcert) or `--tls-cert ./certs/cert.pem --tls-key ./certs/key.pem` (BYO) in the container `command`. Add `127.0.0.1 dev-oidc.localhost` to `/etc/hosts` so the SAN resolves locally.

## Edit recipes

### Add a profile (test user / login tile)

```jsonc
{
  "profiles": [
    // existing profiles...,
    {
      "id": "charlie", // Goes into `sub` (and `oid`, if subjectClaim is "oid").
      "displayName": "Charlie Tester",
      "email": "charlie@example.com",
      "claims": {
        "department": "QA",
        "role": "tester",
      },
    },
  ],
}
```

### Register a new client

```jsonc
{
  "clients": [
    // existing clients...,
    {
      "clientId": "second-frontend",
      "redirectUris": ["http://localhost:5174/auth/callback"],
      "audience": "second-api",
    },
  ],
}
```

### Make a client confidential

```jsonc
{
  "clients": [
    {
      "clientId": "confidential-app",
      "clientSecret": "<generated-strong-string>", // Mention: keep out of version control.
      "redirectUris": ["http://localhost:5173/auth/callback"],
      "audience": "my-api",
    },
  ],
}
```

dev-oidc accepts both `client_secret_post` (form field on `/token`) and `client_secret_basic` (HTTP Basic). Either is fine; use whichever the app's HTTP client emits.

### Persist the signing key across restarts

```jsonc
{
  "signingKey": {
    "kid": "dev-key-1",
    "alg": "RS256",
    "source": "file:./.dev-oidc/signing-key.json", // Relative paths resolve against the
    // config file's directory in v0.2.
  },
}
```

For Docker, prefer an absolute path under a writable mount: `"file:/data/signing-key.json"`, paired with a `dev-oidc-data:/data` volume. dev-oidc generates the keypair with `0600` perms on first boot and reuses it after that. To rotate, delete the file or change `kid` (a `kid` mismatch fails to load — forcing a clean regeneration).

In Hub mode, after editing `signingKey`, run `dev-oidc unregister <slug> && dev-oidc register <path>` so the new key takes effect (signing key isn't hot-reloaded).

### Switch to ES256 signing

```jsonc
{
  "signingKey": { "kid": "k1", "alg": "ES256", "source": "generate" },
}
```

If the user has a persisted RS256 key file, ES256 will refuse to load it — they need to delete the file (or point `source` somewhere fresh) when switching algorithms.

### Switch to Entra-style subject claim

```jsonc
{ "subjectClaim": "oid" }
```

The profile's `id` still lands in `sub`; this just _adds_ an `oid` alias so backends that key off `oid` (the Entra/Azure AD convention) work.

### Programmatic API (e.g. in a Vitest `globalSetup`)

```ts
import { createDevOidcServer, loadConfig } from 'dev-oidc';
// import { readFileSync } from 'node:fs';

const config = await loadConfig('./dev-oidc.config.json');
const server = await createDevOidcServer({
  config,
  listenHost: '127.0.0.1',
  listenPort: 8095,
  // issuer: 'http://localhost:8095',   // Optional. Derived from listenHost/listenPort if omitted.
  // tls: {                              // v0.3+: enable HTTPS via @httptoolkit/httpolyglot multiplex.
  //   cert: readFileSync('./certs/cert.pem'),
  //   key:  readFileSync('./certs/key.pem'),
  // },
});
await server.app.listen({ port: 8095, host: '127.0.0.1' });
```

`createDevOidcServer` is now an `await`able factory taking `CreateServerOptions` (single argument). Code from v0.1.x that called `createDevOidcServer(config)` directly must switch to `createDevOidcServer({ config })`.

## Things to get right

- **Exact-match redirect URIs.** No trailing-slash tolerance, no path normalization. `http://localhost:5173/cb` and `http://localhost:5173/cb/` are different to dev-oidc. If the app currently sends one form, that exact form must be in `clients[].redirectUris`.
- **Scope must include `openid`.** dev-oidc rejects authorize requests without it (`400 invalid_scope`). If the app sends a custom scope list, keep `openid` in there.
- **Refresh tokens rotate on every use.** The token returned by `/token` becomes invalid as soon as the next `/token` call returns a fresh one. If the app caches a single refresh token forever, it must capture and store the new `refresh_token` from each `/token` response. Mention this only if the user's app is doing manual token caching.
- **Signing key rotates on every restart by default.** The `source: "generate"` default creates a fresh keypair at boot — fine for one-shot tests, disruptive during interactive dev because every restart invalidates JWTs in browser storage and breaks the API's cached JWKS until it refetches. Recommend `source: "file:..."` whenever the user complains about random 401s after restarts.
- **No auth on `/admin`.** The default `127.0.0.1` bind is the only protection. Flag this if the user expresses any intent to expose dev-oidc beyond loopback. dev-oidc is a development tool, not a production service.
- **No `issuer`/`port`/`host` in project config.** v0.2 rejects them. If the user pastes a v0.1 config snippet, drop those three lines before saving.
- **`tls` at the top level of project `dev-oidc.config.json`** — v0.3 rejects this with a Zod error pointing at `hub.server.tls`. Strip it; if the project genuinely needs TLS, it belongs in `hub.json` (or via legacy `--tls*` flags), never in the project config.

## MSAL gotcha: `knownAuthorities` + `protocolMode`

MSAL (`@azure/msal-browser`, `@azure/msal-node`) is built around Microsoft's authority shape (`https://login.microsoftonline.com/<tenant>`). Pointing it at any non-Microsoft authority — including dev-oidc — requires two extra fields on the `Configuration` object, **otherwise MSAL throws `ClientAuthError: endpoints_resolution_error` on the first login attempt**:

```ts
const msalConfig: Configuration = {
  auth: {
    clientId: import.meta.env.VITE_AZURE_CLIENT_ID,
    authority: import.meta.env.VITE_AZURE_AUTHORITY, // e.g. http://localhost:8095/<slug> (Hub) or http://localhost:8095 (Legacy)
    knownAuthorities: ['localhost:8095'], // host:port — required for non-Microsoft authorities
    protocolMode: 'OIDC', // tells MSAL to use generic OIDC discovery, not AAD
    redirectUri: import.meta.env.VITE_AZURE_REDIRECT_URI,
  },
  // cache, system, etc.
};
```

The user's authority value still comes from env so production paths point at Entra unchanged — but `knownAuthorities` and `protocolMode` are unconditional in the source. Edit the MSAL config file when wiring an MSAL app at dev-oidc; this is one of the few cases where the wire-up legitimately requires touching application code.

## The browser-vs-server URL split

This is the most common gotcha when wiring dev-oidc into a compose-based stack and worth getting right on the first pass.

Inside a Docker network, container-to-container traffic resolves service names: an API container can reach dev-oidc at `http://dev-oidc:8095`. **Browsers cannot do that** — the user's browser has no idea what `dev-oidc` resolves to and must use `http://localhost:8095` (the host port mapping).

Two consequences:

1. **Pick one issuer URL.** The JWT `iss` claim and the `/.well-known/openid-configuration` document must match the URL the JWT recipient validates against. By default the Docker image advertises `http://localhost:8095` — fine for almost everyone. If your API container reaches dev-oidc by service name and validates `iss`, pass `--public-url http://dev-oidc:8095` in the compose `command:` (and use `http://dev-oidc:8095` consistently from servers; browsers still use `http://localhost:8095` because of port mapping).
2. **The discovery doc reflects `publicUrl`/`issuer`.** Whatever you advertise as the issuer is the URL relying parties will use to fetch JWKS. Stay consistent: pick one and use it everywhere on a given side (browser side or server side).

When in doubt: **leave `--public-url` unset and use `localhost:8095` everywhere**. It's the path with the fewest sharp edges.
