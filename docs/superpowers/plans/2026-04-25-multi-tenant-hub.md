# Multi-Tenant Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Hub mode for dev-oidc — one process serves N project tenants with full cross-tenant isolation, while preserving the existing single-tenant CLI as Legacy mode.

**Architecture:** Phase 0 refactors handlers behind a `getTenant: (req) => TenantState` resolver so they become tenant-agnostic. Phases 1–2 reduce the project schema and fix key-path resolution. Phase 3 introduces a `TenantRegistry` plus `hub.json` schema/loader/watcher and a new `createHubServer` entrypoint that registers OIDC routes under `/:slug/...`. Phases 4–5 add the CLI sub-commands and the admin dashboard. Phase 6 finishes documentation.

**Tech Stack:** TypeScript, Fastify 5, Zod v4, jose, chokidar, vitest, pino. Existing code patterns:

- `@/` path alias for `src/` (set in `tsconfig.json` and `tsup.config.ts`).
- ESM-only (`"type": "module"`); imports use `.js` suffix even in `.ts` files.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Tests use `vitest` (`describe`, `it`, `expect`) and Fastify's `app.inject()`.
- Pre-commit hook runs prettier (whole repo) and eslint (staged files only); commitlint validates the message.

**Spec reference:** `docs/superpowers/specs/2026-04-25-multi-tenant-hub-design.md`.

**Branch:** `feat/multi-tenant-hub` (already created and contains the spec commit).

---

## File Structure

### New files

| Path                                      | Responsibility                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/hub/tenant-state.ts`                 | `TenantState`, `TenantStatus` types + the discriminated union for active/error.           |
| `src/hub/schema.ts`                       | Zod schema for `hub.json`: `HubConfigSchema`, slug regex, reserved-slug list.             |
| `src/hub/loader.ts`                       | `loadHubConfig` with auto-create, XDG resolution, atomic write helpers.                   |
| `src/hub/registry.ts`                     | `TenantRegistry` class: add/remove/reconcile, per-tenant activation, event emitter.       |
| `src/hub/watcher.ts`                      | Watches `hub.json`, calls `registry.reconcile` on changes.                                |
| `src/hub/issuer.ts`                       | `computeIssuer({ publicUrl, slug })` — pure function for issuer derivation.               |
| `src/hub/server.ts`                       | `createHubServer` — full Fastify app with `/:slug/...` routes and admin dashboard wiring. |
| `src/admin/dashboard.ts`                  | Hub dashboard renderer (`/admin`) and tenant-list JSON endpoint.                          |
| `src/cli/hub-commands.ts`                 | `register` / `unregister` / `list` command implementations.                               |
| `src/cli/legacy.ts`                       | Legacy-mode CLI flag handling factored out of `cli.ts`.                                   |
| `tests/hub/schema.test.ts`                | Hub schema tests.                                                                         |
| `tests/hub/loader.test.ts`                | Hub loader tests.                                                                         |
| `tests/hub/registry.test.ts`              | TenantRegistry tests.                                                                     |
| `tests/hub/watcher.test.ts`               | Hub watcher tests.                                                                        |
| `tests/hub/issuer.test.ts`                | Issuer derivation tests.                                                                  |
| `tests/integration/hub-flow.test.ts`      | End-to-end auth-code flow under Hub mode (one tenant).                                    |
| `tests/integration/hub-isolation.test.ts` | Cross-tenant isolation guarantees.                                                        |
| `tests/integration/hub-admin.test.ts`     | Dashboard endpoints, per-tenant CRUD, SSE filtering.                                      |
| `tests/cli/register.test.ts`              | `register` command unit tests.                                                            |
| `tests/cli/unregister.test.ts`            | `unregister` command unit tests.                                                          |
| `tests/cli/list.test.ts`                  | `list` command unit tests.                                                                |

### Modified files

| Path                           | Change                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/config/schema.ts`         | Drop `issuer`, `port`, `host`. Add tailored Zod error messages.                                                   |
| `src/oidc/keys.ts`             | `createKeyMaterial` accepts a `configDir` for relative `file:` path resolution.                                   |
| `src/oidc/authorize.ts`        | Take `getTenant` resolver; read `runtime` and `pending` off the resolved `TenantState`.                           |
| `src/oidc/complete.ts`         | Take `getTenant` resolver; read `runtime`, `pending`, `codes` off `TenantState`.                                  |
| `src/oidc/token.ts`            | Take `getTenant` resolver; read `runtime`, `codes`, `keyMaterial`, `issuer` off `TenantState`.                    |
| `src/oidc/logout.ts`           | Take `getTenant` resolver; read `runtime` off `TenantState`.                                                      |
| `src/oidc/discovery.ts`        | (No signature change — handler reads `tenant.issuer` and passes it in.)                                           |
| `src/admin/profiles-routes.ts` | Take `getTenant` + `configFilePath` resolver pair; per-tenant slug routing.                                       |
| `src/admin/page.ts`            | Accept slug param for per-tenant scoped form `data-api` URLs.                                                     |
| `src/admin/events.ts`          | Slug-aware events: `{ type: 'config-changed', slug }`. Client filters.                                            |
| `src/index/page.ts`            | Enumerate tenants in Hub mode; legacy single-tenant view unchanged.                                               |
| `src/server.ts`                | Existing `createDevOidcServer` becomes Legacy entrypoint; synthesizes one `TenantState`; uses new resolver shape. |
| `src/cli.ts`                   | Dispatch sub-commands: `start`, `register`, `unregister`, `list`.                                                 |
| `examples/config.json`         | Drop `issuer`, `host`. Used as a Hub-registerable example.                                                        |
| `README.md`                    | Hub mode primary; Legacy + Docker secondary.                                                                      |
| `CHANGELOG.md`                 | v0.2.0 entry.                                                                                                     |
| `.prettierignore`              | (Optional, already-decided cleanup) — `skills/` if user agrees later.                                             |

---

## Phase 0 — Refactor handlers behind a tenant resolver

**Goal:** Introduce `TenantState` and a `getTenant` resolver pattern. Each `register*` function reads its dependencies off `TenantState` rather than receiving them via DI. `createDevOidcServer` synthesizes a one-element resolver. No behavior change; existing test suite passes unchanged.

**Phase checkpoint:** All existing tests pass; `npm run test`, `npm run typecheck`, `npm run lint` are green.

### Task 0.1: Define TenantState type

**Files:**

- Create: `src/hub/tenant-state.ts`

- [ ] **Step 1: Create the file with the type definitions**

```ts
import type { Config } from '@/config/schema.js';
import type { RuntimeConfig } from '@/config/runtime.js';
import type { KeyMaterial } from '@/oidc/keys.js';
import type { CodeStore } from '@/oidc/codes.js';
import type { PendingAuthStore } from '@/oidc/pending.js';
import type { ConfigWatcher } from '@/config/watcher.js';
import type { JwksDocument } from '@/oidc/jwks.js';

export type TenantStatus = 'active' | 'error';

export interface ActiveTenantState {
  slug: string;
  configPath: string;
  status: 'active';
  config: Config;
  runtime: RuntimeConfig;
  keyMaterial: KeyMaterial;
  jwks: JwksDocument;
  codes: CodeStore;
  pending: PendingAuthStore;
  watcher: ConfigWatcher | null;
  issuer: string;
}

export interface ErrorTenantState {
  slug: string;
  configPath: string;
  status: 'error';
  lastError: string;
}

export type TenantState = ActiveTenantState | ErrorTenantState;
```

- [ ] **Step 2: Export `JwksDocument` type from `src/oidc/jwks.ts`**

Read `src/oidc/jwks.ts` to find what `buildJwks` currently returns. Add a named type export so `TenantState` can refer to it.

```ts
// at the top of src/oidc/jwks.ts (after existing imports)
import type { KeyMaterial } from '@/oidc/keys.js';

export interface JwksDocument {
  keys: jose.JWK[];
}

export function buildJwks(km: KeyMaterial): JwksDocument {
  // existing body unchanged
}
```

If `buildJwks` already returns an inline shape, replace with the named type.

- [ ] **Step 3: Run typecheck to verify clean compilation**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/hub/tenant-state.ts src/oidc/jwks.ts
git commit -m "refactor(hub): introduce TenantState type and JwksDocument export"
```

### Task 0.2: Refactor `registerAuthorize` to take `getTenant`

**Files:**

- Modify: `src/oidc/authorize.ts`
- Test: `tests/oidc/authorize.test.ts` (read first to understand existing test setup)

- [ ] **Step 1: Read existing tests to see how `registerAuthorize` is invoked**

Run: `head -80 tests/oidc/authorize.test.ts`
Note the current dependency-injection pattern.

- [ ] **Step 2: Update tests to use the new resolver shape**

Refactor the test setup to wrap the existing `runtime`/`pending` deps in a synthesized `TenantState`. Add a small helper at the top of the test file:

```ts
import type { ActiveTenantState } from '@/hub/tenant-state.js';

function buildActiveTenant(overrides: Partial<ActiveTenantState>): ActiveTenantState {
  // Returns an ActiveTenantState with the given pieces and inert defaults
  // for any field not supplied. Tests that don't care about codes/keyMaterial
  // still need the field to exist for type-checking.
  return {
    slug: '(legacy)',
    configPath: '/dev/null',
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    ...overrides,
  } as ActiveTenantState;
}
```

In each `it(...)` that wires the route, change the `register*` call from `registerAuthorize(app, { runtime, pending })` to:

```ts
const tenant = buildActiveTenant({ config, runtime, pending });
registerAuthorize(app, { getTenant: () => tenant });
```

- [ ] **Step 3: Run the tests — they should fail (signature mismatch)**

Run: `npx vitest run tests/oidc/authorize.test.ts`
Expected: FAIL — TypeScript error or runtime error: `getTenant is not a function`.

- [ ] **Step 4: Refactor `src/oidc/authorize.ts`**

Replace the current shape:

```ts
// Before
export interface AuthorizeDeps {
  runtime: RuntimeConfig;
  pending: PendingAuthStore;
}

export function registerAuthorize(app: FastifyInstance, deps: AuthorizeDeps): void {
  app.get('/authorize', async (request, reply) => {
    // ... uses deps.runtime, deps.pending
  });
}
```

With:

```ts
// After
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { renderLoginPage } from '@/login/page.js';

export interface AuthorizeDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
}

export function registerAuthorize(app: FastifyInstance, deps: AuthorizeDeps): void {
  app.get('/authorize', async (request, reply) => {
    const tenant = deps.getTenant(request);
    const config = tenant.runtime.get();
    // ... rest of the body, using `tenant.pending` instead of `deps.pending`
  });
}
```

The body of the handler is unchanged except `deps.runtime` → `tenant.runtime` and `deps.pending` → `tenant.pending`.

- [ ] **Step 5: Run the tests again — should pass**

Run: `npx vitest run tests/oidc/authorize.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/oidc/authorize.ts tests/oidc/authorize.test.ts
git commit -m "refactor(oidc): authorize takes getTenant resolver"
```

### Task 0.3: Refactor `registerComplete` to take `getTenant`

**Files:**

- Modify: `src/oidc/complete.ts`
- Test: `tests/oidc/complete.test.ts`

- [ ] **Step 1: Update test wiring (same `buildActiveTenant` helper pattern)**

In `tests/oidc/complete.test.ts`, replace each `registerComplete(app, { runtime, pending, codes })` call with:

```ts
import type { ActiveTenantState } from '@/hub/tenant-state.js';

const tenant = {
  slug: '(legacy)',
  configPath: '/dev/null',
  status: 'active' as const,
  issuer: 'http://localhost:8095',
  watcher: null,
  config: /* existing test config */,
  runtime,
  pending,
  codes,
  keyMaterial: /* existing test keyMaterial */,
  jwks: { keys: [] },
} satisfies ActiveTenantState;
registerComplete(app, { getTenant: () => tenant });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/oidc/complete.test.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor `src/oidc/complete.ts`**

```ts
// Before
export interface CompleteDeps {
  runtime: RuntimeConfig;
  pending: PendingAuthStore;
  codes: CodeStore;
}

// After
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

export interface CompleteDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
}

export function registerComplete(app: FastifyInstance, deps: CompleteDeps): void {
  app.post('/authorize/complete', async (request, reply) => {
    const tenant = deps.getTenant(request);
    const config = tenant.runtime.get();
    // ... use tenant.pending, tenant.codes
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/oidc/complete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/oidc/complete.ts tests/oidc/complete.test.ts
git commit -m "refactor(oidc): complete takes getTenant resolver"
```

### Task 0.4: Refactor `registerToken` to take `getTenant`

**Files:**

- Modify: `src/oidc/token.ts`
- Test: `tests/oidc/token.test.ts`

- [ ] **Step 1: Update test wiring**

Replace `registerToken(app, { runtime, codes, keyMaterial })` with:

```ts
const tenant = {
  slug: '(legacy)',
  configPath: '/dev/null',
  status: 'active' as const,
  issuer: 'http://localhost:8095',
  watcher: null,
  config,
  runtime,
  codes,
  pending: /* test pending */,
  keyMaterial,
  jwks: { keys: [] },
} satisfies ActiveTenantState;
registerToken(app, { getTenant: () => tenant });
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/oidc/token.test.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor `src/oidc/token.ts`**

```ts
// Before
export interface TokenDeps {
  runtime: RuntimeConfig;
  codes: CodeStore;
  keyMaterial: KeyMaterial;
}

// After
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

export interface TokenDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
}

export function registerToken(app: FastifyInstance, deps: TokenDeps): void {
  app.post('/token', async (request, reply) => {
    const tenant = deps.getTenant(request);
    const config = tenant.runtime.get();
    // ... rest of body
  });
}
```

The internal helpers `handleCodeGrant`, `handleRefreshGrant`, `issueTokenSet` need to take `tenant` instead of `deps`. Update their signatures and call sites:

```ts
async function handleCodeGrant(
  tenant: ActiveTenantState,
  body: TokenBody,
  reply: FastifyReply,
): Promise<unknown> {
  // ... use tenant.codes, tenant.runtime, tenant.keyMaterial
}

// etc.
```

Update `setIssuer(config.issuer)` → `setIssuer(tenant.issuer)` (the config no longer carries issuer; the tenant does).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/oidc/token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/oidc/token.ts tests/oidc/token.test.ts
git commit -m "refactor(oidc): token takes getTenant resolver"
```

### Task 0.5: Refactor `registerLogout` to take `getTenant`

**Files:**

- Modify: `src/oidc/logout.ts`
- Test: `tests/oidc/logout.test.ts`

