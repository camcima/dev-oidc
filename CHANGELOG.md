# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`client_credentials` grant.** Confidential clients (those with a `clientSecret`) can now request a machine-to-machine access token. Per RFC 6749 §4.4.3 the response carries no `id_token` and no `refresh_token`, `openid` is not required, and `allowedScopes` is enforced. The token's `sub` and `client_id` are the client id.
- **`clients[].requirePkce`.** Overrides whether `/authorize` demands PKCE for that client.
- Discovery now advertises `response_modes_supported` (`["query"]`) and lists `client_credentials` in `grant_types_supported`.
- The admin profile editor now exposes every optional profile field (`givenName`, `familyName`, `avatar`, `locale`, `hostedDomain`, `emailVerified`); leaving one blank clears it.

### Changed (BREAKING)

- **Authorization errors now redirect instead of returning JSON.** Once `client_id` and `redirect_uri` are validated, `/authorize` failures (`unsupported_response_type`, `invalid_scope`, missing/invalid PKCE parameters) are delivered by redirecting to the registered `redirect_uri` with `error`, `error_description` and `state`, per RFC 6749 §4.1.2.1. Previously these returned `400` with a JSON body, so a relying party's error-callback path was never exercised against dev-oidc and browser users saw a raw JSON object. An unknown `client_id` or unregistered `redirect_uri` still returns `400`.
- **PKCE is no longer required of confidential clients.** Public clients must still send `code_challenge`; clients with a `clientSecret` may omit it, matching Entra and Auth0. A supplied `code_challenge` is always verified. Use `requirePkce` to restore the old behaviour per client.
- **A failed authorization-code exchange now revokes the code.** A wrong `code_verifier`, `redirect_uri` or `client_id` burns the code, as the RFC directs and production IdPs do; previously a retry could succeed in dev while the same client failed in production. Refresh tokens deliberately keep the lenient behaviour — single-use rotation already defeats replay.
- **`prompt=none` answers `error=login_required`.** dev-oidc keeps no session, so it previously rendered a login page into silent-renew iframes, which hung until the relying party timed out.
- **CORS is limited to local development origins.** Previously any `Origin` was reflected, which let an arbitrary website drive a full authorization flow against a developer's machine and read the resulting tokens. Now allowed: loopback origins (`localhost`, `127.0.0.0/8`, `*.localhost`), every origin already present in a client's `redirectUris`/`postLogoutRedirectUris`, and the advertised public URL. Requests without an `Origin` header are unaffected.
- **`hub.json` rejects unknown keys.** A misspelling such as `pubicUrl` was previously dropped in silence. Keys beginning with `//` are still accepted as comments — and are now preserved when the CLI rewrites the file.
- **The HTTP→HTTPS redirect uses 308 instead of 301.** 301 permits clients to rewrite `POST` to `GET`, which silently turned a misconfigured `POST /token` into a `GET`.
- **`dev-oidc start --port 0` is rejected.** It bound an ephemeral port while advertising an issuer of `:0`.
- **`package.json` `main` points at `dist/index.cjs`.** It previously pointed at the ESM build, so a `require()` that ignores `exports` loaded ESM and threw.

### Fixed

- **The admin UI no longer destroys profile fields it does not display.** `PUT /admin/api/profiles/:id` treated the body as a full replacement while the edit dialog submitted only `id`/`displayName`/`email`/`claims`, so saving any edit silently deleted `givenName`, `familyName`, `avatar`, `locale`, `hostedDomain` and `emailVerified` from the config file. The endpoint is now a merge: an absent field is left alone and an explicit `null` clears it.
- **RP-initiated logout echoes `state`**, and `POST /logout` reads form-encoded parameters. `oidc-client-ts`'s `signoutRedirectCallback()` validates `state` and previously failed against dev-oidc.
- **`refreshTokenTtlSeconds` is applied when a refresh token is issued.** It was captured at startup, so editing it looked like a hot reload but had no effect until restart.
- **A tenant config reload emits one `config-changed` event, not two**, and a rewrite that leaves the content unchanged emits none.
- **Basic-auth client credentials are form-urldecoded** per RFC 6749 §2.3.1. Both encoded and raw forms are accepted, so secrets containing reserved characters work with any client.
- **Client secrets are redacted** from `GET /admin/api/config` and the admin page's raw-config dump.

