# Multi-Tenant Hub for dev-oidc

**Status:** Approved
**Date:** 2026-04-25
**Target version:** `0.2.0`
**Author:** Carlos Cima

## 1. Context

dev-oidc currently runs one OIDC configuration per process. Developers working across multiple projects either run multiple instances on different ports, juggle config files by swapping symlinks, or rebuild containers to repoint at a new project.

This spec introduces a **Hub mode** that lets one running dev-oidc process serve many OIDC tenants simultaneously, each backed by its own `dev-oidc.config.json` inside its project repository. Project configs stay portable; a central registry at `~/.config/dev-oidc/hub.json` tracks which projects are mounted.

The current single-tenant CLI (`dev-oidc start --config <path>`) is preserved as **Legacy mode**. Both modes share one set of OIDC and admin route handlers — the difference is the URL prefix and how the per-request tenant is resolved.

## 2. Goals and non-goals

**Goals**

- One process serves N projects concurrently. Each project keeps its config in its own repo.
- Routing namespace per tenant: `/:slug/...` for OIDC endpoints; `/admin/:slug/...` for admin.
- Strict cross-tenant isolation: signing keys, authorization codes, refresh tokens, and pending auth records never cross tenant boundaries.
- Live tenant lifecycle: register/unregister mutates `~/.config/dev-oidc/hub.json`; the running Hub watches the file and mounts/unmounts within the watcher's debounce window. No restart for tenant changes.
- Project portability: a `dev-oidc.config.json` plus its key file (if any) clones cleanly across machines and users.
- Legacy single-tenant CLI continues to work indefinitely, including under the existing Docker image.

**Non-goals**

- Persistence of codes/refresh tokens across restarts. In-memory stores remain (per existing spec `2026-04-25-dev-oidc-stabilization-design.md`).
- Multi-key JWKS rotation per tenant. One signing key per tenant, lifetime of activation.
- Authentication on the admin UI. The Hub binds to `127.0.0.1` by default; threat model is unchanged from today's single-tenant admin.
- Hub-in-Docker as the headline UX. The default Docker entrypoint stays in Legacy mode.
- HTTPS termination inside dev-oidc. `publicUrl` can be `https://...` if a reverse proxy fronts the listener.
- A user-facing "add tenant from the dashboard" flow. Tenant management is CLI-only.

## 3. Architecture overview

The change introduces three layered concepts and refactors existing handlers to be tenant-agnostic:

| Concept        | Where it lives                     | What it owns                                                                              |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Hub config     | `~/.config/dev-oidc/hub.json`      | Listener (port/host/publicUrl), tenant registry (slug → absolute config path, enabled).   |
| Project config | `<project>/dev-oidc.config.json`   | Identity: signing key, clients, profiles, branding, subjectClaim, TTLs.                   |
| TenantRegistry | In-process (`src/hub/registry.ts`) | Per-tenant runtime state: parsed config, KeyMaterial, JWKS, code/pending stores, watcher. |

**Two server entrypoints share one handler set**:

- `createHubServer({ hubConfigPath })` — Hub mode. Routes registered under `/:slug/...`.
- `createDevOidcServer({ config, configFilePath, listener })` — Legacy mode (existing entry point, preserved). Routes at root, single tenant in the registry.

Existing route handlers (`registerAuthorize`, `registerComplete`, `registerToken`, `registerLogout`, `registerProfilesRoutes`) are refactored to take a `getTenant: (req) => TenantState` resolver instead of receiving `runtime`/`codes`/`pending`/`keyMaterial` directly. In Hub mode the resolver reads `req.params.slug`; in Legacy mode it returns the single tenant.

New modules added:

- `src/hub/schema.ts` — Zod schema for `hub.json`.
- `src/hub/loader.ts` — `loadHubConfig` with auto-create.
- `src/hub/watcher.ts` — `hub.json` reconciliation watcher.
- `src/hub/registry.ts` — `TenantRegistry` class.
- `src/hub/server.ts` — `createHubServer`.
- `src/admin/dashboard.ts` — Hub dashboard renderer.
- `src/cli/hub-commands.ts` — `register`, `unregister`, `list` implementations.