- [ ] **Step 1: Update test wiring**

Replace `registerLogout(app, { runtime })` with:

```ts
const tenant: ActiveTenantState = {
  slug: '(legacy)',
  configPath: '/dev/null',
  status: 'active',
  issuer: 'http://localhost:8095',
  watcher: null,
  config,
  runtime,
  codes: /* */,
  pending: /* */,
  keyMaterial: /* */,
  jwks: { keys: [] },
};
registerLogout(app, { getTenant: () => tenant });
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/oidc/logout.test.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor `src/oidc/logout.ts`**

```ts
// After
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { renderLogoutPage } from '@/oidc/logout-page.js';

export interface LogoutDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
}

export function registerLogout(app: FastifyInstance, deps: LogoutDeps): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const tenant = deps.getTenant(request);
    const config = tenant.runtime.get();
    // ... rest of body
  };
  app.get('/logout', handler);
  app.post('/logout', handler);
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/oidc/logout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/oidc/logout.ts tests/oidc/logout.test.ts
git commit -m "refactor(oidc): logout takes getTenant resolver"
```

### Task 0.6: Refactor `registerProfilesRoutes` to take `getTenant` + `getConfigPath`

**Files:**

- Modify: `src/admin/profiles-routes.ts`
- Test: `tests/admin/profiles-routes.test.ts`

- [ ] **Step 1: Update test wiring**

Replace `registerProfilesRoutes(app, { runtime, configFilePath })` with:

```ts
const tenant: ActiveTenantState = {
  slug: '(legacy)',
  configPath: testConfigPath,
  status: 'active',
  issuer: 'http://localhost:8095',
  watcher: null,
  config,
  runtime,
  codes: /* */,
  pending: /* */,
  keyMaterial: /* */,
  jwks: { keys: [] },
};
registerProfilesRoutes(app, { getTenant: () => tenant });
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/admin/profiles-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor `src/admin/profiles-routes.ts`**

```ts
// After
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeConfigFile } from '@/config/writer.js';
import type { Profile } from '@/config/schema.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

export interface ProfilesRoutesDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
}

const ProfileInput = z.object({
  /* unchanged */
});

export function registerProfilesRoutes(app: FastifyInstance, deps: ProfilesRoutesDeps): void {
  app.get('/admin/api/config', async (request) => {
    return deps.getTenant(request).runtime.get();
  });

  app.get('/admin/api/profiles', async (request) => {
    return deps.getTenant(request).runtime.get().profiles;
  });

  app.post('/admin/api/profiles', async (request, reply) => {
    const tenant = deps.getTenant(request);
    // existing logic; replace deps.runtime with tenant.runtime
    //                replace deps.configFilePath with tenant.configPath
  });

  // PUT and DELETE handlers analogous: read tenant via deps.getTenant(request),
  // use tenant.runtime and tenant.configPath.
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/admin/profiles-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/profiles-routes.ts tests/admin/profiles-routes.test.ts
git commit -m "refactor(admin): profiles-routes takes getTenant resolver"
```

### Task 0.7: Update `createDevOidcServer` to synthesize a TenantState

**Files:**

- Modify: `src/server.ts`
- Test: existing `tests/integration/oidc-flow.test.ts`, `tests/integration/admin.test.ts`

- [ ] **Step 1: Read existing `createDevOidcServer` body**

Read `src/server.ts` end-to-end to understand the current wiring.

- [ ] **Step 2: Refactor `createDevOidcServer` to build a `TenantState` and a resolver**

```ts
// src/server.ts
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import path from 'node:path';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { createEventsEmitter, registerEventsRoute, type EventsEmitter } from '@/admin/events.js';
import { renderAdminPage } from '@/admin/page.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { watchConfig, type ConfigWatcher } from '@/config/watcher.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { registerAuthorize } from '@/oidc/authorize.js';
import { registerComplete } from '@/oidc/complete.js';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';
import { buildJwks } from '@/oidc/jwks.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { createCodeStore } from '@/oidc/codes.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { registerToken } from '@/oidc/token.js';
import { registerLogout } from '@/oidc/logout.js';
import { renderIndexPage } from '@/index/page.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

export interface CreateServerOptions {
  config: Config;
  configFilePath?: string;
  issuer: string; // injected from CLI in legacy mode (Phase 1 introduces flag)
  logger?: DevOidcLogger;
}

export interface DevOidcServer {
  app: FastifyInstance;
  tenant: ActiveTenantState;
  close: () => Promise<void>;
}

export async function createDevOidcServer(options: CreateServerOptions): Promise<DevOidcServer> {
  const logger = options.logger ?? createLogger();
  const runtime = createRuntimeConfig(options.config);
  const eventsEmitter: EventsEmitter = createEventsEmitter();
  runtime.onChange(() => eventsEmitter.emit({ type: 'config-changed', slug: '(legacy)' }));

  const configDir = options.configFilePath
    ? path.dirname(path.resolve(options.configFilePath))
    : process.cwd(); // Phase 2 will pass configDir into createKeyMaterial
  const keyMaterial = await createKeyMaterial(options.config.signingKey);
  const jwksDocument = buildJwks(keyMaterial);

  const codes = createCodeStore({
    ttlMs: 60_000,
    refreshTtlMs: options.config.refreshTokenTtlSeconds * 1_000,
  });
  const pending = createPendingAuthStore({ ttlMs: 10 * 60_000 });

  let watcher: ConfigWatcher | null = null;
  if (options.configFilePath) {
    watcher = await watchConfig(options.configFilePath, {
      onReload: (config) => {
        runtime.set(config);
        logger.info({ slug: '(legacy)' }, 'config reloaded');
      },
      onError: (err) => logger.warn({ err }, 'config reload failed; keeping previous config'),
    });
  }

  const tenant: ActiveTenantState = {
    slug: '(legacy)',
    configPath: options.configFilePath ?? '',
    status: 'active',
    config: options.config,
    runtime,
    keyMaterial,
    jwks: jwksDocument,
    codes,
    pending,
    watcher,
    issuer: options.issuer,
  };

  const getTenant = (_req: FastifyRequest): ActiveTenantState => tenant;

  const app = Fastify({ loggerInstance: logger });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(formbody);

  app.get('/.well-known/openid-configuration', async () => {
    const cfg = runtime.get();
    const hasSecretClient = cfg.clients.some((c) => c.clientSecret !== undefined);
    const authMethods: ('none' | 'client_secret_post' | 'client_secret_basic')[] = hasSecretClient
      ? ['none', 'client_secret_post', 'client_secret_basic']
      : ['none'];
    return buildDiscoveryDocument({
      issuer: tenant.issuer,
      signingAlg: keyMaterial.alg,
      authMethods,
    });
  });

  app.get('/.well-known/jwks.json', async () => jwksDocument);

  app.get('/', async (_request, reply) => {
    const adminEnabled = Boolean(options.configFilePath);
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(renderIndexPage({ tenant, adminEnabled }));
  });

  registerAuthorize(app, { getTenant });
  registerComplete(app, { getTenant });
  registerToken(app, { getTenant });
  registerLogout(app, { getTenant });

  if (options.configFilePath) {
    registerProfilesRoutes(app, { getTenant });
    registerEventsRoute(app, { emitter: eventsEmitter });
    app.get('/admin', async (_request, reply) => {
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(renderAdminPage({ config: runtime.get(), slug: '(legacy)' }));
    });
  }

  return {
    app,
    tenant,
    close: async () => {
      if (watcher) await watcher.close();
      await app.close();
    },
  };
}
```

Note: this commit introduces a few "transitional" pieces that later phases finalize:

- The `issuer` field is now required on `CreateServerOptions`. Existing tests pass it as a literal string.
- `renderIndexPage` and `renderAdminPage` signatures change to take `{ tenant, ... }` and `{ config, slug }` respectively. Update those signatures (Tasks 0.8 and 0.9).
- `eventsEmitter.emit({ type: 'config-changed', slug })` includes the slug. Update the events module too.

- [ ] **Step 3: Update `src/index/page.ts` signature**

Change from `RenderIndexPageInput { config, adminEnabled }` to `{ tenant: ActiveTenantState, adminEnabled }`. Inside, read `tenant.config` and `tenant.issuer`. Update `tests/index/page.test.ts` accordingly.

- [ ] **Step 4: Update `src/admin/page.ts` to accept `{ config, slug }`**

Add `slug` to the `renderAdminPage` input. Use it to scope form `data-api` URLs in Phase 5; for now just thread the value through with no behavioral effect (legacy slug `'(legacy)'` produces the same root URLs).

For Phase 0, simplest is: accept `slug` but keep current data-api URLs at `/admin/api/profiles[/...]`. Phase 5 will introduce slug-aware URLs.

```ts
export interface RenderAdminPageInput {
  config: Config;
  slug: string;
}

export function renderAdminPage(input: RenderAdminPageInput): string {
  // existing body; slug currently unused, will be wired in Phase 5
  void input.slug;
  // ...
}
```

Update `tests/admin/page.test.ts` to pass `{ config, slug: '(legacy)' }`.

- [ ] **Step 5: Update `src/admin/events.ts` for slug-aware events**

Change `AdminEvent` to `{ type: 'config-changed'; slug: string }`. Update `events.test.ts` to assert the slug.

- [ ] **Step 6: Update existing CLI to pass `issuer`**

Modify `src/cli.ts` to pass `issuer: config.issuer` to `createDevOidcServer`. (This temporary plumbing only exists in Phase 0 — Phase 1 removes `config.issuer` and replaces with `--public-url`.)

```ts
const server = await createDevOidcServer({
  config,
  configFilePath: values.config,
  issuer: config.issuer, // transitional; Phase 1 replaces with computed value
  logger,
});
```

- [ ] **Step 7: Run typecheck and full test suite**

Run: `npm run typecheck && npm run test`
Expected: PASS — all existing tests should still pass because `'(legacy)'` slug behaves exactly like the old single-tenant path.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/index/page.ts src/admin/page.ts src/admin/events.ts src/cli.ts tests/index/page.test.ts tests/admin/page.test.ts tests/admin/events.test.ts
git commit -m "refactor(server): wire single tenant through getTenant resolver"
```

### Task 0.8: Phase 0 verification

- [ ] **Step 1: Run the entire test suite**

Run: `npm run test`
Expected: PASS — every test green.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run linter**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Run prettier check**

Run: `npm run format:check`
Expected: PASS for tracked source files. (Untracked `skills/` may still warn — that's pre-existing.)

- [ ] **Step 5: Tag the phase**

```bash
git tag -a phase-0-handler-refactor -m "Phase 0 complete: handlers tenant-agnostic"
```

---

## Phase 1 — Project schema reduction + Legacy CLI flags

**Goal:** Drop `issuer`/`port`/`host` from `ConfigSchema`. Add `--port`, `--host`, `--public-url` flags to Legacy CLI. Update fixtures and example config.

**Phase checkpoint:** Schema rejects `issuer`/`port`/`host` with tailored messages; Legacy CLI accepts the new flags; existing oidc-flow tests pass after fixture updates.

### Task 1.1: Update schema tests for the reduction

**Files:**

- Modify: `tests/config/schema.test.ts`

- [ ] **Step 1: Replace tests that depend on the removed fields**

Open `tests/config/schema.test.ts`. Remove or replace these tests:

- "rejects when issuer is missing" — replace with "rejects when issuer is provided" (the field is no longer accepted).
- "defaults port to 8095" — DELETE.
- "defaults host to 127.0.0.1" — DELETE.

Add new tests:

```ts
it('rejects when issuer is provided (moved to hub config / legacy CLI)', () => {
  const result = ConfigSchema.safeParse({
    ...minimalValid,
    issuer: 'http://localhost:8095',
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).toMatch(/issuer no longer belongs in project config/);
  }
});

it('rejects when port is provided', () => {
  const result = ConfigSchema.safeParse({ ...minimalValid, port: 8095 });
  expect(result.success).toBe(false);
});

it('rejects when host is provided', () => {
  const result = ConfigSchema.safeParse({ ...minimalValid, host: '127.0.0.1' });
  expect(result.success).toBe(false);
});

it('accepts a minimal config without issuer/port/host', () => {
  const result = ConfigSchema.safeParse(minimalValid);
  expect(result.success).toBe(true);
});
```

Update `minimalValid` at the top of the file to no longer include `issuer`:

```ts
const minimalValid = {
  signingKey: { kid: 'k1' },
  clients: [
    {
      clientId: 'my-app',
      redirectUris: ['http://localhost:5173/auth/callback'],
      audience: 'my-api',
    },
  ],
  profiles: [{ id: 'alice', displayName: 'Alice', email: 'alice@example.com' }],
};
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: FAIL — old schema still accepts and defaults the removed fields.

- [ ] **Step 3: Update `src/config/schema.ts`**

```ts
import { z } from 'zod';

const SigningKeySchema = z.object({
  kid: z.string().min(1),
  alg: z.enum(['RS256', 'ES256']).default('RS256'),
  source: z.union([z.literal('generate'), z.string().regex(/^file:.+/)]).default('generate'),
});

const ClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  redirectUris: z.array(z.string().url()).min(1),
  postLogoutRedirectUris: z.array(z.string().url()).default([]),
  audience: z.string().min(1),
});

const BrandingInner = z.object({
  title: z.string().default('Dev OIDC Login'),
  accentColor: z.string().default('#1f6feb'),
  logoUrl: z.string().url().nullable().default(null),
});
const BrandingSchema = BrandingInner.default(BrandingInner.parse({}));

const ProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().email(),
  avatar: z.string().url().nullable().default(null),
  claims: z.record(z.string(), z.unknown()).default({}),
});

export const ConfigSchema = z
  .object({
    signingKey: SigningKeySchema,
    clients: z.array(ClientSchema).min(1),
    subjectClaim: z.string().default('sub'),
    tokenTtlSeconds: z.number().int().positive().default(900),
    refreshTokenTtlSeconds: z.number().int().positive().default(28800),
    branding: BrandingSchema,
    profiles: z.array(ProfileSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Tailored error messages for fields that USED to live here in v0.1.x.
    const obsoletePresent = value as unknown as Record<string, unknown>;
    if ('issuer' in obsoletePresent) {
      ctx.addIssue({
        code: 'custom',
        path: ['issuer'],
        message:
          'issuer no longer belongs in project config; the Hub computes it from publicUrl + slug, or pass `--public-url` for legacy mode',
      });
    }
    if ('port' in obsoletePresent) {
      ctx.addIssue({
        code: 'custom',
        path: ['port'],
        message:
          'port no longer belongs in project config; set hub.server.port in hub.json (or pass `--port` for legacy mode)',
      });
    }
    if ('host' in obsoletePresent) {
      ctx.addIssue({
        code: 'custom',
        path: ['host'],
        message:
          'host no longer belongs in project config; set hub.server.host in hub.json (or pass `--host` for legacy mode)',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Client = z.infer<typeof ClientSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type SigningKey = z.infer<typeof SigningKeySchema>;
export type Branding = z.infer<typeof BrandingSchema>;
```