### Internal

- Extracted the server wiring shared by legacy and hub mode (`createBaseApp`, `buildTenantDiscovery`), removing byte-identical duplication between `src/server.ts` and `src/hub/server.ts`.
- Removed the stale `ActiveTenantState.config` snapshot, moved path helpers to `src/shared/paths.ts` so the hub server no longer imports from the CLI layer, unified two hand-rolled promise mutexes, and replaced a sentinel-string error protocol with a typed error.
- `/userinfo` no longer re-imports the signing JWK on every request.

## [0.5.0] - 2026-07-14

### Added

- **Opt-in per-client `allowedScopes`.** Set `clients[].allowedScopes` on a client to restrict which scopes it may request; `/authorize` requests containing a scope outside the allowlist are rejected with `400 invalid_scope` (`openid` is always implicitly allowed). Clients that omit the field keep the existing passthrough behavior — any requested scope is signed into the token unchanged.
- **`branding.logoUrl` is rendered on the login page.** The field was already accepted by config but previously had no effect on the rendered page.
- **Hub login pages link to the tenant's own admin page.** The "Manage profiles →" link on a tenant's `/authorize` page now points at `/admin/<slug>` instead of the shared hub dashboard.

### Changed (BREAKING)

- **Config validation is stricter; previously-loading configs can now fail at startup.** `dev-oidc.config.json` (and `hub.json`) now reject several shapes that used to load silently:
  - Duplicate `clients[].clientId` values, duplicate `profiles[].id` values, and duplicate URIs within a single client's `redirectUris`/`postLogoutRedirectUris` are rejected — previously a duplicate silently shadowed later entries wherever handlers looked clients/profiles up by id.
  - `subjectClaim` must be a simple identifier (letters, digits, underscore; not starting with a digit) and must not be a reserved JWT/OIDC claim name other than `sub`.
  - `redirectUris`, `postLogoutRedirectUris`, `branding.logoUrl`, `profiles[].avatar`, and hub's `server.publicUrl` must be http(s) URLs with no embedded credentials and no fragment. **Custom native-app redirect schemes are no longer accepted as redirect URIs** — e.g. `com.example.app://callback` (RFC 8252-style) now fails validation; only `http://`/`https://` redirect URIs are allowed.
  - A hub config (`hub.json`) that registers the same `configPath` under two different slugs is rejected.
  - **Migration:** dedupe any repeated client/profile ids or redirect URIs, fix any `subjectClaim` that collides with a reserved claim, replace native-app redirect URIs with an `http(s)` loopback/callback URL, and give each hub tenant its own config file.

### Fixed

