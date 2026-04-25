# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `release-docker.yml` workflow that builds a multi-arch (`linux/amd64`, `linux/arm64`) image from a `v*` tag and pushes it to `ghcr.io/camcima/dev-oidc`. Triggered manually via `workflow_dispatch` so npm and Docker publish paths are independent.
- `release:docker` and `release:all` npm scripts. `release:docker` dispatches the workflow for the current `package.json` version; `release:all` chains `release` (npm) and `release:docker`.

## [0.2.0] - 2026-04-25

### Added

- **Hub mode**: a single dev-oidc process serves multiple OIDC tenants concurrently, each backed by its own project-local `dev-oidc.config.json`. Registry lives at `~/.config/dev-oidc/hub.json`.
- New CLI commands: `dev-oidc register <path>`, `dev-oidc unregister <slug>`, `dev-oidc list`.
- Hub dashboard at `/admin` lists all registered tenants and links to per-tenant management UIs.
- `--port`, `--host`, `--public-url` flags for legacy single-tenant mode.
- Cross-tenant isolation: signing keys, authorization codes, refresh tokens, and pending auth records are strictly scoped per tenant.

### Changed (BREAKING)

- `dev-oidc start` now defaults to Hub mode. Use `dev-oidc start --config <path>` for the prior single-tenant behavior.
- Project schema (`dev-oidc.config.json`) no longer accepts `issuer`, `port`, or `host`. Configs that include these fields fail validation with a tailored error pointing at the replacement.
- Relative `signingKey.source` paths now resolve against the project config file's directory rather than the process CWD.

### Migration from v0.1.x

- **If you run `dev-oidc start --config ./config.json`**: pass `--port`, `--host`, or `--public-url` if you previously relied on those values from the project config. Otherwise no change.
- **If you used Docker**: existing image continues to work in legacy mode; no change.
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