Note: with `.strict()`, unknown fields raise generic Zod errors. The `superRefine` adds the _targeted_ messages so users see helpful guidance for the three removed fields, not a generic "unrecognized key" error.

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/config/schema.test.ts
git commit -m "feat(config)!: drop issuer/port/host from project schema

BREAKING CHANGE: project configs that include issuer, port, or host now
fail validation. Set listener config in ~/.config/dev-oidc/hub.json
(Hub mode) or pass --port/--host/--public-url (Legacy mode)."
```

### Task 1.2: Update example and fixture configs

**Files:**

- Modify: `examples/config.json`

- [ ] **Step 1: Strip removed fields from `examples/config.json`**

```json
{
  "signingKey": { "kid": "k1" },
  "clients": [
    {
      "clientId": "my-app",
      "redirectUris": ["http://localhost:5173/auth/callback"],
      "audience": "my-api"
    },
    {
      "clientId": "confidential-app",
      "clientSecret": "example-secret-replace-me",
      "redirectUris": ["http://localhost:5174/auth/callback"],
      "postLogoutRedirectUris": ["http://localhost:5174/"],
      "audience": "confidential-api"
    }
  ],
  "profiles": [
    {
      "id": "alice",
      "displayName": "Alice",
      "email": "alice@example.com"
    },
    {
      "id": "bob",
      "displayName": "Bob",
      "email": "bob@example.com",
      "claims": { "role": "admin" }
    }
  ]
}
```

- [ ] **Step 2: Find any test fixtures that still embed `issuer`/`port`/`host`**

Run: `grep -rn '"issuer"\|"port"\|"host"' tests/ --include='*.json' --include='*.ts' | grep -v node_modules`

Expected output: every match should be a JWT-payload `iss` field (legitimate), test data unrelated to project config, or fixture files needing updates.

- [ ] **Step 3: Update integration test fixtures**

In `tests/integration/oidc-flow.test.ts`, the inline `config` object embeds `issuer`/`port`/`host`. Remove those three lines:

```ts
const config: Config = {
  // issuer: 'http://localhost:8095',  // REMOVE
  // port: 0,                           // REMOVE
  // host: '127.0.0.1',                 // REMOVE
  signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
  // ... rest unchanged
};
```

The test creates the server with `createDevOidcServer({ config, issuer: 'http://localhost:8095' })` — pass `issuer` explicitly.

Repeat for `tests/integration/admin.test.ts` and `tests/integration/contract.test.ts`.

- [ ] **Step 4: Run integration tests**

Run: `npx vitest run tests/integration/`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/config.json tests/integration/oidc-flow.test.ts tests/integration/admin.test.ts tests/integration/contract.test.ts
git commit -m "test(integration): drop issuer/port/host from test fixtures"
```

### Task 1.3: Add `--port`/`--host`/`--public-url` to Legacy CLI

**Files:**

- Create: `src/cli/legacy.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Factor Legacy-mode startup into `src/cli/legacy.ts`**

```ts
// src/cli/legacy.ts
import { loadConfig } from '@/config/loader.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';

export interface LegacyStartOptions {
  configPath: string;
  port: number;
  host: string;
  publicUrl?: string;
  logger?: DevOidcLogger;
}

export interface LegacyStartResult {
  server: DevOidcServer;
  port: number;
  host: string;
  issuer: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function startLegacy(options: LegacyStartOptions): Promise<LegacyStartResult> {
  const logger = options.logger ?? createLogger();
  const config = await loadConfig(options.configPath);
  const issuer = stripTrailingSlash(options.publicUrl ?? `http://${options.host}:${options.port}`);
  const server = await createDevOidcServer({
    config,
    configFilePath: options.configPath,
    issuer,
    logger,
  });
  await server.app.listen({ port: options.port, host: options.host });
  return { server, port: options.port, host: options.host, issuer };
}
```

- [ ] **Step 2: Rewrite `src/cli.ts` to dispatch sub-commands and parse new flags**

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startLegacy } from '@/cli/legacy.js';
import { createLogger } from '@/logger.js';

const HELP = [
  'dev-oidc — a minimal OIDC provider for local development',
  '',
  'Usage:',
  '  dev-oidc start [--config <path>] [options]',
  '  dev-oidc register <project-config-path> [--slug <name>]',
  '  dev-oidc unregister <slug>',
  '  dev-oidc list [--json]',
  '',
  'Options for `start --config`:',
  '  -c, --config <path>      Path to a project config (legacy single-tenant mode).',
  '      --port <number>      Listen port (default 8095).',
  '      --host <ip>          Listen host (default 127.0.0.1).',
  '      --public-url <url>   Issuer URL advertised in discovery (default http://host:port).',
  '',
  'Hub options (run without --config):',
  '      --hub-config <path>  Hub config path (default ~/.config/dev-oidc/hub.json).',
  '',
  '  -h, --help               Show this help.',
  '',
].join('\n');

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      port: { type: 'string' },
      host: { type: 'string' },
      'public-url': { type: 'string' },
      'hub-config': { type: 'string' },
      slug: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const subcommand = positionals[0];

  switch (subcommand) {
    case 'start':
      await runStart(values, positionals);
      break;
    // Phase 4 wires `register`/`unregister`/`list` here. Stub for now:
    case 'register':
    case 'unregister':
    case 'list':
      process.stderr.write(`dev-oidc: ${subcommand} not yet implemented\n`);
      process.exit(2);
      break;
    default:
      process.stdout.write(HELP);
      process.exit(1);
  }
}

async function runStart(
  values: Record<string, string | boolean | undefined>,
  _positionals: string[],
): Promise<void> {
  const logger = createLogger();
  if (values.config) {
    if (typeof values.config !== 'string') {
      process.stderr.write('dev-oidc: --config requires a path\n');
      process.exit(1);
    }
    const port = Number.parseInt((values.port as string) ?? '8095', 10);
    const host = (values.host as string) ?? '127.0.0.1';
    const publicUrl = values['public-url'] as string | undefined;
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
      process.stderr.write('dev-oidc: --port must be a valid port number\n');
      process.exit(1);
    }
    const result = await startLegacy({
      configPath: values.config,
      port,
      host,
      publicUrl: typeof publicUrl === 'string' ? publicUrl : undefined,
      logger,
    });
    logger.info(
      { issuer: result.issuer, port: result.port, host: result.host },
      'dev-oidc listening (legacy)',
    );
    setupShutdown(result.server.close, logger);
    return;
  }

  // Phase 3 wires Hub-mode startup here.
  process.stderr.write(
    'dev-oidc: Hub mode not yet implemented; pass `--config <path>` for legacy mode\n',
  );
  process.exit(2);
}

function setupShutdown(close: () => Promise<void>, logger: ReturnType<typeof createLogger>): void {
  const shutdown = async (): Promise<void> => {
    logger.info('dev-oidc shutting down');
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  const logger = createLogger();
  logger.error({ err }, 'dev-oidc failed to start');
  process.exit(1);
});
```

Note the `(values.port as string) ?? '8095'` pattern — `parseArgs` returns string-typed values for `type: 'string'`, even though we want them as numbers. Convert at use.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Run: `npx tsx src/cli.ts start --config ./examples/config.json --port 8096`
Expected: server starts, logs `issuer: http://127.0.0.1:8096`, listens on 127.0.0.1:8096.
Stop with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli/legacy.ts
git commit -m "feat(cli): legacy mode flags --port --host --public-url"
```

### Task 1.4: Phase 1 verification

- [ ] **Step 1: Full test suite + typecheck + lint**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 2: Tag the phase**

```bash
git tag -a phase-1-schema-reduction -m "Phase 1 complete: project schema reduced; legacy CLI flags"
```

---

## Phase 2 — Signing-key path resolution

**Goal:** `createKeyMaterial` resolves relative `file:` paths against the project config's directory rather than CWD.

**Phase checkpoint:** New tests for relative-path resolution pass; existing absolute-path tests still pass.

### Task 2.1: Add `configDir` parameter to `createKeyMaterial`

**Files:**

- Modify: `src/oidc/keys.ts`
- Test: `tests/oidc/keys.test.ts`

- [ ] **Step 1: Add new test for relative-path resolution**

In `tests/oidc/keys.test.ts`, add a new `describe` block:

```ts
import { mkdirSync } from 'node:fs';

describe('createKeyMaterial (configDir resolution)', () => {
  it('resolves a relative file: path against configDir', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cfgdir-'));
    mkdirSync(path.join(configDir, 'keys'));
    const km = await createKeyMaterial(
      { kid: 'rel', alg: 'RS256', source: 'file:keys/k1.json' },
      { configDir },
    );

    const absoluteExpected = path.join(configDir, 'keys', 'k1.json');
    expect(existsSync(absoluteExpected)).toBe(true);
    expect(km.kid).toBe('rel');
  });

  it('uses an absolute file: path verbatim regardless of configDir', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cfgdir-'));
    const keyDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-keys-'));
    const absoluteKey = path.join(keyDir, 'abs.json');

    await createKeyMaterial(
      { kid: 'abs', alg: 'RS256', source: `file:${absoluteKey}` },
      { configDir },
    );

    expect(existsSync(absoluteKey)).toBe(true);
  });

  it('falls back to CWD-relative when configDir is omitted', async () => {
    // Backwards-compat: tests that don't pass configDir should still work
    // because the implementation defaults configDir to process.cwd().
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cwd-'));
    const file = path.join(tmpDir, 'cwd-fallback.json');
    await createKeyMaterial({ kid: 'cwd', alg: 'RS256', source: `file:${file}` });
    expect(existsSync(file)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/oidc/keys.test.ts`
Expected: FAIL — `createKeyMaterial` does not accept a second argument.

- [ ] **Step 3: Update `src/oidc/keys.ts`**

```ts
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as jose from 'jose';
import type { SigningKey } from '@/config/schema.js';

export type SigningAlg = 'RS256' | 'ES256';

export interface KeyMaterial {
  kid: string;
  alg: SigningAlg;
  privateKey: jose.KeyLike;
  publicJwk: jose.JWK;
}

export interface CreateKeyMaterialOptions {
  configDir?: string;
}

export async function createKeyMaterial(
  config: SigningKey,
  options: CreateKeyMaterialOptions = {},
): Promise<KeyMaterial> {
  if (config.source === 'generate') {
    return generateEphemeralKey(config.kid, config.alg);
  }

  const rawPath = config.source.slice('file:'.length);
  const configDir = options.configDir ?? process.cwd();
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(configDir, rawPath);

  const existing = await loadKeyFromFile(filePath, config.kid, config.alg);
  if (existing) return existing;
  const generated = await generateEphemeralKey(config.kid, config.alg);
  await saveKeyToFile(filePath, generated);
  return generated;
}

// ... rest of the file unchanged
```

- [ ] **Step 4: Update callers in `src/server.ts`**

```ts
const configDir = options.configFilePath
  ? path.dirname(path.resolve(options.configFilePath))
  : process.cwd();
const keyMaterial = await createKeyMaterial(options.config.signingKey, { configDir });
```

(This call site already exists from Phase 0; the change is adding the `{ configDir }` argument.)

- [ ] **Step 5: Run tests — should pass**

Run: `npx vitest run tests/oidc/keys.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/oidc/keys.ts tests/oidc/keys.test.ts src/server.ts
git commit -m "feat(keys)!: resolve relative file: paths against project configDir

BREAKING CHANGE: previously, a relative signingKey.source path was
resolved against process.cwd(). It is now resolved against the project
config file's directory. Absolute paths are unchanged. Users running
dev-oidc from a non-project CWD with a relative signingKey path must
either move to the project root or use an absolute path."
```

### Task 2.2: Phase 2 verification

- [ ] **Step 1: Tests + typecheck + lint**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 2: Tag**

```bash
git tag -a phase-2-key-paths -m "Phase 2 complete: signing-key paths resolve against configDir"
```

---

## Phase 3 — Hub config + TenantRegistry + Hub server

**Goal:** Land the multi-tenant infrastructure: `hub.json` schema, loader with auto-create, `TenantRegistry` with per-tenant activation, watcher that reconciles, and `createHubServer` that mounts OIDC routes under `/:slug/...`. CLI `start` defaults to Hub mode.

**Phase checkpoint:** Hub-mode integration tests pass: full auth-code flow under Hub mode, cross-tenant isolation, dynamic register/unregister.

### Task 3.1: Hub config schema

**Files:**

- Create: `src/hub/schema.ts`
- Test: `tests/hub/schema.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, expect, it } from 'vitest';
import { HubConfigSchema, RESERVED_SLUGS, isReservedSlug } from '@/hub/schema.js';

describe('HubConfigSchema', () => {
  const validBase = {
    version: '1' as const,
    server: { port: 8095, host: '127.0.0.1' },
    tenants: [],
  };

  it('accepts an empty hub config', () => {
    const result = HubConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('defaults version to "1" when omitted', () => {
    const result = HubConfigSchema.safeParse({ server: validBase.server, tenants: [] });
    if (!result.success) throw result.error;
    expect(result.data.version).toBe('1');
  });

  it('defaults server.port to 8095 and host to 127.0.0.1', () => {
    const result = HubConfigSchema.safeParse({ version: '1', server: {}, tenants: [] });
    if (!result.success) throw result.error;
    expect(result.data.server.port).toBe(8095);
    expect(result.data.server.host).toBe('127.0.0.1');
  });

  it('rejects an unknown version', () => {
    const result = HubConfigSchema.safeParse({ ...validBase, version: '2' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid tenant entry', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'my-app', configPath: '/tmp/dev-oidc.config.json', enabled: true }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a slug with uppercase letters', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'My-App', configPath: '/tmp/c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slug starting with a hyphen', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: '-app', configPath: '/tmp/c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slug ending with a hyphen', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'app-', configPath: '/tmp/c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slug longer than 64 chars', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'a'.repeat(65), configPath: '/tmp/c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it.each(['admin', 'api', '.well-known', '_internal', '.dotfile'])(
    'rejects reserved slug %s',
    (slug) => {
      const result = HubConfigSchema.safeParse({
        ...validBase,
        tenants: [{ slug, configPath: '/tmp/c.json', enabled: true }],
      });
      expect(result.success).toBe(false);
    },
  );

  it('rejects a relative configPath', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'app', configPath: './c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it('defaults enabled to true', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'app', configPath: '/tmp/c.json' }],
    });
    if (!result.success) throw result.error;
    expect(result.data.tenants[0]!.enabled).toBe(true);
  });

  it('rejects duplicate slugs in tenants array', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [
        { slug: 'app', configPath: '/tmp/a.json', enabled: true },
        { slug: 'app', configPath: '/tmp/b.json', enabled: true },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('exports isReservedSlug', () => {
    expect(isReservedSlug('admin')).toBe(true);
    expect(isReservedSlug('my-app')).toBe(false);
  });

  it('exports RESERVED_SLUGS', () => {
    expect(RESERVED_SLUGS).toContain('admin');
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/hub/schema.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/hub/schema.ts`**

```ts
import path from 'node:path';
import { z } from 'zod';

export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const RESERVED_SLUGS: readonly string[] = [
  'admin',
  'api',
  '.well-known',
  '_health',
  '_internal',
  'static',
];

export function isReservedSlug(slug: string): boolean {
  if (RESERVED_SLUGS.includes(slug)) return true;
  if (slug.startsWith('_') || slug.startsWith('.')) return true;
  return false;
}

const SlugSchema = z
  .string()
  .regex(SLUG_REGEX, 'slug must match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$')
  .refine((s) => !isReservedSlug(s), { message: 'slug is reserved' });

const TenantEntrySchema = z.object({
  slug: SlugSchema,
  configPath: z
    .string()
    .min(1)
    .refine((p) => path.isAbsolute(p), { message: 'configPath must be absolute' }),
  enabled: z.boolean().default(true),
});

const ServerSchema = z.object({
  port: z.number().int().positive().default(8095),
  host: z.string().default('127.0.0.1'),
  publicUrl: z.string().url().optional(),
});

export const HubConfigSchema = z
  .object({
    version: z.literal('1').default('1'),
    server: ServerSchema.default({ port: 8095, host: '127.0.0.1' }),
    tenants: z.array(TenantEntrySchema).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [i, t] of value.tenants.entries()) {
      if (seen.has(t.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tenants', i, 'slug'],
          message: `duplicate slug "${t.slug}"`,
        });
      }
      seen.add(t.slug);
    }
  });

export type HubConfig = z.infer<typeof HubConfigSchema>;
export type HubTenantEntry = z.infer<typeof TenantEntrySchema>;
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/hub/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hub/schema.ts tests/hub/schema.test.ts
git commit -m "feat(hub): hub config schema with slug regex and reserved list"
```

### Task 3.2: Hub config loader with auto-create

**Files:**

- Create: `src/hub/loader.ts`
- Test: `tests/hub/loader.test.ts`

- [ ] **Step 1: Write the loader tests**

```ts
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultHubConfigPath, loadHubConfig, saveHubConfig } from '@/hub/loader.js';

describe('defaultHubConfigPath', () => {
  it('honors XDG_CONFIG_HOME when set', () => {
    const orig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/custom/xdg';
    try {
      expect(defaultHubConfigPath()).toBe('/custom/xdg/dev-oidc/hub.json');
    } finally {
      if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = orig;
    }
  });

  it('falls back to ~/.config/dev-oidc/hub.json', () => {
    const orig = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(defaultHubConfigPath()).toMatch(/\/\.config\/dev-oidc\/hub\.json$/);
    } finally {
      if (orig !== undefined) process.env.XDG_CONFIG_HOME = orig;
    }
  });
});

describe('loadHubConfig', () => {
  it('auto-creates an empty hub config when the file does not exist', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    expect(existsSync(filePath)).toBe(false);

    const config = await loadHubConfig(filePath);

    expect(existsSync(filePath)).toBe(true);
    expect(config.version).toBe('1');
    expect(config.tenants).toEqual([]);
    expect(config.server.port).toBe(8095);
    expect(config.server.host).toBe('127.0.0.1');
  });

  it('writes the bootstrap with mode 0600', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');

    await loadHubConfig(filePath);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reads an existing valid hub config', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: '1',
        server: { port: 9090, host: '0.0.0.0' },
        tenants: [{ slug: 'app', configPath: '/tmp/c.json', enabled: true }],
      }),
    );

    const config = await loadHubConfig(filePath);
    expect(config.server.port).toBe(9090);
    expect(config.tenants).toHaveLength(1);
    expect(config.tenants[0]!.slug).toBe('app');
  });

  it('throws when an existing file is invalid JSON', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(filePath, 'not json');

    await expect(loadHubConfig(filePath)).rejects.toThrow(/invalid JSON/);
  });

  it('throws when an existing file fails Zod validation', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: '2', // bad version
        server: { port: 8095, host: '127.0.0.1' },
        tenants: [],
      }),
    );