- **Invalid token exchanges no longer consume the authorization code or refresh token.** A `/token` request with a mismatched `client_id`, PKCE verifier, or `redirect_uri` previously still removed the authorization code (or, on refresh, the refresh token) from the store before validating the binding, burning it for the legitimate client's retry. Bindings are now checked before the entry is consumed.
- **Concurrent admin profile edits no longer lose updates.** Two overlapping admin CRUD requests against the same config file could both read the same pre-edit snapshot and race past each other on write, silently dropping one edit; all writers also shared a single fixed temp filename. Writes are now serialized per config path, and each writer gets a unique temp file.
- **The legacy landing page reflects hot-reloaded branding.** `GET /` rendered the `branding` captured at startup, so edits made via file watch or the admin API were invisible on the landing page until restart. It now reads the live runtime config.
- **Persisted signing-key files are written atomically, and their `publicJwk` is verified against `privateJwk` on load.** Key files now go through a unique temp file + rename instead of a direct write, so a crash mid-write can't leave a truncated file. On load, dev-oidc also confirms the public key's components (`n`/`e` for RSA, `crv`/`x`/`y` for EC) match the private key, catching a corrupted or hand-edited public half before JWKS serves a key that can't verify issued tokens.
- **README Docker snippets pin the released `0.4.1` image** (previously referenced `0.4.0`).
- **`/token` requires `redirect_uri` on the authorization-code grant.** Per RFC 6749 §4.1.3 the value sent at `/authorize` must be repeated at `/token`; the handler previously only compared it when supplied, so an exchange omitting it still issued tokens. It is now required (`invalid_request`) and compared unconditionally (`invalid_grant`), matching real OIDC providers and surfacing relying-party bugs.
- **Auth-state stores are bounded.** Authorization codes, refresh tokens, and pending-login records lived in unbounded maps that only shed entries on consume, so expired-but-never-presented entries leaked for the life of a hub. Each insert now sweeps expired entries and enforces a max-entry cap (oldest evicted).
- **Active `/admin/events` SSE streams no longer block shutdown.** Open Server-Sent-Events responses were never closed on shutdown, so `app.close()` (SIGINT/SIGTERM) hung while an admin page was open. They are now ended via a `preClose` hook (which runs _before_ Fastify waits on in-flight requests — an `onClose` hook is too late, since the open stream is the request being waited on). The handshake headers are also flushed immediately so the client connects right away.
- **IPv6 loopback issuer URLs are well-formed.** Binding `--host ::1` without `--public-url` produced `http://::1:8095`; bare IPv6 hosts are now bracketed (`http://[::1]:8095`).
- **Admin URLs percent-encode profile ids.** Profile ids are unconstrained strings but were interpolated raw into edit/delete paths, so a `/`, `?`, or `#` broke the URL. Ids are now encoded as a single path segment.

### Security

- **Docker build verifies the mkcert download.** The pinned `mkcert` binary is now checked against a per-arch SHA256 before use, so a tampered or swapped release asset fails the build.

### Changed

- **Releases fail fast without `GITHUB_TOKEN`.** With `github.release` enabled, release-it silently falls back to a no-op web release when the token is absent (publishing to npm and pushing the tag but creating no GitHub Release). A `before:init` preflight now hard-stops the release if `GITHUB_TOKEN` is unset; dry runs are unaffected.
- **The Docker image publishes automatically on tag push.** `release-docker` now triggers on any pushed `v*` tag (in addition to the manual `workflow_dispatch`), so cutting a release no longer needs a separate manual run to ship the GHCR image. Stable tags also move `:latest`; prerelease tags (`v*-…`) publish their version only.

## [0.4.0] - 2026-05-24

### Added

- `/userinfo` endpoint (`GET`/`POST`), advertised via `userinfo_endpoint` in discovery, plus `claims_supported`.
- First-class profile fields mapping to standard OIDC claims: `givenName`, `familyName`, `locale`, `hostedDomain`, `emailVerified`; `avatar` now also surfaces as the `picture` claim.
- ID-token claims `azp`, `at_hash`, and `auth_time` (stable across refresh).
- `examples/google.config.json` and a README "Emulating Google" section.

### Changed (BREAKING)

- Identity claims (`name`, `email`, `given_name`, …) are now **scope-gated** (`profile`/`email`) and emitted in the **ID token and `/userinfo` only** — they are no longer in the access token. Custom `profile.claims` are unaffected and remain in every token.
  - **Migration:** read identity claims from the ID token or `/userinfo`, and make sure your app requests the `profile`/`email` scopes.

### Changed

- Refreshed in-range dependencies (lockfile only).

## [0.3.1] - 2026-05-03

### Fixed