## 4. Configuration model

### 4.1 Hub config (`~/.config/dev-oidc/hub.json`)

```ts
interface HubConfig {
  version: '1';
  server: {
    port: number; // default 8095
    host: string; // default 127.0.0.1
    publicUrl?: string; // default `http://${host}:${port}`; advertised in tenant issuers
  };
  tenants: Array<{
    slug: string; // ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$, not reserved
    configPath: string; // absolute path; relative paths rejected
    enabled: boolean; // default true
  }>;
}
```

**XDG**: the loader honors `$XDG_CONFIG_HOME` when set; otherwise `~/.config/dev-oidc/hub.json`.

**Auto-create**: on first `dev-oidc start`, if the file does not exist, the loader writes the empty bootstrap (`{ version: "1", server: { port: 8095, host: "127.0.0.1" }, tenants: [] }`) with mode `0o600`.

**Slug rules**:

- Regex: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (1–64 chars, lowercase alphanumeric + hyphen, no leading/trailing hyphen).
- Reserved (rejected at all layers): `admin`, `api`, `.well-known`, `_health`, `_internal`, `static`, anything starting with `_` or `.`.
- Uniqueness enforced at hub-load and at `register` time.

**Path rules**: `configPath` must be absolute. The Zod schema rejects relative paths so a hand-edited `hub.json` cannot silently inherit a CWD-dependent meaning.

### 4.2 Project config (`<project>/dev-oidc.config.json`)

The existing `ConfigSchema` is reduced. Three fields are removed:

| Removed field | Replacement                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `issuer`      | Computed: Hub mode `${publicUrl}/${slug}`; Legacy mode `--public-url` (default `http://${host}:${port}`). |
| `port`        | `hub.server.port` (Hub) or `--port` (Legacy).                                                             |
| `host`        | `hub.server.host` (Hub) or `--host` (Legacy).                                                             |

Final project schema:

```ts
ConfigSchema = z.object({
  signingKey,
  clients,
  subjectClaim,
  tokenTtlSeconds,
  refreshTokenTtlSeconds,
  branding,
  profiles,
});
```

Existing project configs that include `issuer`/`port`/`host` fail Zod parsing with a tailored error message: _"field `issuer` no longer belongs in project config; the Hub computes it from publicUrl + slug, or pass `--public-url` for legacy mode"_. The same wording applies for `port`/`host`.

### 4.3 Issuer derivation

- **Hub mode**: `tenant.issuer = stripTrailingSlash(hub.server.publicUrl) + '/' + tenant.slug`.
- **Legacy mode**: `tenant.issuer = stripTrailingSlash(--public-url)`.

The issuer is computed at activation time and stored on `TenantState`. `buildDiscoveryDocument` continues to take an `issuer` string with no signature change.

### 4.4 Signing-key path resolution

`createKeyMaterial` is updated to accept a `configDir: string` argument. When `signingKey.source` starts with `file:`, the path after `file:` is resolved as follows:

- Absolute: used verbatim.
- Relative: `path.resolve(configDir, relative)`.

`configDir` is `path.dirname(absoluteConfigPath)` — the directory containing the project's `dev-oidc.config.json`. This rule applies in **both Hub and Legacy modes**, replacing today's CWD-relative behavior.

The behavior change is breaking for the narrow case of: a Legacy user with a relative `signingKey.source` who runs `dev-oidc start` from a CWD that is not the project root. Released as part of the v0.2.0 schema cut.

## 5. Internal state management

### 5.1 TenantState

```ts
type TenantStatus = 'active' | 'error';

interface TenantState {
  slug: string;
  configPath: string; // absolute
  status: TenantStatus;
  lastError?: string; // populated when status === 'error'

  // Populated only when status === 'active':
  config?: Config;
  runtime?: RuntimeConfig;
  keyMaterial?: KeyMaterial;
  jwks?: JwksDocument;
  codes?: CodeStore;
  pending?: PendingAuthStore;
  watcher?: ConfigWatcher; // per-tenant project-config watcher
  issuer?: string; // computed at activation
}
```