    await expect(loadHubConfig(filePath)).rejects.toThrow(/validation/);
  });
});

describe('saveHubConfig', () => {
  it('atomic-writes the hub config (tmp + rename)', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    await loadHubConfig(filePath); // create initial

    const updated = {
      version: '1' as const,
      server: { port: 9000, host: '127.0.0.1' },
      tenants: [],
    };
    await saveHubConfig(filePath, updated);
    const reread = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(reread.server.port).toBe(9000);
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/hub/loader.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/hub/loader.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { HubConfigSchema, type HubConfig } from '@/hub/schema.js';

export function defaultHubConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'dev-oidc', 'hub.json');
  return path.join(homedir(), '.config', 'dev-oidc', 'hub.json');
}

const BOOTSTRAP: HubConfig = {
  version: '1',
  server: { port: 8095, host: '127.0.0.1' },
  tenants: [],
};

export async function loadHubConfig(filePath: string): Promise<HubConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      await saveHubConfig(filePath, BOOTSTRAP);
      return BOOTSTRAP;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`dev-oidc: invalid JSON in hub config ${filePath}: ${message}`);
  }

  const result = HubConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`dev-oidc: hub config validation failed:\n${result.error.message}`);
  }
  return result.data;
}

export async function saveHubConfig(filePath: string, config: HubConfig): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, filePath);
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/hub/loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hub/loader.ts tests/hub/loader.test.ts
git commit -m "feat(hub): loader with auto-create and atomic save"
```

### Task 3.3: Issuer derivation helper

**Files:**

- Create: `src/hub/issuer.ts`
- Test: `tests/hub/issuer.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest';
import { computeIssuer, deriveDefaultPublicUrl } from '@/hub/issuer.js';

describe('computeIssuer', () => {
  it('joins publicUrl and slug with a single slash', () => {
    expect(computeIssuer({ publicUrl: 'http://localhost:8095', slug: 'app' })).toBe(
      'http://localhost:8095/app',
    );
  });

  it('strips a trailing slash on publicUrl', () => {
    expect(computeIssuer({ publicUrl: 'http://localhost:8095/', slug: 'app' })).toBe(
      'http://localhost:8095/app',
    );
  });

  it('strips multiple trailing slashes', () => {
    expect(computeIssuer({ publicUrl: 'http://localhost:8095///', slug: 'app' })).toBe(
      'http://localhost:8095/app',
    );
  });

  it('preserves a path component on publicUrl', () => {
    expect(computeIssuer({ publicUrl: 'https://idp.example.com/oidc', slug: 'app' })).toBe(
      'https://idp.example.com/oidc/app',
    );
  });
});

describe('deriveDefaultPublicUrl', () => {
  it('returns http://host:port', () => {
    expect(deriveDefaultPublicUrl({ host: '127.0.0.1', port: 8095 })).toBe('http://127.0.0.1:8095');
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/hub/issuer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/hub/issuer.ts`**

```ts
export function computeIssuer(input: { publicUrl: string; slug: string }): string {
  const stripped = input.publicUrl.replace(/\/+$/, '');
  return `${stripped}/${input.slug}`;
}

export function deriveDefaultPublicUrl(input: { host: string; port: number }): string {
  return `http://${input.host}:${input.port}`;
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/hub/issuer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hub/issuer.ts tests/hub/issuer.test.ts
git commit -m "feat(hub): issuer derivation helper"
```

### Task 3.4: TenantRegistry — basic add/get/remove

**Files:**

- Create: `src/hub/registry.ts`
- Test: `tests/hub/registry.test.ts`

- [ ] **Step 1: Write the first batch of tests (add/get/remove + activation)**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTenantRegistry } from '@/hub/registry.js';

function tmpProjectConfig(overrides: Partial<{ kid: string; clients: unknown }> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-proj-'));
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: overrides.kid ?? 'k1', alg: 'RS256', source: 'generate' },
      clients: overrides.clients ?? [
        {
          clientId: 'my-app',
          redirectUris: ['http://localhost:5173/cb'],
          audience: 'my-api',
        },
      ],
      profiles: [],
    }),
  );
  return file;
}

describe('TenantRegistry', () => {
  it('starts empty', () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    expect(reg.list()).toEqual([]);
    expect(reg.get('app')).toBeUndefined();
  });

  it('activates a valid tenant on add', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const cfgPath = tmpProjectConfig();

    await reg.add({ slug: 'app', configPath: cfgPath, enabled: true });

    const tenant = reg.get('app');
    expect(tenant?.status).toBe('active');
    expect(tenant?.slug).toBe('app');
    if (tenant?.status === 'active') {
      expect(tenant.issuer).toBe('http://localhost:8095/app');
      expect(tenant.config.clients[0]!.clientId).toBe('my-app');
    }
  });

  it('places a tenant in error state when its config is invalid JSON', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const cfgPath = path.join(dir, 'bad.json');
    writeFileSync(cfgPath, 'not valid json');

    await reg.add({ slug: 'broken', configPath: cfgPath, enabled: true });

    const tenant = reg.get('broken');
    expect(tenant?.status).toBe('error');
    if (tenant?.status === 'error') {
      expect(tenant.lastError).toMatch(/invalid JSON|JSON/);
    }
  });

  it('places a tenant in error state when its config fails Zod validation', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const cfgPath = path.join(dir, 'bad.json');
    writeFileSync(cfgPath, JSON.stringify({ signingKey: { kid: 'k' }, clients: [] }));

    await reg.add({ slug: 'broken', configPath: cfgPath, enabled: true });

    const tenant = reg.get('broken');
    expect(tenant?.status).toBe('error');
  });

  it('removes a tenant', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    await reg.add({ slug: 'app', configPath: tmpProjectConfig(), enabled: true });
    await reg.remove('app');
    expect(reg.get('app')).toBeUndefined();
  });

  it('add is idempotent: existing slug is replaced', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const first = tmpProjectConfig({ kid: 'first' });
    const second = tmpProjectConfig({ kid: 'second' });

    await reg.add({ slug: 'app', configPath: first, enabled: true });
    await reg.add({ slug: 'app', configPath: second, enabled: true });

    const tenant = reg.get('app');
    if (tenant?.status === 'active') {
      expect(tenant.keyMaterial.kid).toBe('second');
    } else {
      throw new Error('expected active');
    }
  });

  it('skips disabled tenants on add (does not activate, does not store)', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    await reg.add({ slug: 'app', configPath: tmpProjectConfig(), enabled: false });
    expect(reg.get('app')).toBeUndefined();
  });
});

describe('TenantRegistry.reconcile', () => {
  it('adds new entries, removes missing entries, replaces changed configPath', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const cfgA = tmpProjectConfig({ kid: 'a' });
    const cfgB = tmpProjectConfig({ kid: 'b' });
    const cfgC = tmpProjectConfig({ kid: 'c' });

    await reg.reconcile([
      { slug: 'a', configPath: cfgA, enabled: true },
      { slug: 'b', configPath: cfgB, enabled: true },
    ]);
    expect(reg.list()).toHaveLength(2);

    // Remove b, keep a, add c
    await reg.reconcile([
      { slug: 'a', configPath: cfgA, enabled: true },
      { slug: 'c', configPath: cfgC, enabled: true },
    ]);
    expect(reg.get('a')?.status).toBe('active');
    expect(reg.get('b')).toBeUndefined();
    expect(reg.get('c')?.status).toBe('active');
  });
});

describe('TenantRegistry events', () => {
  it('emits added on activation', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const events: string[] = [];
    reg.events.on('added', ({ slug }) => events.push(`added:${slug}`));

    await reg.add({ slug: 'app', configPath: tmpProjectConfig(), enabled: true });
    expect(events).toContain('added:app');
  });

  it('emits removed on remove', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const events: string[] = [];
    reg.events.on('removed', ({ slug }) => events.push(`removed:${slug}`));

    await reg.add({ slug: 'app', configPath: tmpProjectConfig(), enabled: true });
    await reg.remove('app');
    expect(events).toContain('removed:app');
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/hub/registry.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/hub/registry.ts`**

```ts
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { loadConfig } from '@/config/loader.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { watchConfig, type ConfigWatcher } from '@/config/watcher.js';
import { createCodeStore } from '@/oidc/codes.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { buildJwks } from '@/oidc/jwks.js';
import type { HubTenantEntry } from '@/hub/schema.js';
import type { ActiveTenantState, ErrorTenantState, TenantState } from '@/hub/tenant-state.js';
import { computeIssuer } from '@/hub/issuer.js';

export interface TenantRegistryEvents {
  on(event: 'added', listener: (payload: { slug: string }) => void): this;
  on(event: 'removed', listener: (payload: { slug: string }) => void): this;
  on(event: 'statusChanged', listener: (payload: { slug: string; status: string }) => void): this;
  on(event: 'profilesChanged', listener: (payload: { slug: string }) => void): this;
  emit(event: string, payload: { slug: string; status?: string }): boolean;
}

export interface TenantRegistry {
  list(): readonly TenantState[];
  get(slug: string): TenantState | undefined;
  add(entry: HubTenantEntry): Promise<void>;
  remove(slug: string): Promise<void>;
  reconcile(entries: readonly HubTenantEntry[]): Promise<void>;
  events: TenantRegistryEvents;
  closeAll(): Promise<void>;
}

export interface CreateTenantRegistryOptions {
  publicUrl: string;
}

export function createTenantRegistry(options: CreateTenantRegistryOptions): TenantRegistry {
  const tenants = new Map<string, TenantState>();
  const events = new EventEmitter() as TenantRegistryEvents;

  async function activate(entry: HubTenantEntry): Promise<TenantState> {
    const configDir = path.dirname(entry.configPath);
    let config;
    try {
      config = await loadConfig(entry.configPath);
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err);
      const errorState: ErrorTenantState = {
        slug: entry.slug,
        configPath: entry.configPath,
        status: 'error',
        lastError,
      };
      return errorState;
    }

    let keyMaterial;
    try {
      keyMaterial = await createKeyMaterial(config.signingKey, { configDir });
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err);
      return {
        slug: entry.slug,
        configPath: entry.configPath,
        status: 'error',
        lastError,
      };
    }

    const runtime = createRuntimeConfig(config);
    const codes = createCodeStore({
      ttlMs: 60_000,
      refreshTtlMs: config.refreshTokenTtlSeconds * 1_000,
    });
    const pending = createPendingAuthStore({ ttlMs: 10 * 60_000 });
    const jwks = buildJwks(keyMaterial);
    const issuer = computeIssuer({ publicUrl: options.publicUrl, slug: entry.slug });

    let watcher: ConfigWatcher | null = null;
    try {
      watcher = await watchConfig(entry.configPath, {
        onReload: (newConfig) => {
          runtime.set(newConfig);
          events.emit('profilesChanged', { slug: entry.slug });
        },
        onError: () => {
          // Keep last good config; logged elsewhere.
        },
      });
    } catch {
      // Watcher failure is not fatal; log handled at server level.
    }

    runtime.onChange(() => events.emit('profilesChanged', { slug: entry.slug }));

    const active: ActiveTenantState = {
      slug: entry.slug,
      configPath: entry.configPath,
      status: 'active',
      config,
      runtime,
      keyMaterial,
      jwks,
      codes,
      pending,
      watcher,
      issuer,
    };
    return active;
  }

  async function deactivate(state: TenantState): Promise<void> {
    if (state.status === 'active' && state.watcher) {
      await state.watcher.close();
    }
  }

  return {
    list: () => [...tenants.values()],
    get: (slug) => tenants.get(slug),
    events,
    async add(entry) {
      if (!entry.enabled) return;
      const existing = tenants.get(entry.slug);
      if (existing) await deactivate(existing);
      const state = await activate(entry);
      tenants.set(entry.slug, state);
      events.emit('added', { slug: entry.slug });
      events.emit('statusChanged', { slug: entry.slug, status: state.status });
    },
    async remove(slug) {
      const existing = tenants.get(slug);
      if (!existing) return;
      await deactivate(existing);
      tenants.delete(slug);
      events.emit('removed', { slug });
    },
    async reconcile(entries) {
      const incomingEnabled = entries.filter((e) => e.enabled);
      const incomingSlugs = new Set(incomingEnabled.map((e) => e.slug));

      // Remove tenants no longer in the list (or now disabled).
      for (const slug of [...tenants.keys()]) {
        if (!incomingSlugs.has(slug)) {
          await this.remove(slug);
        }
      }

      // Add or refresh remaining entries.
      for (const entry of incomingEnabled) {
        const existing = tenants.get(entry.slug);
        if (!existing || existing.configPath !== entry.configPath) {
          await this.add(entry);
        }
      }
    },
    async closeAll() {
      for (const state of tenants.values()) {
        await deactivate(state);
      }
      tenants.clear();
    },
  };
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/hub/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hub/registry.ts tests/hub/registry.test.ts
git commit -m "feat(hub): tenant registry with activation, reconcile, events"
```

### Task 3.5: hub.json watcher

**Files:**

- Create: `src/hub/watcher.ts`
- Test: `tests/hub/watcher.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { watchHubConfig } from '@/hub/watcher.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('watchHubConfig', () => {
  it('triggers onReload when the file changes', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hubw-'));
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(
      filePath,
      JSON.stringify({ version: '1', server: { port: 8095, host: '127.0.0.1' }, tenants: [] }),
    );

    const reloads: number[] = [];
    const watcher = await watchHubConfig(filePath, {
      debounceMs: 50,
      onReload: (cfg) => reloads.push(cfg.tenants.length),
      onError: () => {},
    });

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          version: '1',
          server: { port: 8095, host: '127.0.0.1' },
          tenants: [{ slug: 'app', configPath: '/tmp/c.json', enabled: true }],
        }),
      );
      await sleep(300);
      expect(reloads.at(-1)).toBe(1);
    } finally {
      await watcher.close();
    }
  });

  it('reports error on invalid JSON without crashing', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hubw-'));
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(
      filePath,
      JSON.stringify({ version: '1', server: { port: 8095, host: '127.0.0.1' }, tenants: [] }),
    );

    const errors: Error[] = [];
    const watcher = await watchHubConfig(filePath, {
      debounceMs: 50,
      onReload: () => {},
      onError: (err) => errors.push(err),
    });

    try {
      await writeFile(filePath, 'not json');
      await sleep(300);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await watcher.close();
    }
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/hub/watcher.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/hub/watcher.ts`**

```ts
import chokidar, { type FSWatcher } from 'chokidar';
import { loadHubConfig } from '@/hub/loader.js';
import type { HubConfig } from '@/hub/schema.js';

export interface WatchHubOptions {
  onReload: (config: HubConfig) => void;
  onError: (error: Error) => void;
  debounceMs?: number;
}

export interface HubConfigWatcher {
  close: () => Promise<void>;
}

export async function watchHubConfig(
  filePath: string,
  options: WatchHubOptions,
): Promise<HubConfigWatcher> {
  const debounceMs = options.debounceMs ?? 200;
  const watcher: FSWatcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });

  let timer: NodeJS.Timeout | null = null;

  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      loadHubConfig(filePath)
        .then(options.onReload)
        .catch((err: unknown) =>
          options.onError(err instanceof Error ? err : new Error(String(err))),
        );
    }, debounceMs);
  };

  watcher.on('change', trigger);
  watcher.on('add', trigger);
  watcher.on('error', (err) =>
    options.onError(err instanceof Error ? err : new Error(String(err))),
  );

  await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/hub/watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hub/watcher.ts tests/hub/watcher.test.ts
git commit -m "feat(hub): hub.json watcher with debounced reload"
```

### Task 3.6: Hub server with `/:slug/...` routes and pre-handler

**Files:**

- Create: `src/hub/server.ts`
- Test: `tests/integration/hub-flow.test.ts`

- [ ] **Step 1: Write the integration test for full Hub-mode auth-code flow**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import { createHubServer } from '@/hub/server.js';

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function tmpProjectConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
      clients: [
        {
          clientId: 'my-app',
          redirectUris: ['http://localhost:5173/cb'],
          audience: 'my-api',
        },
      ],
      profiles: [{ id: 'bob', displayName: 'Bob', email: 'bob@example.com' }],
    }),
  );
  return file;
}

function tmpHubConfig(tenants: Array<{ slug: string; configPath: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hubcfg-'));
  const file = path.join(dir, 'hub.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
      tenants: tenants.map((t) => ({ ...t, enabled: true })),
    }),
  );
  return file;
}