- **Default Docker container starts out of the box again.** 0.3.0 bound to `0.0.0.0` by default but did not set a publicUrl, tripping the bind-all safety guard and refusing to start. The image now ships `ENV DEV_OIDC_PUBLIC_URL=http://localhost:8095` (override at runtime when needed) and `ENV XDG_CACHE_HOME=/data` so the auto-mkcert leaf cache persists alongside the signing key. The CLI also falls back to `DEV_OIDC_PUBLIC_URL` when `--public-url` is omitted.
- **Hub mode derives `https://` issuers when TLS is enabled.** Previously, a hub config with `server.tls` set but `server.publicUrl` omitted produced an `http://` issuer, which relying parties would reject as a scheme mismatch. The default now follows TLS state. Hub mode also no longer reads the legacy-mode `DEV_OIDC_PUBLIC_URL` env var — that default is for the published Docker image's _legacy_ CMD, and leaking it into hub mode would have re-introduced the `http://` issuer regression for HTTPS hub listeners. Hub operators set `server.publicUrl` in `hub.json` instead.
- **HTTPS redirect target is allowlisted.** The HTTP→HTTPS `onRequest` hook validated nothing before echoing `req.host` into the `Location` header. A forged `Host: evil.example.com` would bounce clients off-site (open-redirect-shaped). The redirect now only echoes hosts matching the configured publicUrl or listen host:port; other hosts fall back to a value dev-oidc owns.
- **Hub watcher warns on any `server.*` change.** Previously only TLS section changes surfaced; tweaking `host`, `port`, or `publicUrl` looked silently applied even though none take effect without a restart.
- **`PUT /admin/api/profiles/:id` rejects rename collisions.** When `body.id` differed from the URL `:id` and matched another existing profile, the write produced two profiles with identical ids. Now returns `409 Conflict` with the same error shape `POST` emits.
- **TLS cert/key paths support `~/`.** docs claimed tilde expansion worked; Node's `fs` does not interpret tildes, so `~/certs/dev-oidc.pem` failed with ENOENT. Both CLI flags and `hub.json` paths now expand `~/` to `os.homedir()` before resolution.
- **Discriminated TLS error taxonomy.** `findMkcert` previously collapsed "binary missing" and "CAROOT not initialized" into a single `null` return, mapping both to `MKCERT_NOT_FOUND`. Now returns a discriminated result so the loader emits `MKCERT_NOT_FOUND` vs. `CAROOT_NOT_INITIALIZED` (with the resolved CAROOT in the message) vs. `INVALID_HOSTNAMES` for empty hostname arrays.

### Changed

- Standardized Docker image references in README, `docs/tls.md`, and the `dev-oidc-setup` skill on `ghcr.io/camcima/dev-oidc:0.3.1` (the version that ships these fixes). Earlier snippets pointed at a non-existent `camcima2/dev-oidc:latest` tag on Docker Hub.
- Replaced relative documentation links in `README.md` with absolute `github.com/camcima/dev-oidc/...` URLs so they keep working when the README is rendered on npmjs.com (the npm tarball only ships `dist/`, `README.md`, and `LICENSE`).

### CI

- The `docker` job now `docker run`s the built image and probes `/.well-known/openid-configuration` — catches "image refuses to start out of the box" regressions before publish.
- `vitest` `testTimeout` raised from the 5s default to 15s. The CLI suite resets its module cache and re-imports the entire server graph per test; under full-suite load that occasionally exceeded 5s on cold cache.

## [0.3.0] - 2026-05-03

### Added

