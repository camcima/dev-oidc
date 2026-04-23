# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