describe('integration: hub mode auth-code flow', () => {
  it('mints a verifiable token namespaced under the tenant slug', async () => {
    const cfg = tmpProjectConfig();
    const hubCfg = tmpHubConfig([{ slug: 'app', configPath: cfg }]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const { verifier, challenge } = pkcePair();

      const authRes = await server.app.inject({
        method: 'GET',
        url:
          '/app/authorize?' +
          new URLSearchParams({
            client_id: 'my-app',
            redirect_uri: 'http://localhost:5173/cb',
            response_type: 'code',
            scope: 'openid',
            state: 's',
            code_challenge: challenge,
            code_challenge_method: 'S256',
          }).toString(),
      });
      expect(authRes.statusCode).toBe(200);
      const pendingId = authRes.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1];

      const completeRes = await server.app.inject({
        method: 'POST',
        url: '/app/authorize/complete',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `pendingAuthId=${pendingId}&profileId=bob`,
      });
      expect(completeRes.statusCode).toBe(302);
      const code = new URL(completeRes.headers.location as string).searchParams.get('code')!;

      const tokenRes = await server.app.inject({
        method: 'POST',
        url: '/app/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'my-app',
          redirect_uri: 'http://localhost:5173/cb',
        }).toString(),
      });
      expect(tokenRes.statusCode).toBe(200);
      const tokens = tokenRes.json() as { access_token: string };

      const jwksRes = await server.app.inject({ method: 'GET', url: '/app/.well-known/jwks.json' });
      const jwksBody = jwksRes.json() as { keys: jose.JWK[] };
      const pubKey = await jose.importJWK(jwksBody.keys[0]!, 'RS256');

      const { payload } = await jose.jwtVerify(tokens.access_token, pubKey, {
        issuer: 'http://localhost:8095/app',
        audience: 'my-api',
      });
      expect(payload.sub).toBe('bob');
    } finally {
      await server.close();
    }
  });

  it('returns 404 for unknown slug', async () => {
    const hubCfg = tmpHubConfig([]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/no-such-slug/.well-known/openid-configuration',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('returns 503 for an error-state tenant', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const badCfg = path.join(dir, 'bad.json');
    writeFileSync(badCfg, 'not json');
    const hubCfg = tmpHubConfig([{ slug: 'broken', configPath: badCfg }]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/broken/.well-known/openid-configuration',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string };
      expect(body.error).toBe('service_unavailable');
    } finally {
      await server.close();
    }
  });

  it('rejects a malformed slug with 404', async () => {
    const hubCfg = tmpHubConfig([]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/SOME-UPPERCASE/.well-known/openid-configuration',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/integration/hub-flow.test.ts`
Expected: FAIL — `createHubServer` doesn't exist.

- [ ] **Step 3: Create `src/hub/server.ts`**

```ts
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { loadHubConfig } from '@/hub/loader.js';
import { watchHubConfig, type HubConfigWatcher } from '@/hub/watcher.js';
import { createTenantRegistry, type TenantRegistry } from '@/hub/registry.js';
import { deriveDefaultPublicUrl } from '@/hub/issuer.js';
import { SLUG_REGEX, type HubConfig } from '@/hub/schema.js';
import type { ActiveTenantState, TenantState } from '@/hub/tenant-state.js';
import { registerAuthorize } from '@/oidc/authorize.js';
import { registerComplete } from '@/oidc/complete.js';
import { registerToken } from '@/oidc/token.js';
import { registerLogout } from '@/oidc/logout.js';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';

export interface CreateHubServerOptions {
  hubConfigPath: string;
  logger?: DevOidcLogger;
}

export interface HubServer {
  app: FastifyInstance;
  registry: TenantRegistry;
  hubConfig: HubConfig;
  close: () => Promise<void>;
}

interface HubRequest extends FastifyRequest {
  params: { slug: string };
}

function resolveTenant(
  registry: TenantRegistry,
  slug: string,
):
  | { kind: 'ok'; tenant: ActiveTenantState }
  | { kind: 'not-found' }
  | { kind: 'error'; tenant: TenantState } {
  if (!SLUG_REGEX.test(slug)) return { kind: 'not-found' };
  const tenant = registry.get(slug);
  if (!tenant) return { kind: 'not-found' };
  if (tenant.status === 'error') return { kind: 'error', tenant };
  return { kind: 'ok', tenant };
}

export async function createHubServer(options: CreateHubServerOptions): Promise<HubServer> {
  const logger = options.logger ?? createLogger();
  const hubConfig = await loadHubConfig(options.hubConfigPath);
  const publicUrl =
    hubConfig.server.publicUrl ??
    deriveDefaultPublicUrl({ host: hubConfig.server.host, port: hubConfig.server.port });

  const registry = createTenantRegistry({ publicUrl });
  await registry.reconcile(hubConfig.tenants);

  const watcher: HubConfigWatcher = await watchHubConfig(options.hubConfigPath, {
    onReload: (cfg) => {
      registry.reconcile(cfg.tenants).catch((err) => logger.warn({ err }, 'reconcile failed'));
    },
    onError: (err) => logger.warn({ err }, 'hub config reload failed'),
  });

  const app = Fastify({ loggerInstance: logger });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(formbody);

  const getTenant = (req: FastifyRequest): ActiveTenantState => {
    // Pre-handler ensures the request has reached here only with an active tenant.
    return (req as FastifyRequest & { tenant: ActiveTenantState }).tenant;
  };

  // Pre-handler attaches the tenant or short-circuits.
  const tenantPreHandler = async (
    req: FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): Promise<void> => {
    const slug = (req.params as { slug?: string }).slug;
    if (!slug) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    const result = resolveTenant(registry, slug);
    if (result.kind === 'not-found') {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    if (result.kind === 'error') {
      const lastError =
        result.tenant.status === 'error' ? result.tenant.lastError : 'unknown error';
      reply.code(503).send({ error: 'service_unavailable', error_description: lastError });
      return;
    }
    (req as FastifyRequest & { tenant: ActiveTenantState }).tenant = result.tenant;
  };

  // Register slug-scoped routes inside a Fastify scope with the pre-handler.
  await app.register(
    async (scope) => {
      scope.addHook('preHandler', tenantPreHandler);

      scope.get('/:slug/.well-known/openid-configuration', async (req) => {
        const tenant = getTenant(req);
        const cfg = tenant.runtime.get();
        const hasSecretClient = cfg.clients.some((c) => c.clientSecret !== undefined);
        const authMethods: ('none' | 'client_secret_post' | 'client_secret_basic')[] =
          hasSecretClient ? ['none', 'client_secret_post', 'client_secret_basic'] : ['none'];
        return buildDiscoveryDocument({
          issuer: tenant.issuer,
          signingAlg: tenant.keyMaterial.alg,
          authMethods,
        });
      });

      scope.get('/:slug/.well-known/jwks.json', async (req) => getTenant(req).jwks);

      registerAuthorize(scope, { getTenant, pathPrefix: '/:slug' });
      registerComplete(scope, { getTenant, pathPrefix: '/:slug' });
      registerToken(scope, { getTenant, pathPrefix: '/:slug' });
      registerLogout(scope, { getTenant, pathPrefix: '/:slug' });
    },
    { prefix: '' },
  );

  // Root landing
  app.get('/', async (_req, reply) => {
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(renderHubLanding({ publicUrl, tenants: registry.list() }));
  });

  return {
    app,
    registry,
    hubConfig,
    close: async () => {
      await watcher.close();
      await registry.closeAll();
      await app.close();
    },
  };
}

function renderHubLanding(input: { publicUrl: string; tenants: readonly TenantState[] }): string {
  const items = input.tenants
    .map(
      (t) =>
        `<li><code>${escapeHtml(t.slug)}</code> — <a href="/${encodeURIComponent(
          t.slug,
        )}/.well-known/openid-configuration">discovery</a> — status: ${t.status}</li>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8" /><title>dev-oidc Hub</title></head><body><h1>dev-oidc Hub</h1><p>Public URL: <code>${escapeHtml(
    input.publicUrl,
  )}</code></p><h2>Tenants (${input.tenants.length})</h2><ul>${items || '<li>(none)</li>'}</ul><p>Run <code>dev-oidc register &lt;path&gt;</code> to mount a project.</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
```

Note: the OIDC route handlers (`registerAuthorize`, `registerComplete`, `registerToken`, `registerLogout`) currently register routes at fixed paths like `/authorize`, `/token`, etc. — since they're registered inside a Fastify scope here, those paths inherit no prefix. To make them slug-aware, the simplest path is to update each `register*` to use `/:slug/<route>` path patterns. **This is a small but meaningful change to those modules**:

```ts
// In src/oidc/authorize.ts, change the route from '/authorize' to '/:slug/authorize':
app.get('/:slug/authorize', async (request, reply) => {
  // body unchanged
});
```

Repeat for `/authorize/complete` → `/:slug/authorize/complete`, `/token` → `/:slug/token`, `/logout` → `/:slug/logout`. The Legacy server (Phase 0's `createDevOidcServer`) needs to register these at the root path. The cleanest approach: each `register*` accepts a `pathPrefix: string` option, defaulting to empty. Hub mode passes `'/:slug'`; Legacy passes `''`.

Refactor each `register*`:

```ts
export interface AuthorizeDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

export function registerAuthorize(app: FastifyInstance, deps: AuthorizeDeps): void {
  const prefix = deps.pathPrefix ?? '';
  app.get(`${prefix}/authorize`, async (request, reply) => {
    const tenant = deps.getTenant(request);
    // ...
  });
}
```

In `createHubServer`, register with `pathPrefix: '/:slug'`. In `createDevOidcServer`, no prefix (default).

Also: discovery and JWKS handlers stay inline in `createHubServer` (already prefixed). The Legacy server keeps them at root.

- [ ] **Step 4: Update each `register*` to accept `pathPrefix`**

Apply the prefix pattern to:

- `src/oidc/authorize.ts` — `${prefix}/authorize`
- `src/oidc/complete.ts` — `${prefix}/authorize/complete`
- `src/oidc/token.ts` — `${prefix}/token`
- `src/oidc/logout.ts` — `${prefix}/logout` (both GET and POST)

For each, add `pathPrefix?: string` to the deps interface and use it as a template prefix.

- [ ] **Step 5: Run all OIDC handler tests to verify they still pass**

Run: `npx vitest run tests/oidc/`
Expected: PASS — no prefix supplied means routes register at root, same as before.

- [ ] **Step 6: Run hub flow integration test — should pass**

Run: `npx vitest run tests/integration/hub-flow.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hub/server.ts src/oidc/authorize.ts src/oidc/complete.ts src/oidc/token.ts src/oidc/logout.ts tests/integration/hub-flow.test.ts
git commit -m "feat(hub): hub server with slug-scoped routes and pre-handler"
```

### Task 3.7: Cross-tenant isolation integration test

**Files:**

- Create: `tests/integration/hub-isolation.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import { createHubServer } from '@/hub/server.js';

function pkce() {
  const v = randomBytes(32).toString('base64url');
  const c = createHash('sha256').update(v).digest('base64url');
  return { v, c };
}

function projectConfig(opts: { kid: string }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-iso-'));
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: opts.kid, alg: 'RS256', source: 'generate' },
      clients: [
        { clientId: 'my-app', redirectUris: ['http://localhost:5173/cb'], audience: 'my-api' },
      ],
      profiles: [{ id: 'u', displayName: 'User', email: 'u@example.com' }],
    }),
  );
  return file;
}