- **Native TLS support.** Set `server.tls` in `hub.json` (auto-mkcert mode: `{}` or `{ hostnames: [...] }`; BYO mode: `{ cert, key }`) or pass `--tls` / `--tls-cert` / `--tls-key` / `--tls-hostname` in legacy CLI mode. dev-oidc auto-provisions leaves from your mkcert root CA and caches them under `${XDG_CACHE_HOME:-~/.cache}/dev-oidc/certs/` (native) or `/data/certs/` (Docker).
- **Same-port HTTP→HTTPS redirect.** When TLS is enabled, plain HTTP requests on the configured port get a `301 Moved Permanently` to `https://`. Multiplexing via [`@httptoolkit/httpolyglot`](https://github.com/httptoolkit/httpolyglot).
- **Docker image bundles `mkcert`.** The runtime stage now installs `mkcert` (~5MB). Mount your host's mkcert CAROOT into `/home/node/.local/share/mkcert` to share trust.
- `docs/tls.md` — feature reference with per-OS install commands, Docker compose patterns, BYO guidance, and troubleshooting.
- `release-docker.yml` workflow that builds a multi-arch (`linux/amd64`, `linux/arm64`) image from a `v*` tag and pushes it to `ghcr.io/camcima/dev-oidc`. Triggered manually via `workflow_dispatch` so npm and Docker publish paths are independent.
- `release:docker` and `release:all` npm scripts. `release:docker` dispatches the workflow for the current `package.json` version; `release:all` chains `release` (npm) and `release:docker`.

### Changed

None for v0.2.x consumers. Configs without a `tls` block keep their HTTP listener as today.

### Programmatic API

- New optional `tls?: { cert: Buffer; key: Buffer }` on `CreateServerOptions`. When set, dev-oidc wires Fastify's `serverFactory` through `@httptoolkit/httpolyglot` and adds an `onRequest` redirect hook.
- `deriveIssuer()` defaults to `https://` when `tls` is set.

### Hot-reload scope

TLS material is loaded once at startup. Editing `hub.json`'s `tls` block, regenerating the certs on disk, or changing the user's mkcert root all require a process restart. dev-oidc logs a WARN when it sees a `tls` change in `hub.json`.

### New dependency

- `@httptoolkit/httpolyglot` — the maintained fork of `httpolyglot` by HTTP Toolkit. ~80 LOC, MIT, no transitive deps. Provides the same-port HTTP/HTTPS multiplex.

## [0.2.0] - 2026-04-25

### Added

- **Hub mode**: a single dev-oidc process serves multiple OIDC tenants concurrently, each backed by its own project-local `dev-oidc.config.json`. Registry lives at `~/.config/dev-oidc/hub.json`.
- New CLI commands: `dev-oidc register <project-dir-or-config-path>`, `dev-oidc unregister <slug>`, `dev-oidc list`. `register` accepts either a path to `dev-oidc.config.json` or a project directory containing it.
- Hub dashboard at `/admin` lists all registered tenants and links to per-tenant management UIs.
- `--port`, `--host`, `--public-url` flags for legacy single-tenant mode.
- Cross-tenant isolation: signing keys, authorization codes, refresh tokens, and pending auth records are strictly scoped per tenant.

### Changed (BREAKING)

- `dev-oidc start` now defaults to Hub mode. Use `dev-oidc start --config <path>` for the prior single-tenant behavior.
- Project schema (`dev-oidc.config.json`) no longer accepts `issuer`, `port`, or `host`. Configs that include these fields fail validation with a tailored error pointing at the replacement.
- Relative `signingKey.source` paths now resolve against the project config file's directory rather than the process CWD.
- Docker image's default `CMD` now passes `--host 0.0.0.0` so the published container port is reachable from the host. Pre-0.2 images relied on the project config's `host` field, which the new schema rejects.

### Programmatic API

- `createDevOidcServer` is now an `await`able factory that takes `CreateServerOptions`. Existing single-arg `createDevOidcServer(config)` callers must switch to `createDevOidcServer({ config })`.
- `issuer` on `CreateServerOptions` is **optional**. When omitted, the server derives it from `publicUrl` if present, otherwise from `http://${listenHost}:${listenPort}` (defaults `127.0.0.1`/`8095`). Pass an explicit `issuer` for setups where the URL relying parties use to fetch discovery differs from the listen address.
- New optional `listenHost` and `listenPort` fields on `CreateServerOptions` (defaults `127.0.0.1`/`8095`); used to build the admin guard's Host-header allowlist and the default issuer.

### Hot-reload scope

`clients`/`profiles`/`branding`/`subjectClaim`/`tokenTtlSeconds` reload live on disk edits or admin writes. Changes to `signingKey` or `refreshTokenTtlSeconds` require a process restart (legacy mode) or `unregister`+`register` (Hub mode); they are baked into per-tenant key material and the refresh-token store at activation time.

### Migration from v0.1.x

- **If you run `dev-oidc start --config ./config.json`**: pass `--port`, `--host`, or `--public-url` if you previously relied on those values from the project config. Otherwise no change.
- **If you used Docker**: re-pull `:latest` (or pin to `:0.2.0+`); the entrypoint now binds to `0.0.0.0` automatically. If your config previously included `"host"`/`"port"`, remove those fields — the schema now rejects them. If RPs reach the container by a non-`localhost` name, pass `-e DEV_OIDC_PUBLIC_URL=...` and `--public-url` accordingly.
- **If you called `createDevOidcServer` programmatically**: drop any explicit `issuer` to use the new derivation, or keep your existing value if you need a specific one. Tests that pass `issuer` continue to work unchanged.
- **If you used absolute `signingKey.source`**: no change.
- **If you used a relative `signingKey.source` from a non-project CWD**: move to an absolute path or run from the project root.

## [0.1.0] — 2026-04-25

### Breaking

- `scope` is now propagated end-to-end. The `/token` response `scope` field reflects the granted scope rather than the previously-hardcoded `"openid profile email"`. Apps that asserted on the old hardcoded value need updates.
- `/authorize` rejects requests whose `scope` does not include `openid` with `400 invalid_scope`.
- Refresh tokens are single-use; reuse returns `400 invalid_grant`. Apps must capture each new `refresh_token` from `/token` responses.
- `/logout` without a `post_logout_redirect_uri` returns a 200 HTML confirmation page instead of redirecting to `/`.

### Added

- `GET /` landing page with discovery, JWKS, and admin links.
- Optional `clientSecret` on clients; supports both `client_secret_post` and `client_secret_basic` (with `WWW-Authenticate: Basic realm="dev-oidc"` on 401 responses).
- `ES256` signing algorithm; configurable via `signingKey.alg`.
- Access tokens carry a `scope` claim.

### Changed

- JWKS document is built once at startup rather than rebuilt per request.
- Identical config updates from the file watcher and admin writes are deduplicated (no more double `config-changed` SSE events).
- The login and admin pages render via a tagged-template renderer; React is no longer a dependency.
- `DevOidcLogger` type is `FastifyBaseLogger`; the previous `as unknown as FastifyInstance` cast is gone.

## 0.1.0-alpha.2 - 2026-04-25

### Added

- Permissive CORS on all endpoints so browser-based OIDC clients (`oidc-client-ts`, MSAL.js, etc.) can fetch the discovery doc, JWKS, and token endpoint cross-origin without additional config.
- File-backed signing key (`signingKey.source: "file:<path>"`). Persists the RSA keypair across restarts so JWTs minted before the restart remain verifiable against the same public key. The file is created on first boot with mode `0600` and reloaded on subsequent boots. Mount a Docker volume at the parent directory to survive image rebuilds.
- "Manage profiles →" link on the login page jumping to `/admin`.
- `commitlint` + `commit-msg` lefthook hook enforcing conventional commits for contributors.

### Changed

- Default dev-oidc port and documentation examples now use `8095` instead of `8080` to reduce common local port collisions.
- README expanded: full-featured `docker-compose.yml` example with volume + healthcheck, "Using dev-oidc in your project" integration walkthrough, every config field documented inline, troubleshooting section, signing-key persistence guide.

## 0.1.0-alpha.1 - 2026-04-23

### Added

- Full OAuth 2.0 authorization-code + PKCE flow (`/authorize`, `/authorize/complete`, `/token`, `/logout`).
- OIDC discovery document (`/.well-known/openid-configuration`).
- JWKS endpoint (`/.well-known/jwks.json`).
- JSON-config-driven clients, profiles, signing key, branding.
- Hot-reload of the config file via `chokidar` — external edits are picked up without restart.
- Server-rendered login page with profile tiles (no client-side framework).
- Admin UI at `/admin` for profile CRUD with atomic write-back to the JSON config.
- Server-Sent Events stream at `/admin/events` notifying the admin UI of external config edits.
- CLI: `dev-oidc start --config <path>`.
- Programmatic API: `createDevOidcServer(config)`.
- Docker image (multi-stage, Alpine-based, runs as non-root).
- Refresh-token grant.
- Configurable `subjectClaim` (default `sub`; set to `oid` for Azure AD / Entra compatibility).
- Reserved-claim protection: user-supplied custom claims cannot overwrite `sub`/`name`/`email`.

### Known limitations

- Development only; tokens do not survive restart.
- No admin UI authentication (localhost bind is the protection).
- Single tenant (one issuer per instance).
- No client authentication at the token endpoint.
