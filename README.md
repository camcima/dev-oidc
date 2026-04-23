# dev-oidc

A minimal, config-driven OIDC provider for local development.

**Status:** Pre-release. Intended to ship to npm/OCI registries in a future milestone.

[![CI](https://github.com/OWNER/dev-oidc/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/dev-oidc/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dev-oidc.svg)](https://www.npmjs.com/package/dev-oidc)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

## Why

When you build an app that integrates with an OIDC provider (Azure AD / Entra, Auth0, Keycloak, Okta), local iteration is painful: you either bypass auth in dev (drift between dev and prod) or stand up a full IdP (slow). `dev-oidc` sits where the real IdP would — your app runs its real auth code path (redirect, token exchange, JWT verify, refresh) against a mock that you configure via a JSON file.

- **Full auth-code + PKCE** flow with redirect + login page + token exchange.
- **Refresh tokens** supported.
- **Profile tiles** on the login page — pick a user with one click, no password.
- **Hot reload** of the config file — edit the JSON on disk or from another tool, no restart.
- **OIDC-conformant enough** for `oidc-client-ts`, MSAL, and standard JWT libraries to work against it.

## Quickstart — Docker

```yaml
# docker-compose.yml
services:
  dev-oidc:
    image: dev-oidc:local # or a published tag
    volumes:
      - ./dev-oidc.config.json:/config/config.json:ro
    ports:
      - '8080:8080'
```

With a minimal `dev-oidc.config.json`:

```json
{
  "issuer": "http://localhost:8080",
  "host": "0.0.0.0",
  "signingKey": { "kid": "k1" },
  "clients": [
    {
      "clientId": "my-app",
      "redirectUris": ["http://localhost:5173/auth/callback"],
      "audience": "my-api"
    }
  ],
  "profiles": [{ "id": "alice", "displayName": "Alice", "email": "alice@example.com" }]
}
```

> **Note:** Set `"host": "0.0.0.0"` when running inside Docker so the server binds on all interfaces and is reachable through the port mapping. The default (`127.0.0.1`) is correct for bare-metal/CLI use.

Your app points at `http://localhost:8080` as the OIDC issuer and it just works.

## Quickstart — CLI

```bash
npm install --save-dev dev-oidc
npx dev-oidc start --config ./dev-oidc.config.json
```

## Quickstart — programmatic

```ts
import { createDevOidcServer, loadConfig } from 'dev-oidc';

const config = await loadConfig('./dev-oidc.config.json');
const server = await createDevOidcServer({ config });
await server.app.listen({ port: config.port, host: config.host });
```

## Config reference

See `src/config/schema.ts` for the authoritative zod schema. Key fields:

- `issuer` — base URL; appears in the `iss` claim.
- `port`, `host` — listen address (default `127.0.0.1:8080`).
- `signingKey.kid` — key ID exposed in JWKS.
- `clients[]` — at least one; each with `clientId`, `redirectUris`, `audience`.
- `subjectClaim` — `"sub"` (default, OIDC-standard) or `"oid"` (Entra-compat) or any string.
- `profiles[]` — the users offered on the login page; each with `id`, `displayName`, `email`, and an optional `claims` object for arbitrary additional JWT claims.

## Endpoints

| Path                                    | Purpose                         |
| --------------------------------------- | ------------------------------- |
| `GET /.well-known/openid-configuration` | Discovery doc.                  |
| `GET /.well-known/jwks.json`            | Public keys.                    |
| `GET /authorize`                        | Renders the login page (tiles). |
| `POST /authorize/complete`              | Issues an auth code.            |
| `POST /token`                           | Code exchange + refresh.        |
| `GET` / `POST /logout`                  | Ends the session.               |

All flows require **PKCE with S256**. No client secrets. No implicit flow.

## Admin UI

Visit `http://localhost:8080/admin` (dev-only by default, localhost bind). From there you can:

- View all configured profiles.
- Add, edit, or delete profiles. Changes are written atomically to the JSON config file.
- View the full raw config.

The admin UI also subscribes to a Server-Sent Events stream at `/admin/events`. When the JSON config file is edited externally (by another tool, another human, or a coding agent), a "Config changed on disk" banner appears so you can reload.

No authentication on `/admin` — the default localhost bind is the protection. If you run dev-oidc somewhere reachable, ensure network-level access controls are in place.

## Limitations

- **Development only.** Tokens are signed by a key generated at startup; a restart invalidates every token.
- **Single tenant.** One issuer per instance.
- **No client authentication.** The token endpoint trusts `client_id` in the request body. Dev-only.

## Library comparisons

- [`@navikt/mock-oauth2-server`](https://github.com/navikt/mock-oauth2-server) — JVM-based, highest protocol fidelity, generic login form UI. Use if you want JVM + stricter spec conformance.
- [`oauth2-mock-server`](https://github.com/axa-group/oauth2-mock-server) — Node, lighter footprint, programmatic hooks. Use if you don't need a login UI and want to drive auth programmatically in tests.
- [`node-oidc-provider`](https://github.com/panva/node-oidc-provider) — production-grade OIDC provider. Use if you want to build a real IdP, not a dev tool.
- **dev-oidc (this)** — Node, minimal, config-driven, login UI that lets you pick a profile with one click. Use if that's what you want.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, style, and commit conventions. Security issues: please read [SECURITY.md](./SECURITY.md) first.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT.
