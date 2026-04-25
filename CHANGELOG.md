# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
