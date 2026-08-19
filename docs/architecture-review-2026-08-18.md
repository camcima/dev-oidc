# Architecture Review — dev-oidc v0.5.0

**Date:** 2026-08-18
**Scope:** Full `src/` tree (~4,900 LOC), build/CI/Docker configuration, examples, and test suite.
**Verification baseline:** `tsc --noEmit` clean, ESLint clean, **405/405 tests passing** across 49 files.

---

## 1. Overall assessment

This is a high-quality codebase — well above the norm for a solo developer tool. The module layout is clean (`oidc/` protocol core, `hub/` multi-tenancy, `config/` persistence, `admin/` UI, thin `cli/`), route handlers are registered via a consistent dependency-injected pattern (`getTenant`, `pathPrefix`), and the code is unusually well-commented with _why_-comments explaining non-obvious decisions (the SSE `preClose` hook, the activate-then-swap tenant lifecycle, the `DEV_OIDC_PUBLIC_URL` scoping note).

Security posture is thoughtful for a dev tool: host-header allowlisting plus `Sec-Fetch-Site`/`Origin` checks on `/admin` (DNS-rebinding + CSRF defense), `pickRedirectHost` preventing Host-header-driven open redirects, redirect URIs resolved from config rather than request data (`complete.ts`), timing-safe secret comparison, auto-escaping HTML templating, 0600-mode atomic file writes, and reserved-slug protection. Concurrency is handled seriously: per-config-path mutation queue, per-slug registry lock, hub.json lockfile with stale reclaim.