function hubConfig(tenants: Array<{ slug: string; configPath: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-iso-hub-'));
  const file = path.join(dir, 'hub.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
      tenants: tenants.map((t) => ({ ...t, enabled: true })),
    }),
  );
  return file;
}

async function getCode(
  server: Awaited<ReturnType<typeof createHubServer>>,
  slug: string,
  challenge: string,
): Promise<string> {
  const auth = await server.app.inject({
    method: 'GET',
    url:
      `/${slug}/authorize?` +
      new URLSearchParams({
        client_id: 'my-app',
        redirect_uri: 'http://localhost:5173/cb',
        response_type: 'code',
        scope: 'openid',
        state: 's',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
  });
  const pendingId = auth.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1];
  const complete = await server.app.inject({
    method: 'POST',
    url: `/${slug}/authorize/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pendingAuthId=${pendingId}&profileId=u`,
  });
  return new URL(complete.headers.location as string).searchParams.get('code')!;
}

describe('integration: cross-tenant isolation', () => {
  it('rejects a tenant A code presented to tenant B /token', async () => {
    const cfgA = projectConfig({ kid: 'kA' });
    const cfgB = projectConfig({ kid: 'kB' });
    const hub = hubConfig([
      { slug: 'a', configPath: cfgA },
      { slug: 'b', configPath: cfgB },
    ]);
    const server = await createHubServer({ hubConfigPath: hub });
    try {
      const { v, c } = pkce();
      const codeA = await getCode(server, 'a', c);

      const tokenAtB = await server.app.inject({
        method: 'POST',
        url: '/b/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code: codeA,
          code_verifier: v,
          client_id: 'my-app',
          redirect_uri: 'http://localhost:5173/cb',
        }).toString(),
      });
      expect(tokenAtB.statusCode).toBe(400);
      const body = tokenAtB.json() as { error: string };
      expect(body.error).toBe('invalid_grant');
    } finally {
      await server.close();
    }
  });

  it("tenant A's JWKS does not contain tenant B's signing key", async () => {
    const cfgA = projectConfig({ kid: 'kA' });
    const cfgB = projectConfig({ kid: 'kB' });
    const hub = hubConfig([
      { slug: 'a', configPath: cfgA },
      { slug: 'b', configPath: cfgB },
    ]);
    const server = await createHubServer({ hubConfigPath: hub });
    try {
      const a = await server.app.inject({ method: 'GET', url: '/a/.well-known/jwks.json' });
      const b = await server.app.inject({ method: 'GET', url: '/b/.well-known/jwks.json' });
      const aBody = a.json() as { keys: jose.JWK[] };
      const bBody = b.json() as { keys: jose.JWK[] };
      expect(aBody.keys[0]!.kid).toBe('kA');
      expect(bBody.keys[0]!.kid).toBe('kB');
      expect(aBody.keys[0]!.kid).not.toBe(bBody.keys[0]!.kid);
    } finally {
      await server.close();
    }
  });

  it("token issued by A does not verify against B's JWKS", async () => {
    const cfgA = projectConfig({ kid: 'kA' });
    const cfgB = projectConfig({ kid: 'kB' });
    const hub = hubConfig([
      { slug: 'a', configPath: cfgA },
      { slug: 'b', configPath: cfgB },
    ]);
    const server = await createHubServer({ hubConfigPath: hub });
    try {
      const { v, c } = pkce();
      const codeA = await getCode(server, 'a', c);
      const tokenRes = await server.app.inject({
        method: 'POST',
        url: '/a/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code: codeA,
          code_verifier: v,
          client_id: 'my-app',
          redirect_uri: 'http://localhost:5173/cb',
        }).toString(),
      });
      const { access_token } = tokenRes.json() as { access_token: string };

      const jwksB = await server.app.inject({ method: 'GET', url: '/b/.well-known/jwks.json' });
      const bKeys = (jwksB.json() as { keys: jose.JWK[] }).keys;
      const pubB = await jose.importJWK(bKeys[0]!, 'RS256');

      await expect(jose.jwtVerify(access_token, pubB)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/hub-isolation.test.ts`
Expected: PASS — these properties hold by construction (separate `CodeStore`, `KeyMaterial` per tenant).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/hub-isolation.test.ts
git commit -m "test(integration): cross-tenant isolation suite"
```

### Task 3.8: Wire CLI `start` to default to Hub mode

**Files:**

- Modify: `src/cli.ts`

- [ ] **Step 1: Replace the Hub-mode stub with a real implementation**

In `src/cli.ts`'s `runStart`, replace the "Hub mode not yet implemented" branch with:

```ts
// Hub mode
const { createHubServer } = await import('@/hub/server.js');
const { defaultHubConfigPath } = await import('@/hub/loader.js');
const hubConfigPath =
  typeof values['hub-config'] === 'string' ? values['hub-config'] : defaultHubConfigPath();
const server = await createHubServer({ hubConfigPath, logger });
const { host, port } = server.hubConfig.server;
await server.app.listen({ port, host });
logger.info(
  {
    publicUrl: server.hubConfig.server.publicUrl ?? `http://${host}:${port}`,
    port,
    host,
    tenants: server.registry.list().length,
  },
  'dev-oidc listening (hub)',
);
setupShutdown(server.close, logger);
```

- [ ] **Step 2: Manual smoke test**

Run: `XDG_CONFIG_HOME=$(mktemp -d) npx tsx src/cli.ts start`
Expected:

- A new `hub.json` is created in the temp XDG dir.
- Server starts on 127.0.0.1:8095.
- Logs `tenants: 0` and `dev-oidc listening (hub)`.

Stop with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): start defaults to hub mode"
```

### Task 3.9: Phase 3 verification

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Tag**

```bash
git tag -a phase-3-hub-server -m "Phase 3 complete: hub server with TenantRegistry"
```

---

## Phase 4 — CLI register / unregister / list

**Goal:** Implement the three new CLI sub-commands operating on `hub.json`.

**Phase checkpoint:** Each command works end-to-end with proper exit codes and error messages.

### Task 4.1: Slug derivation helper

**Files:**

- Create: `src/cli/slug.ts`
- Test: `tests/cli/slug.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest';
import { deriveSlugFromPath } from '@/cli/slug.js';

describe('deriveSlugFromPath', () => {
  it('lowercases and hyphenates a directory name', () => {
    expect(deriveSlugFromPath('/home/user/My Project/dev-oidc.config.json')).toBe('my-project');
  });

  it('collapses runs of non-alphanumeric chars', () => {
    expect(deriveSlugFromPath('/x/foo___bar.baz/cfg.json')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing hyphens', () => {
    expect(deriveSlugFromPath('/x/-app-/cfg.json')).toBe('app');
  });

  it('returns null for an empty result', () => {
    expect(deriveSlugFromPath('/x/!!!/cfg.json')).toBeNull();
  });

  it('truncates to 64 chars', () => {
    const long = `/x/${'a'.repeat(80)}/cfg.json`;
    const result = deriveSlugFromPath(long);
    expect(result?.length).toBeLessThanOrEqual(64);
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/cli/slug.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/cli/slug.ts`**

```ts
import path from 'node:path';

export function deriveSlugFromPath(configPath: string): string | null {
  const parent = path.basename(path.dirname(path.resolve(configPath)));
  let slug = parent
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/, '');
  return slug.length > 0 ? slug : null;
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/cli/slug.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/slug.ts tests/cli/slug.test.ts
git commit -m "feat(cli): slug derivation from project directory name"
```

### Task 4.2: `register` command

**Files:**

- Create: `src/cli/hub-commands.ts`
- Test: `tests/cli/register.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRegister } from '@/cli/hub-commands.js';

function newHub(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cli-'));
  return path.join(dir, 'hub.json');
}

function newProject(slugDir = 'my-app'): string {
  const dir = mkdtempSync(path.join(tmpdir(), `dev-oidc-${slugDir}-`));
  // Force the basename to match `slugDir`
  const projectDir = path.join(dir, slugDir);
  // Simplest: write the config directly under `dir`, slug is derived from dir basename
  const cfg = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [
        { clientId: 'my-app', redirectUris: ['http://localhost:5173/cb'], audience: 'my-api' },
      ],
      profiles: [],
    }),
  );
  void projectDir;
  return cfg;
}

describe('register', () => {
  it('appends an entry to hub.json with the explicit slug', async () => {
    const hub = newHub();
    const cfg = newProject();
    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'custom' });

    expect(result.exitCode).toBe(0);
    const persisted = JSON.parse(readFileSync(hub, 'utf8'));
    expect(persisted.tenants).toHaveLength(1);
    expect(persisted.tenants[0].slug).toBe('custom');
    expect(persisted.tenants[0].configPath).toBe(path.resolve(cfg));
  });

  it('derives slug from directory name when --slug is omitted', async () => {
    const hub = newHub();
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-derived-'));
    const projectRoot = path.join(dir, 'my-derived-app');
    mkdirSync(projectRoot);
    const cfg = path.join(projectRoot, 'dev-oidc.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        signingKey: { kid: 'k1' },
        clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
        profiles: [],
      }),
    );

    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg });
    expect(result.exitCode).toBe(0);
    const persisted = JSON.parse(readFileSync(hub, 'utf8'));
    expect(persisted.tenants[0].slug).toBe('my-derived-app');
  });

  it('rejects when slug is already registered', async () => {
    const hub = newHub();
    const cfg = newProject();
    await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });
    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/already registered/);
  });

  it('rejects when project config is invalid', async () => {
    const hub = newHub();
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const cfg = path.join(dir, 'dev-oidc.config.json');
    writeFileSync(cfg, 'not json');

    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/invalid|JSON|validation/i);
  });

  it('rejects a reserved slug', async () => {
    const hub = newHub();
    const cfg = newProject();
    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'admin' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/reserved/i);
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/cli/register.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/cli/hub-commands.ts` with `runRegister`**

```ts
import path from 'node:path';
import { loadConfig } from '@/config/loader.js';
import { loadHubConfig, saveHubConfig } from '@/hub/loader.js';
import { isReservedSlug, SLUG_REGEX } from '@/hub/schema.js';
import { deriveSlugFromPath } from '@/cli/slug.js';

export interface CommandResult {
  exitCode: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

export interface RegisterOptions {
  hubConfigPath: string;
  configPathArg: string;
  slug?: string;
}

export async function runRegister(options: RegisterOptions): Promise<CommandResult> {
  const absConfig = path.resolve(options.configPathArg);
  if (!absConfig.endsWith('.json')) {
    return {
      exitCode: 1,
      stderr: `dev-oidc: project config path must end in .json: ${absConfig}\n`,
    };
  }

  try {
    await loadConfig(absConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stderr: `dev-oidc: ${msg}\n` };
  }

  const slug = options.slug ?? deriveSlugFromPath(absConfig);
  if (!slug) {
    return {
      exitCode: 1,
      stderr: 'dev-oidc: could not derive slug from project directory name; pass --slug <name>\n',
    };
  }
  if (!SLUG_REGEX.test(slug)) {
    return {
      exitCode: 1,
      stderr: `dev-oidc: slug "${slug}" does not match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$\n`,
    };
  }
  if (isReservedSlug(slug)) {
    return { exitCode: 1, stderr: `dev-oidc: slug "${slug}" is reserved\n` };
  }

  const hub = await loadHubConfig(options.hubConfigPath);
  const existing = hub.tenants.find((t) => t.slug === slug);
  if (existing) {
    return {
      exitCode: 1,
      stderr: `dev-oidc: slug "${slug}" already registered to ${existing.configPath}; use a different --slug or run \`dev-oidc unregister ${slug}\` first\n`,
    };
  }

  const next = {
    ...hub,
    tenants: [...hub.tenants, { slug, configPath: absConfig, enabled: true }],
  };
  await saveHubConfig(options.hubConfigPath, next);
  return { exitCode: 0, stdout: `Registered "${slug}" → ${absConfig}\n` };
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/cli/register.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/hub-commands.ts tests/cli/register.test.ts
git commit -m "feat(cli): register command"
```

### Task 4.3: `unregister` command

**Files:**

- Modify: `src/cli/hub-commands.ts`
- Test: `tests/cli/unregister.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runUnregister, runRegister } from '@/cli/hub-commands.js';