### 5.2 TenantRegistry

```ts
interface TenantRegistry {
  list(): readonly TenantState[];
  get(slug: string): TenantState | undefined;
  add(entry: HubTenantEntry): Promise<void>; // idempotent: existing slug replaces
  remove(slug: string): Promise<void>;
  reconcile(entries: HubTenantEntry[]): Promise<void>;
  events: TenantRegistryEvents; // 'added' | 'removed' | 'statusChanged' | 'profilesChanged'
}
```

`reconcile` diffs incoming entries against the current set: adds new slugs, removes missing ones, and replaces entries whose `configPath` or `enabled` flag changed. It is the one path the `hub.json` watcher takes.

### 5.3 Activation flow

When `add` or `reconcile` activates a tenant:

1. `loadConfig(absolutePath)` — Zod parse. On failure: set `status: 'error'`, `lastError = e.message`, emit `statusChanged`. Return.
2. `createKeyMaterial(config.signingKey, { configDir: path.dirname(absolutePath) })`. On failure: same error path.
3. `buildJwks(keyMaterial)` once.
4. Construct per-tenant `CodeStore`, `PendingAuthStore`, `RuntimeConfig`.
5. Compute `issuer` from `(hub.server.publicUrl, slug)`.
6. Start `watchConfig(absolutePath, { onReload, onError })`:
   - `onReload(newConfig)`: if Zod-valid, `runtime.set(newConfig)` — keeps last-good behavior already present in `src/config/watcher.ts`. KeyMaterial is **not** rebuilt on reload (matches today's behavior; key rebuild requires deactivate/reactivate).
   - `onError(err)`: log, keep previous config.
7. Subscribe `runtime.onChange` → emit `profilesChanged` so SSE clients can refresh.
8. Set `status: 'active'`; emit `statusChanged`.

### 5.4 Deactivation flow

`remove` (or shutdown) closes the per-tenant watcher, drops in-memory codes and pending records, and discards `keyMaterial` (ephemeral keys vanish; persisted ones remain on disk).

### 5.5 Error model

- **Boot-time error** (a tenant in `hub.json` whose config is missing/invalid at server start): the tenant is held in `error` state with `lastError` populated. The Hub starts normally; other tenants run. OIDC routes for the broken tenant return `503 service_unavailable` with an OIDC-style JSON body and the dashboard surfaces the error.
- **Runtime error** (config goes invalid mid-run): the per-tenant watcher logs and keeps the last good config — existing behavior of `src/config/watcher.ts` preserved.
- **Unknown slug**: routes return `404 not_found`.
- **Recovery**: when a previously broken file becomes valid (file change event), the watcher fires; the registry retries activation; on success `status` flips to `active` and `statusChanged` is emitted.

### 5.6 Cross-tenant isolation guarantees

These are guaranteed by construction (separate `CodeStore`, `PendingAuthStore`, `KeyMaterial` per tenant) and verified by integration tests:

- An authorization code issued by tenant A POSTed to `/B/token` returns `invalid_grant`.
- A refresh token from tenant A POSTed to `/B/token` returns `invalid_grant`.
- A token signed by tenant A's key has `iss = ${publicUrl}/A`. Verifying with tenant B's JWKS fails.
- Two tenants with identical `clientId` strings and `audience` strings issue tokens that differ in `kid`, `iss`, and signing key — neither token verifies as the other.

## 6. Routing and request flow

### 6.1 Hub mode routes

```
GET   /:slug/.well-known/openid-configuration
GET   /:slug/.well-known/jwks.json
GET   /:slug/authorize
POST  /:slug/authorize/complete
POST  /:slug/token
GET   /:slug/logout
POST  /:slug/logout

GET   /admin
GET   /admin/events
GET   /admin/api/tenants
GET   /admin/:slug
GET   /admin/api/:slug/config
GET   /admin/api/:slug/profiles
POST  /admin/api/:slug/profiles
PUT   /admin/api/:slug/profiles/:id
DELETE /admin/api/:slug/profiles/:id

GET   /
```

Fastify route registration declares all the static `/admin/...` paths before the dynamic `/:slug/...` paths to avoid any router-priority surprise. The reserved-slug list further guarantees no collision.

### 6.2 Per-request tenant resolution

A pre-handler (one per route family) reads `req.params.slug`, resolves it against the registry, and stashes `request.tenant` for downstream code:

- `registry.get(slug) === undefined` → `reply.code(404).send({ error: 'not_found' })`.
- `tenant.status === 'error'` → `reply.code(503).send({ error: 'service_unavailable', error_description: tenant.lastError })`.
- Otherwise pass through.

Routes never un-register or re-register on tenant changes; the registry is the single source of truth and the pre-handler enforces visibility.

### 6.3 Legacy mode routes

Routes register at the root (`/.well-known/...`, `/authorize`, `/token`, `/logout`, `/admin`, `/admin/api/profiles`, etc.). Routes contain no `:slug` parameter; the resolver is bound to the single Legacy tenant directly. The Legacy tenant lives in the registry under a sentinel slug `'(legacy)'` that is excluded from the dashboard's tenant list endpoint and from `dev-oidc list`. Slug-regex validation does not apply to the Legacy tenant because no slug is ever templated into a URL or input from a request.

### 6.4 Handler refactor

Each `register*` function changes its dependency shape:

```ts
// Before
registerAuthorize(app, { runtime, pending });

// After
registerAuthorize(app, { getTenant: (req) => TenantState });
```

Inside the handler, `runtime`, `pending`, `codes`, `keyMaterial`, and `issuer` are read off the resolved `TenantState`. The handler bodies remain the same.

### 6.5 SSE events

`/admin/events` emits `{ type: 'config-changed', slug }`. The dashboard listens for any event and refreshes its tenant list; per-tenant pages filter by their own slug to avoid spurious reloads when other tenants change.

### 6.6 Path safety

- The pre-handler validates `req.params.slug` against the slug regex before registry lookup. Non-matching values short-circuit to `404 not_found` without touching the registry. (Fastify's default `/:slug` matches any non-`/` path segment; the regex check is explicit, not implicit.)
- Slug values are never concatenated into filesystem paths.
- `configPath` from `hub.json` is used after Zod-asserting it's absolute.
- Tagged-template HTML renderer (existing `src/shared/html.ts`) escapes all dynamic content rendered into the dashboard and per-tenant pages.

## 7. CLI surface

### 7.1 `dev-oidc start`

Default behavior: Hub mode using `~/.config/dev-oidc/hub.json` (auto-created if missing).

Flags:

- `--config <path>` — switches to Legacy mode.
- `--port <number>` (Legacy only; default 8095).
- `--host <ip>` (Legacy only; default 127.0.0.1).
- `--public-url <url>` (Legacy only; default `http://${host}:${port}`).
- `--hub-config <path>` (Hub only; defaults to XDG location).
- `-h, --help`.

Combining `--config` with any Hub-only flag exits with a clear error.

### 7.2 `dev-oidc register <path> [--slug <name>] [--hub-config <path>]`

1. Resolve `<path>` to an absolute path (handles `~`, `.`, etc.).
2. Require the file's basename to end in `.json`. (Convention is `dev-oidc.config.json` but any `*.json` is accepted.)
3. `loadConfig(absolutePath)` — Zod-validate. Bail on validation errors.
4. Determine slug: `--slug` wins; otherwise sanitize `path.basename(path.dirname(absolutePath))` (lowercase, replace non-`[a-z0-9-]` with `-`, collapse runs, trim, max 64). If sanitization yields empty, reserved, or a name already in use, error and require `--slug`.
5. Load `hub.json` (auto-create if missing). Append `{ slug, configPath, enabled: true }`.
6. If slug already present → error: _"slug already registered to {existing path}; use a different --slug or `dev-oidc unregister <slug>` first"_.
7. Atomic write back (tmp + rename). Print `Registered "{slug}" → {absolutePath}`.

### 7.3 `dev-oidc unregister <slug> [--hub-config <path>]`

Removes the entry from `hub.json`. Prints what was removed. Exit code 1 if the slug is unknown.

### 7.4 `dev-oidc list [--hub-config <path>] [--json]`

- Default: human-friendly table — `slug | enabled | configPath | issuer (using publicUrl)`. Reads `hub.json` only; reports configured state, not live runtime status (a tenant in `error` state shows `enabled: true` here — the dashboard at `/admin` is the source of truth for live status).
- `--json`: emits the raw `tenants` array for scripting.

### 7.5 Help text

`dev-oidc --help` documents all five sub-commands. `dev-oidc <subcommand> --help` shows subcommand-specific flags.

### 7.6 Exit codes

- `0` — success.
- `1` — user error (invalid slug, duplicate, missing config, unknown slug for unregister).
- `2` — system error (cannot write `hub.json`, etc.).

### 7.7 Concurrency

`register` and `unregister` use atomic file replace (tmp + rename, matching `src/config/writer.ts`). A running Hub picks up changes via its `hub.json` watcher within the debounce window (~200 ms). No IPC needed; no PID file; no service-control protocol.

## 8. Admin UI

### 8.1 `GET /admin` — Hub dashboard

New renderer in `src/admin/dashboard.ts`. Layout:

- Header: "dev-oidc — Hub" with `hub.server.publicUrl` in a `<code>` block.
- "Tenants ({count})" table:

| Slug     | Status                | Issuer                                                | Profiles | Config path                                                      | Actions                              |
| -------- | --------------------- | ----------------------------------------------------- | -------- | ---------------------------------------------------------------- | ------------------------------------ |
| `my-app` | `Active` (green pill) | `http://localhost:8095/my-app` (link → discovery doc) | `3`      | `/home/.../proj/dev-oidc.config.json` (truncated, full on hover) | `Manage →`                           |
| `broken` | `Error` (red pill)    | —                                                     | —        | `/home/.../bad/dev-oidc.config.json`                             | (collapsed details with `lastError`) |

- Empty state ("No tenants registered yet"): one-paragraph hint with a copyable `dev-oidc register <path>` example.
- SSE wiring: connects to `/admin/events`; on any event refetches `/admin/api/tenants` and re-renders the table client-side. Falls back to a full reload banner if simpler during implementation.

### 8.2 `GET /admin/:slug` — per-tenant page

Existing profile-CRUD page, scoped. Header changes:

- Breadcrumb: `← Hub` (links `/admin`) `/` `{slug}`.
- Title: existing `{branding.title} — dev-oidc` with the slug as a subtitle.
- Form `data-api` attributes scope to the slug: `/admin/api/{slug}/profiles[/{id}]`. The renderer takes the slug as input.

### 8.3 `GET /admin/api/tenants`

New JSON endpoint for the dashboard:

```json
[
  { "slug": "my-app", "status": "active", "issuer": "...", "configPath": "...", "profileCount": 3 },
  {
    "slug": "broken",
    "status": "error",
    "issuer": null,
    "configPath": "...",
    "profileCount": null,
    "lastError": "ENOENT ..."
  }
]
```

### 8.4 `GET /admin/api/:slug/...`

Existing config and profile endpoints, slug-scoped. 404 for unknown slug, 503 for `error` status — so the per-tenant page renders a friendly error page rather than crashing on absent config.

### 8.5 `GET /` — root landing

Updated to enumerate registered tenants and link to each tenant's discovery doc and the admin dashboard. In Legacy mode, behavior unchanged from today.

### 8.6 Legacy mode admin

URLs unchanged: `/admin`, `/admin/api/profiles`, `/admin/api/profiles/:id`, `/admin/events`. Renders the existing single-tenant page.

## 9. Testing strategy

New and updated tests:

| File                                      | Purpose                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tests/hub/schema.test.ts`                | `hub.json` Zod schema: defaults, slug regex, reserved-name rejection, absolute-path enforcement, version. |
| `tests/hub/loader.test.ts`                | Auto-create on missing file; XDG resolution; mode 0o600 on created file.                                  |
| `tests/hub/registry.test.ts`              | add/remove idempotency, error-state on bad config, recovery, watcher cleanup, slug uniqueness.            |
| `tests/hub/watcher.test.ts`               | `hub.json` reconciliation: add, remove, rename, enabled toggle.                                           |
| `tests/integration/hub-isolation.test.ts` | Cross-tenant isolation guarantees from §5.6.                                                              |
| `tests/integration/hub-flow.test.ts`      | Full auth-code flow under Hub mode.                                                                       |
| `tests/integration/hub-admin.test.ts`     | Dashboard endpoints, per-tenant CRUD, SSE filtering.                                                      |
| `tests/cli/register.test.ts`              | Slug derivation, validation, duplicate detection, atomic mutation.                                        |
| `tests/cli/unregister.test.ts`            | Removal, missing-slug error.                                                                              |
| `tests/cli/list.test.ts`                  | Human and `--json` output.                                                                                |
| `tests/cli/legacy.test.ts`                | `--config` path with `--port`/`--host`/`--public-url`.                                                    |

Existing tests (`tests/integration/oidc-flow.test.ts`, `tests/integration/admin.test.ts`, `tests/oidc/*.test.ts`, `tests/admin/*.test.ts`, `tests/config/*.test.ts`) remain a regression net for Legacy mode and the shared handler bodies. They are updated only where the handler dependency shape changes (handlers now read state off `TenantState` rather than direct DI).

## 10. Migration / implementation order

Each phase is a self-contained PR; CI green at every step. Phases land in order.

| Phase | Theme                                       | Concrete items                                                                                                                                                                                                                                                                                                 | Risk   |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0     | Refactor handlers to take a tenant resolver | Introduce `TenantState` type and `getTenant: (req) => TenantState` resolver. `register*` switch from `{ runtime, codes, ... }` to `{ getTenant }`. Existing single-tenant `createDevOidcServer` synthesizes a one-element `TenantState` and binds the resolver to it. No behavior change; existing tests pass. | Low    |
| 1     | Project-schema reduction                    | Drop `issuer/port/host` from `ConfigSchema`. Add `--port/--host/--public-url` to Legacy CLI. Migrate fixtures and `examples/config.json`. README/CHANGELOG note.                                                                                                                                               | Medium |
| 2     | Signing-key path resolution                 | `createKeyMaterial` takes `configDir`; relative `file:` paths resolve against it.                                                                                                                                                                                                                              | Low    |
| 3     | TenantRegistry + Hub config                 | New `src/hub/{schema,loader,watcher,registry,server}.ts`. Routes under `/:slug/...`. Cross-tenant isolation tests. CLI `start` defaults to Hub. Auto-create `hub.json`.                                                                                                                                        | High   |
| 4     | CLI `register`/`unregister`/`list`          | New `src/cli/hub-commands.ts`. Help text. Tests.                                                                                                                                                                                                                                                               | Low    |
| 5     | Admin dashboard + per-tenant routing        | Dashboard renderer, `/admin/api/tenants`, per-tenant prefixes for admin pages, SSE filtering.                                                                                                                                                                                                                  | Medium |
| 6     | Documentation                               | README rewrite (Hub primary, Legacy + Docker secondary). CHANGELOG. Reduced `dev-oidc.config.json` example. Optional `docs/hub-mode.md`.                                                                                                                                                                       | Zero   |

## 11. Out of scope (deferred)

- Persistence of codes/refresh tokens across restarts.
- Multi-key JWKS rotation per tenant.
- Authentication on the Admin UI.
- Hub-in-Docker as the primary path.
- HTTPS termination inside dev-oidc.
- "Add tenant from the dashboard" UX.
- Cross-tenant quota or rate limiting.