The findings below are mostly **one real data-loss bug**, a set of **OIDC spec-fidelity gaps** (which matter more than usual here, because the product's core promise is "your real auth code path runs unchanged"), and **structural duplication** between the two server modes.

---

## 2. Bugs

### 2.1 Admin UI profile edit silently destroys extended profile fields — **highest priority**

`src/admin/page.ts` (`profileEditForm`) only renders inputs for `id`, `displayName`, `email`, and `claims`. The PUT handler (`src/admin/profiles-routes.ts:80`) treats the body as the _complete_ replacement profile, and `toProfile` (`src/admin/profiles-routes.ts:32`) fills the gaps: `avatar: input.avatar ?? null`, `emailVerified`/`givenName`/`familyName`/`locale`/`hostedDomain` → `undefined`.

**Failure scenario:** open the admin UI for a profile like the ones in `examples/google.config.json`, change only the display name, hit Save → `givenName`, `familyName`, `avatar`, `locale`, `hostedDomain`, and `emailVerified` are silently deleted from the config file on disk. All Google-fidelity claims vanish from subsequently issued tokens, and the data is unrecoverable unless the config is in git.

**Fix options:** (a) make PUT a merge (fetch current profile, overlay submitted fields); (b) render all schema fields in the edit dialog; (c) round-trip the unedited fields as hidden inputs. Option (a) is the most robust against future schema growth.

### 2.2 HTTP→HTTPS redirect uses 301, which rewrites POST to GET

`src/server.ts:152` and `src/hub/server.ts:202` issue `301` for plain-HTTP requests when TLS is enabled. Per RFC 7231, clients historically (and most HTTP libraries today) convert a 301'd POST into a GET. An RP misconfigured with an `http://` token endpoint against a TLS-enabled dev-oidc will have its `POST /token` silently become `GET /token` → 404/405, an actively confusing failure. Use **308** (method-preserving), or reject non-GET plaintext requests with a clear error body instead of redirecting.

### 2.3 `--port 0` accepted

`src/cli.ts:137` validates `port < 0 || port > 65535`, so `--port 0` passes, the OS assigns an ephemeral port, and the advertised issuer (`http://host:0`) is wrong. Change to `port < 1` (or explicitly support port 0 by reading the bound port back from `app.server.address()` before computing the issuer — arguably a nice feature, but as-is it's a trap).

### 2.4 RP-initiated logout drops the `state` parameter

`src/oidc/logout.ts` handles `post_logout_redirect_uri` but ignores `state`. OIDC RP-Initiated Logout §3 requires the OP to append `state` to the redirect when the RP supplied one. `oidc-client-ts`'s `signoutRedirectCallback()` validates it — against dev-oidc, sign-out callbacks fail state validation where they'd succeed against Auth0/Entra. Same handler: the POST variant only reads query parameters, but the spec allows form-encoded body parameters for POST logout.

### 2.5 Duplicate SSE `config-changed` events in hub mode

In `src/hub/registry.ts`, a file reload fires `profilesChanged` twice: `onReload` (line 113) calls `runtime.set()` — which triggers the `runtime.onChange` handler registered at line 131 — and then _also_ emits explicitly. Every disk edit produces two SSE events (two dashboard reloads / two banner triggers); a _content-identical_ rewrite (where `runtime.set` no-ops) still emits one spurious event. Drop the explicit emit inside `onReload` and let `onChange` be the single source of the event.

### 2.6 `refreshTokenTtlSeconds` is not hot-reloadable, but `tokenTtlSeconds` is

The code store is constructed once at tenant activation with `refreshTtlMs: config.refreshTokenTtlSeconds * 1000` (`src/hub/registry.ts:103`, `src/server.ts:87`), while `tokenTtlSeconds` is read live from `runtime.get()` on every issuance. Editing `refreshTokenTtlSeconds` in the config file appears to hot-reload (the watcher fires, the admin UI updates) but has no effect until restart/re-register. Read the TTL from `runtime` at `issueRefresh` time, or document the restart requirement.

---

## 3. OIDC fidelity gaps

These aren't bugs in isolation, but the README's core pitch is _"your app runs its real auth code path... The same code path runs in production — only the URLs change."_ Each gap below is a place where the dev experience diverges from a real IdP, i.e., where the product's own success criterion is not met.

### 3.1 Authorization errors return 400 JSON instead of redirecting

Per RFC 6749 §4.1.2.1, once `client_id` and `redirect_uri` are validated, errors like `unsupported_response_type`, `invalid_scope`, and missing PKCE parameters MUST be delivered by **redirecting to `redirect_uri`** with `error` (+ `state`) query parameters. `src/oidc/authorize.ts` returns `400` JSON for all of them. Consequence: an app's error-handling callback path (`error=...` in the callback URL) is _never exercised_ against dev-oidc, and browser users see raw JSON instead of their app's error page. This is the most impactful fidelity gap after PKCE strictness.

### 3.2 PKCE is mandatory for all clients, including confidential ones

`authorize.ts` hard-requires `code_challenge` + `S256`. Public-client SPAs (MSAL, oidc-client-ts) are fine, but confidential server-side clients frequently don't send PKCE by default — e.g., Spring Security's default confidential-client flow, older Passport strategies. Those integrations fail at the first redirect with a 400. The README explicitly names Spring Security as a supported consumer. Consider: clients with a `clientSecret` may skip PKCE (matching Entra/Auth0 behavior), keeping PKCE mandatory for public clients only — or an explicit `requirePkce: false` per-client opt-out.

### 3.3 No `client_credentials` grant

Machine-to-machine callers (backend services acquiring tokens with client id/secret) can't be tested at all. Most real projects have at least one M2M path. This is likely the highest-value _feature_ addition; the plumbing (client auth, `issueTokenSet`) already exists.

### 3.4 `prompt=none` unsupported

Silent-renew iframes (`oidc-client-ts` `automaticSilentRenew` fallback, MSAL `ssoSilent`) send `prompt=none` and expect either an auto-issued code or `error=login_required`. dev-oidc renders the login page HTML into the hidden iframe, which hangs the renew until timeout. Since dev-oidc has no session cookie, the correct cheap behavior is to answer `prompt=none` with an `error=login_required` redirect (or auto-select when exactly one profile exists).

### 3.5 Failed token-exchange attempts don't burn the authorization code

`src/oidc/codes.ts:72`: a `rejected` consume (PKCE mismatch, wrong `redirect_uri`, wrong client) leaves the code alive for retry. RFC 6749 §4.1.2 says the code SHOULD be revoked after a failed verification. Real IdPs burn it. Leniency may be _intentional_ for dev ergonomics (retry after a typo) — if so, document it; if not, delete on rejection too.

### 3.6 Smaller conformance nits

- **Basic auth credentials are not percent-decoded** (`src/oidc/token.ts`, `extractClientCredentials`). RFC 6749 §2.3.1/Appendix B says client id/secret are form-urlencoded inside the Basic header; spec-conformant clients (e.g., node `openid-client`) encode them. Only bites when ids/secrets contain reserved characters, but it's a two-line fix.
- **Discovery omits `response_modes_supported`** — some client libraries consult it before choosing `query`/`form_post`.
- **No `check_session_iframe` / front-channel logout advertisement** — fine to omit, just confirming it's a deliberate non-goal.

---

## 4. Design observations

### 4.1 Legacy server and hub server are parallel copies — the largest structural debt

`src/server.ts` (219 lines) and `src/hub/server.ts` (393 lines) duplicate: the discovery handler including the `authMethods` derivation, the httpolyglot `serverFactory` incantation (including its 8-line explanatory comment, verbatim), the HTTP→HTTPS redirect hook, the CORS/formbody/admin-guard registration sequence, and `defaultCacheDir()`/`defaultHostnames()` helpers (also duplicated a third time in `src/cli/legacy.ts`). The long comment in `hub/server.ts` about why `DEV_OIDC_PUBLIC_URL` is honored in one mode but not the other is evidence the two paths have _already_ drifted behaviorally and require prose to keep aligned.

**Recommendation:** model legacy mode as a hub with a single tenant mounted at the root prefix (the `ActiveTenantState` abstraction already makes tenants uniform — legacy mode literally fabricates a tenant with slug `'(legacy)'`), or extract a `createBaseServer(options)` that owns TLS/CORS/guard/discovery wiring. This would delete ~150 lines and eliminate the drift class entirely.

### 4.2 `ActiveTenantState.config` is a stale snapshot

`src/hub/tenant-state.ts:15` carries the config captured at activation. Every route handler correctly reads `runtime.get()` instead — the field has **zero readers** today, but it sits next to `runtime` inviting the next contributor to read stale data after a hot reload. Delete it (or rename to `initialConfig` if some diagnostic value is intended).

### 4.3 Layering: hub server imports from the CLI layer

`src/hub/server.ts:10` imports `expandTildePath` from `@/cli/legacy.js`. Path utilities belong in `src/shared/`; servers should not depend on CLI modules.

### 4.4 Two hand-rolled promise mutexes with different semantics

`src/config/mutex.ts` (`withConfigLock`) cleans up its queue map when drained; `withSlugLock` in `src/hub/registry.ts` never removes entries. Both implement the same chained-promise pattern. Extract one `createKeyedMutex()` into `shared/` — the registry version's leak is negligible in practice, but two subtly different copies of a concurrency primitive is exactly the kind of thing that bites later.

### 4.5 Sentinel-string error control flow

`src/cli/hub-commands.ts` aborts `mutateHubConfig` transactions by throwing `Error('__slug_conflict__')` and string-matching in the catch. Works, but is fragile (a nested error with the same message would be misinterpreted; the out-of-band `conflictPath` mutable capture is easy to get wrong). Prefer typed error classes or having the mutator return a discriminated result.

### 4.6 Inconsistent unknown-key policy between the two config schemas

Project config (`src/config/schema.ts`) rejects unknown keys with tailored migration messages — excellent UX. Hub config (`src/hub/schema.ts`) uses plain `z.object`, which **silently strips** unknown keys: a typo like `pubicUrl` in hub.json is ignored without a whisper. Note the tension: `examples/hub.json` uses `"//"`-prefixed comment keys that _depend_ on the lenient behavior. Make the policy deliberate — e.g., allow keys starting with `"//"`, warn on everything else.

### 4.7 CORS implementation contradicts the README

`origin: true` (`src/server.ts:165`, `src/hub/server.ts:214`) reflects **any** Origin; the README promises "Permissive CORS for browser apps running on `localhost:*`". The admin routes are independently protected by the guard's Origin/Sec-Fetch-Site checks, so the practical exposure is a public website being able to read your local discovery/JWKS documents (low value to an attacker, and Chrome's PNA blocks much of it). Still: either restrict CORS to loopback origins as documented, or fix the README. Precision matters in security claims.

### 4.8 The type-level cast on `ConfigSchema`

`src/config/schema.ts:160`: `as unknown as typeof ConfigBodySchema` after `.passthrough().superRefine(...)`. Pragmatic, but it launders the type — `.passthrough()` means parsed output can carry the legacy keys (`issuer`, `port`, ...) at runtime while the type says otherwise. Since the superRefine already rejects all unknown keys, `.passthrough()` exists only so superRefine can _see_ them; zod 4's `.check()`/`.strict()` combination or a two-stage `z.looseObject → validate → ConfigBodySchema.parse` pipe could achieve this without the cast.

### 4.9 Smaller items

- **Magic TTLs duplicated:** auth-code 60 s and pending-auth 10 min are hardcoded in both `src/server.ts:87` and `src/hub/registry.ts:103`. Extract named constants next to `CodeStoreOptions`.
- **`userinfo` re-imports the JWK on every request** (`src/oidc/userinfo.ts:46`). Cache the public `CryptoKey` in `KeyMaterial` alongside `privateKey`.
- **`src/cli.ts:187`** re-imports `defaultHubConfigPath` dynamically although it's already statically imported at the top of the file.
- **`saveHubConfig` uses a fixed `.tmp` suffix** (`src/hub/loader.ts:51`) while `config/writer.ts` deliberately randomizes its temp name "so concurrent writers never share a temp file". The bootstrap save in `loadHubConfig` runs _outside_ the lockfile, so the fixed name is the one place the race is actually possible. Use the same randomized pattern.
- **`z.string().email()` is deprecated in zod 4** (`src/config/schema.ts:32`, `src/admin/profiles-routes.ts:17`) — migrate to `z.email()` before a future major removes it.
- **`package.json` `main` points at ESM `dist/index.js`** while the `require` export condition maps to `dist/index.cjs`. Tooling that ignores `exports` and `require()`s `main` will break. Point `main` at the `.cjs` build (or drop `main` entirely; `exports` is authoritative on Node ≥ 12).
- **Admin surfaces expose `clientSecret`:** `GET /admin/api/config` and the raw-config dump on the admin page include secrets. Defensible for a local tool, but worth a `SECURITY.md` sentence, and trivially avoidable by redacting in the render.
- **Registry `add()` emits `added` on replacement** — a tenant whose configPath changed emits `added` with no corresponding `removed`/`changed`; consumers currently coalesce everything into "refetch", so it's latent, not live.

---

## 5. What's notably good (keep doing this)

- **Test discipline:** 405 tests including true integration contract tests (`tests/integration/contract.test.ts`, hub isolation, SSE shutdown), error-path coverage (`keys-save-error`), and CLI-level tests. CI runs a Node 22/24 matrix plus a Docker boot smoke test.
- **Supply-chain care:** pinned mkcert version _with per-arch SHA256 verification_ in the Dockerfile; `npm ci --ignore-scripts`; native arm64 runners instead of QEMU (with the reasoning documented).
- **Error message quality:** config validation errors tell users exactly which key moved where in v0.2; key-file mismatch errors enumerate the three ways out. This is rare and valuable.
- **The `pickRedirectHost` / `requirePublicUrlOrSafeHost` pair** shows real threat modeling for a dev tool (Host-header open redirect, unreachable bind-all issuer).
- **`evictForInsert`'s bounded stores** — memory is bounded in a long-running hub without a background timer. The O(n) sweep per insert is fine at the 10 k cap; no change needed.

---

## 6. Prioritized recommendations

| #   | Item                                                                                                                      | Type         | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------ | ------ |
| 1   | Fix admin PUT data loss (merge semantics or full-field form) — §2.1                                                       | Bug          | S      |
| 2   | Redirect authorization errors to `redirect_uri` per RFC 6749 — §3.1                                                       | Fidelity     | M      |
| 3   | Allow non-PKCE flows for confidential clients — §3.2                                                                      | Fidelity     | S      |
| 4   | Echo `state` on logout redirect; accept form-body params on POST — §2.4                                                   | Bug/Fidelity | S      |
| 5   | 301 → 308 on the TLS redirect hook — §2.2                                                                                 | Bug          | XS     |
| 6   | Add `client_credentials` grant — §3.3                                                                                     | Feature      | M      |
| 7   | Unify legacy/hub server wiring (legacy = single-tenant hub) — §4.1                                                        | Design       | L      |
| 8   | Single-emit SSE reload events — §2.5                                                                                      | Bug          | XS     |
| 9   | Answer `prompt=none` with `login_required` — §3.4                                                                         | Fidelity     | S      |
| 10  | Remove `ActiveTenantState.config`; move `expandTildePath` to `shared/`; dedupe mutexes and TTL constants — §4.2–4.4, §4.9 | Hygiene      | S      |
| 11  | Reject `--port 0`; live-read refresh TTL; align CORS with README — §2.3, §2.6, §4.7                                       | Bug/Docs     | S      |

Items 1–5 are worth a patch release on their own; 6 and 9 are the highest-leverage feature work; 7 is the one structural investment that pays down the main drift risk before the codebase grows further.