describe('unregister', () => {
  it('removes the slug entry', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cli-'));
    const hub = path.join(dir, 'hub.json');
    const proj = mkdtempSync(path.join(tmpdir(), 'dev-oidc-proj-'));
    const cfg = path.join(proj, 'dev-oidc.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        signingKey: { kid: 'k1' },
        clients: [{ clientId: 'a', redirectUris: ['http://localhost/cb'], audience: 'x' }],
        profiles: [],
      }),
    );
    await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });

    const result = await runUnregister({ hubConfigPath: hub, slug: 'app' });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(hub, 'utf8')).tenants).toEqual([]);
  });

  it('exits 1 when slug is unknown', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cli-'));
    const hub = path.join(dir, 'hub.json');
    const result = await runUnregister({ hubConfigPath: hub, slug: 'no-such' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown slug/i);
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/cli/unregister.test.ts`
Expected: FAIL — `runUnregister` does not exist.

- [ ] **Step 3: Add `runUnregister` to `src/cli/hub-commands.ts`**

```ts
export interface UnregisterOptions {
  hubConfigPath: string;
  slug: string;
}

export async function runUnregister(options: UnregisterOptions): Promise<CommandResult> {
  const hub = await loadHubConfig(options.hubConfigPath);
  const existing = hub.tenants.find((t) => t.slug === options.slug);
  if (!existing) {
    return { exitCode: 1, stderr: `dev-oidc: unknown slug "${options.slug}"\n` };
  }
  const next = { ...hub, tenants: hub.tenants.filter((t) => t.slug !== options.slug) };
  await saveHubConfig(options.hubConfigPath, next);
  return { exitCode: 0, stdout: `Unregistered "${options.slug}" → ${existing.configPath}\n` };
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/cli/unregister.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/hub-commands.ts tests/cli/unregister.test.ts
git commit -m "feat(cli): unregister command"
```

### Task 4.4: `list` command

**Files:**

- Modify: `src/cli/hub-commands.ts`
- Test: `tests/cli/list.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runList } from '@/cli/hub-commands.js';

function setupHub(tenants: Array<{ slug: string; configPath: string; enabled: boolean }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-list-'));
  const hub = path.join(dir, 'hub.json');
  writeFileSync(
    hub,
    JSON.stringify({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
      tenants,
    }),
  );
  return hub;
}

describe('list', () => {
  it('emits a human-friendly table by default', async () => {
    const hub = setupHub([
      { slug: 'a', configPath: '/abs/a.json', enabled: true },
      { slug: 'b', configPath: '/abs/b.json', enabled: false },
    ]);
    const result = await runList({ hubConfigPath: hub });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('a');
    expect(result.stdout).toContain('b');
    expect(result.stdout).toContain('http://localhost:8095/a');
  });

  it('emits raw JSON tenants array with --json', async () => {
    const hub = setupHub([{ slug: 'a', configPath: '/abs/a.json', enabled: true }]);
    const result = await runList({ hubConfigPath: hub, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].slug).toBe('a');
  });

  it('handles empty tenants gracefully', async () => {
    const hub = setupHub([]);
    const result = await runList({ hubConfigPath: hub });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no tenants|^\s*$/i);
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/cli/list.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `runList` to `src/cli/hub-commands.ts`**

```ts
import { computeIssuer, deriveDefaultPublicUrl } from '@/hub/issuer.js';

export interface ListOptions {
  hubConfigPath: string;
  json?: boolean;
}

export async function runList(options: ListOptions): Promise<CommandResult> {
  const hub = await loadHubConfig(options.hubConfigPath);
  if (options.json) {
    return { exitCode: 0, stdout: JSON.stringify(hub.tenants, null, 2) + '\n' };
  }
  if (hub.tenants.length === 0) {
    return { exitCode: 0, stdout: 'No tenants registered.\n' };
  }
  const publicUrl = hub.server.publicUrl ?? deriveDefaultPublicUrl(hub.server);
  const lines = ['SLUG\tENABLED\tISSUER\tPATH'];
  for (const t of hub.tenants) {
    const issuer = computeIssuer({ publicUrl, slug: t.slug });
    lines.push(`${t.slug}\t${t.enabled ? 'yes' : 'no'}\t${issuer}\t${t.configPath}`);
  }
  return { exitCode: 0, stdout: lines.join('\n') + '\n' };
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/cli/list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/hub-commands.ts tests/cli/list.test.ts
git commit -m "feat(cli): list command"
```

### Task 4.5: Wire commands into `src/cli.ts`

**Files:**

- Modify: `src/cli.ts`

- [ ] **Step 1: Replace stubs with real dispatch**

Replace the `register`/`unregister`/`list` stubs in `src/cli.ts`:

```ts
import {
  runRegister,
  runUnregister,
  runList,
} from '@/cli/hub-commands.js';
import { defaultHubConfigPath } from '@/hub/loader.js';

// Inside main(), replace the stub branches:

case 'register': {
  const target = positionals[1];
  if (!target) {
    process.stderr.write('dev-oidc: register requires a path argument\n');
    process.exit(1);
  }
  const hubConfigPath =
    typeof values['hub-config'] === 'string' ? values['hub-config'] : defaultHubConfigPath();
  const result = await runRegister({
    hubConfigPath,
    configPathArg: target,
    slug: typeof values.slug === 'string' ? values.slug : undefined,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
case 'unregister': {
  const slug = positionals[1];
  if (!slug) {
    process.stderr.write('dev-oidc: unregister requires a slug\n');
    process.exit(1);
  }
  const hubConfigPath =
    typeof values['hub-config'] === 'string' ? values['hub-config'] : defaultHubConfigPath();
  const result = await runUnregister({ hubConfigPath, slug });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
case 'list': {
  const hubConfigPath =
    typeof values['hub-config'] === 'string' ? values['hub-config'] : defaultHubConfigPath();
  const result = await runList({ hubConfigPath, json: values.json === true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
```

- [ ] **Step 2: Manual smoke test**

Run:

```bash
TMPHUB=$(mktemp -d)/hub.json
npx tsx src/cli.ts register ./examples/config.json --slug example --hub-config $TMPHUB
npx tsx src/cli.ts list --hub-config $TMPHUB
npx tsx src/cli.ts unregister example --hub-config $TMPHUB
npx tsx src/cli.ts list --hub-config $TMPHUB
```

Expected:

- First command: `Registered "example" → /abs/path/to/examples/config.json`.
- Second: a TSV table with the example tenant.
- Third: `Unregistered "example" → ...`.
- Fourth: `No tenants registered.`.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): dispatch register/unregister/list sub-commands"
```

### Task 4.6: Phase 4 verification

- [ ] **Step 1: Tests + typecheck + lint**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 2: Tag**

```bash
git tag -a phase-4-cli-commands -m "Phase 4 complete: register/unregister/list CLI"
```

---

## Phase 5 — Admin dashboard + per-tenant routing

**Goal:** Hub-mode `/admin` dashboard listing tenants; per-tenant `/admin/:slug` profile CRUD; tenant-list JSON endpoint; SSE event filtering by slug.

**Phase checkpoint:** Hub admin integration tests pass.

### Task 5.1: Hub dashboard renderer

**Files:**

- Create: `src/admin/dashboard.ts`
- Test: `tests/admin/dashboard.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest';
import { renderHubDashboard } from '@/admin/dashboard.js';

describe('renderHubDashboard', () => {
  it('renders the public URL and tenant rows', () => {
    const html = renderHubDashboard({
      publicUrl: 'http://localhost:8095',
      tenants: [
        {
          slug: 'app',
          status: 'active',
          issuer: 'http://localhost:8095/app',
          configPath: '/abs/app/dev-oidc.config.json',
          profileCount: 3,
          lastError: null,
        },
        {
          slug: 'broken',
          status: 'error',
          issuer: null,
          configPath: '/abs/broken.json',
          profileCount: null,
          lastError: 'JSON parse error',
        },
      ],
    });
    expect(html).toContain('http://localhost:8095');
    expect(html).toContain('app');
    expect(html).toContain('Active');
    expect(html).toContain('Error');
    expect(html).toContain('JSON parse error');
  });

  it('renders empty state when no tenants', () => {
    const html = renderHubDashboard({ publicUrl: 'http://localhost:8095', tenants: [] });
    expect(html).toMatch(/No tenants registered/i);
    expect(html).toContain('dev-oidc register');
  });

  it('escapes user-supplied content', () => {
    const html = renderHubDashboard({
      publicUrl: 'http://localhost:8095',
      tenants: [
        {
          slug: 'app',
          status: 'error',
          issuer: null,
          configPath: '/abs/x.json',
          profileCount: null,
          lastError: '<script>alert(1)</script>',
        },
      ],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/admin/dashboard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/admin/dashboard.ts`**

```ts
import { Html, html, renderToString } from '@/shared/html.js';

export interface DashboardTenant {
  slug: string;
  status: 'active' | 'error';
  issuer: string | null;
  configPath: string;
  profileCount: number | null;
  lastError: string | null;
}

export interface RenderHubDashboardInput {
  publicUrl: string;
  tenants: readonly DashboardTenant[];
}

const STYLES = `
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c; max-width: 1100px; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid #eaecf0; vertical-align: middle; font-size: 0.95rem; }
  th { background: #f9fafb; font-weight: 600; font-size: 0.875rem; color: #667085; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .pill.active { background: #dcfae6; color: #027a48; }
  .pill.error { background: #fee4e2; color: #b42318; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: #eef0f3; padding: 0.1em 0.35em; border-radius: 4px; }
  details summary { cursor: pointer; color: #b42318; }
  .empty { background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; padding: 2rem; text-align: center; color: #667085; }
`.trim();

const SAFE_STYLES = new Html(STYLES);

export function renderHubDashboard(input: RenderHubDashboardInput): string {
  const rows = input.tenants.map((t) => {
    const statusPill =
      t.status === 'active'
        ? html`<span class="pill active">Active</span>`
        : html`<span class="pill error">Error</span>`;
    const issuerCell = t.issuer
      ? html`<a href="/${t.slug}/.well-known/openid-configuration"><code>${t.issuer}</code></a>`
      : '—';
    const profilesCell = t.profileCount === null ? '—' : String(t.profileCount);
    const errorBlock = t.lastError
      ? html`<details>
          <summary>Show error</summary>
          <pre>${t.lastError}</pre>
        </details>`
      : '';
    return html`<tr>
      <td><code>${t.slug}</code></td>
      <td>${statusPill}</td>
      <td>${issuerCell}</td>
      <td>${profilesCell}</td>
      <td><code title="${t.configPath}">${truncate(t.configPath, 60)}</code> ${errorBlock}</td>
      <td>${t.status === 'active' ? html`<a href="/admin/${t.slug}">Manage →</a>` : ''}</td>
    </tr>`;
  });

  const body =
    input.tenants.length === 0
      ? html`<div class="empty">
          <p>No tenants registered.</p>
          <p>
            Run <code>dev-oidc register &lt;path-to-dev-oidc.config.json&gt;</code> to mount one.
          </p>
        </div>`
      : html`<table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>Status</th>
              <th>Issuer</th>
              <th>Profiles</th>
              <th>Config path</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>`;

  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>dev-oidc Hub</title>
        <style>
          ${SAFE_STYLES}
        </style>
      </head>
      <body>
        <h1>dev-oidc — Hub</h1>
        <p>Public URL: <code>${input.publicUrl}</code></p>
        ${body}
      </body>
    </html>`;
  return renderToString(doc);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - (max - 1));
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run tests/admin/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/dashboard.ts tests/admin/dashboard.test.ts
git commit -m "feat(admin): hub dashboard renderer"
```

### Task 5.2: `/admin/api/tenants` endpoint and dashboard wiring

**Files:**

- Modify: `src/hub/server.ts`
- Test: `tests/integration/hub-admin.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHubServer } from '@/hub/server.js';

function projectConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-admin-'));
  const cfg = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
      profiles: [
        { id: 'u1', displayName: 'U1', email: 'u1@example.com' },
        { id: 'u2', displayName: 'U2', email: 'u2@example.com' },
      ],
    }),
  );
  return cfg;
}

function hubFor(tenants: Array<{ slug: string; configPath: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-admin-cfg-'));
  const hub = path.join(dir, 'hub.json');
  writeFileSync(
    hub,
    JSON.stringify({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
      tenants: tenants.map((t) => ({ ...t, enabled: true })),
    }),
  );
  return hub;
}

describe('integration: hub admin', () => {
  it('GET /admin renders the dashboard', async () => {
    const cfg = projectConfig();
    const server = await createHubServer({
      hubConfigPath: hubFor([{ slug: 'app', configPath: cfg }]),
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.payload).toContain('dev-oidc — Hub');
      expect(res.payload).toContain('app');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/api/tenants returns the tenant summary', async () => {
    const cfg = projectConfig();
    const server = await createHubServer({
      hubConfigPath: hubFor([{ slug: 'app', configPath: cfg }]),
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/api/tenants' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ slug: string; status: string; profileCount: number }>;
      expect(body).toHaveLength(1);
      expect(body[0]!.slug).toBe('app');
      expect(body[0]!.status).toBe('active');
      expect(body[0]!.profileCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/:slug renders the per-tenant page', async () => {
    const cfg = projectConfig();
    const server = await createHubServer({
      hubConfigPath: hubFor([{ slug: 'app', configPath: cfg }]),
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/app' });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('U1');
      expect(res.payload).toContain('U2');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/api/:slug/profiles returns profiles', async () => {
    const cfg = projectConfig();
    const server = await createHubServer({
      hubConfigPath: hubFor([{ slug: 'app', configPath: cfg }]),
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/api/app/profiles' });
      expect(res.statusCode).toBe(200);
      const profiles = res.json() as Array<{ id: string }>;
      expect(profiles.map((p) => p.id)).toEqual(['u1', 'u2']);
    } finally {
      await server.close();
    }
  });

  it('returns 404 for /admin/:unknown-slug', async () => {
    const server = await createHubServer({ hubConfigPath: hubFor([]) });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/no-such' });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run tests — should fail (404 for /admin)**

Run: `npx vitest run tests/integration/hub-admin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire dashboard + admin endpoints into `src/hub/server.ts`**

Add to `createHubServer`, after the slug-scoped scope registration:

```ts
import { renderHubDashboard, type DashboardTenant } from '@/admin/dashboard.js';
import { renderAdminPage } from '@/admin/page.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import { createEventsEmitter, registerEventsRoute } from '@/admin/events.js';

// ... inside createHubServer, after slug-scoped scope:

const eventsEmitter = createEventsEmitter();
registry.events.on('profilesChanged', ({ slug }) =>
  eventsEmitter.emit({ type: 'config-changed', slug }),
);
registry.events.on('added', ({ slug }) => eventsEmitter.emit({ type: 'config-changed', slug }));
registry.events.on('removed', ({ slug }) => eventsEmitter.emit({ type: 'config-changed', slug }));

app.get('/admin', async (_req, reply) => {
  const tenants: DashboardTenant[] = registry.list().map((t) => {
    if (t.status === 'active') {
      return {
        slug: t.slug,
        status: 'active',
        issuer: t.issuer,
        configPath: t.configPath,
        profileCount: t.runtime.get().profiles.length,
        lastError: null,
      };
    }
    return {
      slug: t.slug,
      status: 'error',
      issuer: null,
      configPath: t.configPath,
      profileCount: null,
      lastError: t.lastError,
    };
  });
  return reply
    .code(200)
    .type('text/html; charset=utf-8')
    .send(renderHubDashboard({ publicUrl, tenants }));
});

app.get('/admin/api/tenants', async () => {
  return registry.list().map((t) => {
    if (t.status === 'active') {
      return {
        slug: t.slug,
        status: 'active' as const,
        issuer: t.issuer,
        configPath: t.configPath,
        profileCount: t.runtime.get().profiles.length,
        lastError: null,
      };
    }
    return {
      slug: t.slug,
      status: 'error' as const,
      issuer: null,
      configPath: t.configPath,
      profileCount: null,
      lastError: t.lastError,
    };
  });
});

registerEventsRoute(app, { emitter: eventsEmitter });

// Per-tenant admin page and API.
app.get('/admin/:slug', async (req, reply) => {
  const slug = (req.params as { slug: string }).slug;
  const tenant = registry.get(slug);
  if (!tenant) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  if (tenant.status === 'error') {
    reply
      .code(503)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html><body><h1>Tenant "${slug}" error</h1><pre>${escapeHtml(tenant.lastError)}</pre></body></html>`,
      );
    return;
  }
  reply
    .code(200)
    .type('text/html; charset=utf-8')
    .send(renderAdminPage({ config: tenant.runtime.get(), slug: tenant.slug }));
});

await app.register(
  async (scope) => {
    scope.addHook('preHandler', tenantPreHandler);

    registerProfilesRoutes(scope, {
      getTenant: (req) => (req as FastifyRequest & { tenant: ActiveTenantState }).tenant,
      pathPrefix: '/admin/api/:slug',
    });
  },
  { prefix: '' },
);
```

This requires `registerProfilesRoutes` to accept a `pathPrefix` option. Update its routes from:

```ts
app.get('/admin/api/config', ...);
app.get('/admin/api/profiles', ...);
app.post('/admin/api/profiles', ...);
app.put('/admin/api/profiles/:id', ...);
app.delete('/admin/api/profiles/:id', ...);
```

to:

```ts
const prefix = deps.pathPrefix ?? '/admin/api';
app.get(`${prefix}/config`, ...);
app.get(`${prefix}/profiles`, ...);
app.post(`${prefix}/profiles`, ...);
app.put(`${prefix}/profiles/:id`, ...);
app.delete(`${prefix}/profiles/:id`, ...);
```

The default `'/admin/api'` keeps Legacy mode's URLs identical; Hub mode passes `'/admin/api/:slug'` to scope per tenant. Update `tests/admin/profiles-routes.test.ts` accordingly: legacy tests need no change (default prefix matches), hub-admin tests verify the `:slug` paths.

- [ ] **Step 4: Update `src/admin/page.ts` to scope `data-api` URLs by slug**

In `renderAdminPage`, when `slug !== '(legacy)'`, change form `data-api` URLs from `/admin/api/profiles` to `/admin/api/${slug}/profiles`. Same for `data-api` on the `:id` URLs:

```ts
const apiBase =
  input.slug === '(legacy)' ? '/admin/api/profiles' : `/admin/api/${input.slug}/profiles`;
// use apiBase in profileEditForm and profileAddForm and profileRow's delete form
```

Update existing `tests/admin/page.test.ts` to assert the slug-scoped URLs when a non-legacy slug is supplied.

- [ ] **Step 5: Run hub-admin tests — should pass**

Run: `npx vitest run tests/integration/hub-admin.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full test suite to confirm no regressions**

Run: `npm run test`
Expected: PASS — Legacy admin tests still green because the legacy slug path uses the unchanged URLs.

- [ ] **Step 7: Commit**

```bash
git add src/hub/server.ts src/admin/page.ts src/admin/profiles-routes.ts tests/admin/page.test.ts tests/integration/hub-admin.test.ts
git commit -m "feat(hub): admin dashboard, /admin/api/tenants, per-tenant CRUD"
```

### Task 5.3: SSE event filtering by slug

**Files:**

- Modify: `src/admin/events.ts` (already updated in Phase 0 to include slug)
- Modify: dashboard client script in `src/admin/dashboard.ts` to refresh on any event
- Modify: per-tenant client script in `src/admin/page.ts` to filter by its own slug

- [ ] **Step 1: Update the dashboard's client script to listen and reload**

In `src/admin/dashboard.ts`, embed an `EventSource` script that fetches `/admin/api/tenants` and re-renders. For Phase 5 simplicity, just reload the page on any event (matches the existing per-page reload-banner UX). Add to the dashboard HTML before `</body>`:

```ts
const CLIENT_SCRIPT = `
  (function() {
    const es = new EventSource('/admin/events');
    es.addEventListener('config-changed', () => window.location.reload());
  })();
`.trim();
const SAFE_CLIENT_SCRIPT = new Html(CLIENT_SCRIPT);

// In the html template:
<script>${SAFE_CLIENT_SCRIPT};</script>
```

- [ ] **Step 2: Update the per-tenant page client script to filter by slug**

In `src/admin/page.ts`'s existing `CLIENT_SCRIPT`, change the SSE handler to check the event's data:

```ts
const CLIENT_SCRIPT = `
  (function() {
    const banner = document.getElementById('reload-banner');
    const slug = ${JSON.stringify(input.slug)};
    const es = new EventSource('/admin/events');
    es.addEventListener('config-changed', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.slug !== slug && slug !== '(legacy)') return;
      } catch (e) { /* fallback: show banner anyway */ }
      if (banner) banner.classList.add('visible');
    });
    // ... rest unchanged
  })()
`.trim();
```

Because the script now embeds the slug, it must be built per-render. Inside `renderAdminPage`, replace the existing module-level `SAFE_CLIENT_SCRIPT` constant usage with a per-render local:

```ts
export function renderAdminPage(input: RenderAdminPageInput): string {
  const clientScript = `
    (function() {
      const banner = document.getElementById('reload-banner');
      const slug = ${JSON.stringify(input.slug)};
      const es = new EventSource('/admin/events');
      es.addEventListener('config-changed', (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.slug !== slug && slug !== '(legacy)') return;
        } catch (e) { /* fallback: show banner */ }
        if (banner) banner.classList.add('visible');
      });
      // ... existing click + submit handlers preserved verbatim ...
    })();
  `.trim();
  // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
  const safeScript = new Html(clientScript); // slug is JSON.stringified before embedding
  // ... rest of the function uses safeScript in place of SAFE_CLIENT_SCRIPT
}
```

The `nosemgrep` comment mirrors the existing pattern in this file (`src/admin/page.ts`). Delete the module-level `SAFE_CLIENT_SCRIPT` constant once nothing references it.

- [ ] **Step 3: Update existing admin SSE test to assert the slug payload**

In `tests/admin/events.test.ts`, assert the emitted event includes `slug`. (Already done in Phase 0 — verify here.)

- [ ] **Step 4: Run admin tests**

Run: `npx vitest run tests/admin/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/dashboard.ts src/admin/page.ts tests/admin/events.test.ts tests/admin/page.test.ts
git commit -m "feat(admin): SSE events scoped by slug; dashboard auto-refresh"
```

### Task 5.4: Phase 5 verification

- [ ] **Step 1: Run full suite + typecheck + lint**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 2: Manual smoke test**

Run:

```bash
TMPHUB=$(mktemp -d)/hub.json
npx tsx src/cli.ts register ./examples/config.json --slug example --hub-config $TMPHUB
npx tsx src/cli.ts start --hub-config $TMPHUB &
sleep 1
curl -sS http://127.0.0.1:8095/admin/api/tenants | head
curl -sS http://127.0.0.1:8095/example/.well-known/openid-configuration | head
kill %1
```

Expected: tenants endpoint returns the example tenant; discovery doc shows `iss: http://127.0.0.1:8095/example`.

- [ ] **Step 3: Tag**

```bash
git tag -a phase-5-admin-dashboard -m "Phase 5 complete: admin dashboard and per-tenant routing"
```

---

## Phase 6 — Documentation

**Goal:** Update README, CHANGELOG, and example config so external users can adopt v0.2.0.

**Phase checkpoint:** README walks a new user from zero to a Hub-running multi-tenant setup; Legacy mode and Docker remain documented.

### Task 6.1: Update README to make Hub mode primary

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Read the existing README**

Run: `wc -l README.md` and `head -200 README.md`
Note the structure: title, badges, "Why" section, "Using dev-oidc in your project" walkthrough, Run modes (Docker / docker-compose / CLI / programmatic).

- [ ] **Step 2: Replace the "Run mode" sections with three blocks: Hub mode (new primary), Legacy CLI, Docker**

Add a new top-level section before the existing "Run mode 1 — Docker":

````markdown
## Run mode 1 — Hub (recommended for many projects)

Run a single dev-oidc process that serves multiple project tenants concurrently. Each project keeps its own `dev-oidc.config.json` in its repo; a registry at `~/.config/dev-oidc/hub.json` tracks which projects are mounted.

**Setup:**

```bash
npm install -g dev-oidc       # or run via npx
dev-oidc register /path/to/your/project   # adds to hub.json
dev-oidc start                # listens on 127.0.0.1:8095
```
````

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

````

Then renumber the existing run modes (Docker becomes "Run mode 2", legacy CLI becomes "Run mode 3 — Legacy single-tenant CLI" with the new `--port`/`--host`/`--public-url` flags documented). Programmatic stays as "Run mode 4".

- [ ] **Step 3: Update the "Config reference" section**

Drop `issuer`, `port`, `host` from the schema reference. Add a note: _"In Hub mode, the listener and issuer are set in `~/.config/dev-oidc/hub.json`. In Legacy mode, pass `--port`, `--host`, and `--public-url` to `dev-oidc start --config <path>`."_

- [ ] **Step 4: Run prettier on README**

Run: `npx prettier --write README.md`

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): hub mode primary; legacy and docker secondary"
````

### Task 6.2: Update CHANGELOG

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a v0.2.0 section**

Prepend to `CHANGELOG.md` (above the existing `## [0.1.0]` section):

```markdown
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
```

- [ ] **Step 2: Run prettier**

Run: `npx prettier --write CHANGELOG.md`

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): v0.2.0 hub mode entry"
```

### Task 6.3: Phase 6 verification

- [ ] **Step 1: Final test + typecheck + lint + format**

Run: `npm run test && npm run typecheck && npm run lint && npm run format:check`
Expected: PASS (skills/ may still warn on format if not handled).

- [ ] **Step 2: Tag**

```bash
git tag -a phase-6-docs -m "Phase 6 complete: docs updated for v0.2.0"
```

- [ ] **Step 3: Restore the stashed `skills/` content**

Run: `git stash list` to confirm the `skills wip` stash is still there.
Run: `git stash pop` (or `git stash pop stash@{0}`) once you're done.

---

## Final verification

- [ ] **Step 1: Re-run the entire test suite**

Run: `npm run test`
Expected: PASS, all suites green.

- [ ] **Step 2: Run typecheck and lint together**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Build the package**

Run: `npm run build`
Expected: PASS — dist artifacts produced.

- [ ] **Step 4: Smoke test the built CLI**

```bash
TMPHUB=$(mktemp -d)/hub.json
node dist/cli.js register ./examples/config.json --slug example --hub-config $TMPHUB
node dist/cli.js list --hub-config $TMPHUB
node dist/cli.js start --hub-config $TMPHUB &
sleep 1
curl -fsS http://127.0.0.1:8095/example/.well-known/openid-configuration > /dev/null
curl -fsS http://127.0.0.1:8095/admin > /dev/null
kill %1
```

Expected: every curl returns successfully.

- [ ] **Step 5: Open a PR**

```bash
git push -u origin feat/multi-tenant-hub
gh pr create --title "feat: multi-tenant hub mode" --body "$(cat <<'EOF'
## Summary
- Adds Hub mode: one dev-oidc process serves multiple OIDC tenants from project-local config files
- Reduces project schema (drops issuer/port/host); adds `--port`/`--host`/`--public-url` flags for legacy mode
- Adds `register`/`unregister`/`list` CLI sub-commands
- Adds Hub admin dashboard at `/admin` with cross-tenant view and per-tenant CRUD

## Test plan
- [x] Full test suite passes (npm run test)
- [x] Typecheck passes (npm run typecheck)
- [x] Lint passes (npm run lint)
- [x] Build succeeds (npm run build)
- [x] Smoke test: register → list → start → curl discovery + admin
- [x] Cross-tenant isolation suite covers code/refresh/JWKS leakage

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Report completion to the user**

Print a summary: which phases landed, the PR URL, and any deferred work.
