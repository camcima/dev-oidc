# dev-oidc Stabilization — Alpha → Stable

**Status:** Approved
**Date:** 2026-04-25
**Target version:** `0.1.0` (post-alpha)
**Author:** Carlos Cima

## 1. Context

dev-oidc is currently `0.1.0-alpha.2`. A code review identified ten issues spanning critical bugs, design inconsistencies, and improvement opportunities. This spec turns the review into a single, sequenced delivery that takes the project from alpha to a stable `0.1.0` release.

Alpha status grants latitude to break behavior and shift defaults. This spec uses that latitude where doing so produces a cleaner end state, rather than carrying forward alpha-era compromises into the stable release.

## 2. Goals and non-goals

**Goals**

- Fix the three correctness bugs blocking stable: scope is dropped end-to-end; logout fallback 404s; admin writes emit redundant config-changed events.
- Bring protocol behavior closer to standard OIDC providers: refresh-token rotation, optional client authentication, ES256 algorithm support.
- Pre-calculate the JWKS document so it is built once at boot.
- Replace React+react-dom with a tagged-template renderer to align with the project's "minimal" framing.
- Resolve the `as unknown as FastifyInstance` cast in `src/server.ts`.
- Add a root landing page and a logout confirmation page.

**Non-goals**

- Session/code persistence across restarts. Auth codes have a 60-second TTL; refresh tokens have an 8-hour TTL; restarts are typically intentional. The volatility of in-memory stores will be documented in `README.md` rather than fixed.
- Multi-key JWKS rotation. The server runs one signing key for its lifetime; key rollover is out of scope for `0.1.0`.
- Database-backed configuration storage. The JSON-file model continues.

## 3. Architecture overview

The change set follows three logical groups, each landing as a self-contained commit so a release can cut after group 1 if necessary:

| Group | Theme             | Concrete items                                              |
| ----- | ----------------- | ----------------------------------------------------------- |
| 1     | Critical fixes    | scope propagation; logout/landing pages; watcher dedup      |
| 2     | Protocol fidelity | refresh rotation; optional client secret; ES256; JWKS cache |
| 3     | Cleanup           | React removal; type-cast fix; documentation                 |

No new top-level modules or major architectural shifts. Module boundaries change as follows:

- New `src/shared/html.ts` — tagged-template HTML renderer with built-in escaping. Replaces React.
- New `src/index/page.ts` — root landing page renderer.
- New `src/oidc/logout-page.ts` — signed-out confirmation page renderer.
- `src/login/page.tsx` → `src/login/page.ts` — same render output, new renderer.
- `src/admin/page.tsx` → `src/admin/page.ts` — same render output, new renderer.

## 4. Group 1 — Critical fixes

### 4.1 Scope propagation through the auth flow

**Problem.** `scope` is captured in `PendingAuthStore` at `src/oidc/authorize.ts:69`, then dropped at `src/oidc/complete.ts` (the call to `codes.issue` does not pass it through), then hardcoded to `'openid profile email'` in the response at `src/oidc/token.ts:155`. Developers cannot exercise applications that depend on custom scopes.

**Change.**

- `CodeRecord` (`src/oidc/codes.ts`) gains `scope: string`.
- `RefreshRecord` gains `scope: string` so the refresh flow returns the scope that was originally granted.
- `src/oidc/complete.ts` passes `pending.scope` into `codes.issue`.
- `src/oidc/token.ts` reads `record.scope` for both grants and:
  - Returns it as the `scope` field in the response body (replacing the hardcoded `'openid profile email'`).
  - Includes it as a `scope` claim (space-separated string) on the access token.
- `src/oidc/authorize.ts` validates that the requested scope contains `openid` (per OIDC Core §3.1.2.1). If not, return `400 invalid_scope`.

**Out of scope.** Scope filtering against a per-client allowlist. Clients accept whatever scope the request specifies.

### 4.2 Logout fallback and root landing page

**Problem.** `src/oidc/logout.ts:19` redirects to `/` when `post_logout_redirect_uri` is not provided. There is no `/` route, so users see a 404. Curious users who hit `localhost:8095/` directly experience the same.

**Change.**

- New `GET /` returns an HTML landing page listing:
  - The discovery URL (`/.well-known/openid-configuration`).
  - The JWKS URL (`/.well-known/jwks.json`).
  - A link to `/admin` if the admin UI is enabled (i.e. `configFilePath` is set).
  - A short "use `/authorize?...` to start a login" hint.
- `src/oidc/logout.ts` no longer redirects to `/` when `post_logout_redirect_uri` is absent. Instead it returns 200 with an HTML "Signed out" confirmation page that contains a "Back to home" link to `/`.
- The valid-`post_logout_redirect_uri` path is unchanged: still a 302 to the registered URI.

Both pages render with the new tagged-template renderer (Group 3) and reuse the existing palette in `src/login/styles.ts`.

### 4.3 Admin write / watcher deduplication

**Problem.** `src/admin/profiles-routes.ts` calls `runtime.set(next)` immediately after `writeConfigFile`. Chokidar then fires `change` against the same file, which calls `runtime.set` a second time with the same content. SSE subscribers see `config-changed` twice. Under rapid edits a stale disk read could overwrite a newer in-memory state.

**Change.** Make `runtime.set` content-aware:

- `src/config/runtime.ts` retains the same interface but compares the incoming config to the current one using a stable canonical JSON serialization (sorted object keys).
- If the canonical form is identical, `set` is a no-op: it does not update the stored reference and does not invoke `onChange` handlers.
- If it differs, `set` proceeds as today.

This makes the watcher idempotent without the admin routes and the watcher needing to coordinate. Either path may fire first; the second one becomes a no-op.

**Out of scope.** Concurrent admin writes. Two simultaneous `POST /admin/api/profiles` requests can still race on read-modify-write of the JSON file. This is documented but not addressed; it is acceptable for a single-developer dev tool.

## 5. Group 2 — Protocol fidelity

### 5.1 Refresh token rotation

**Problem.** `consumeRefresh` in `src/oidc/codes.ts:59-67` returns the record without deleting the entry, so a single refresh token can be reused indefinitely. Real OIDC providers rotate refresh tokens.

**Change.** `consumeRefresh` deletes the entry on every successful read (immediately, before returning). `handleRefreshGrant` already issues a new refresh token via `issueRefresh`, so combining the two yields rotation by default. No new config flag.

A reused token returns `400 invalid_grant`. Tests verify rotation issues a new token, the old token is rejected after first use, expired tokens are still rejected.

### 5.2 Optional client authentication

**Schema change.** `ClientSchema` in `src/config/schema.ts` gains `clientSecret: z.string().min(1).optional()`.

**Token endpoint behavior.**

- If the client config has `clientSecret`: the secret is required on `/token`. Accept it via either:
  - `client_secret` form field (`client_secret_post`).
  - `Authorization: Basic base64(client_id:client_secret)` (`client_secret_basic`).
- If both are sent and disagree: `400 invalid_request`.
- If the secret is missing or wrong: `401 invalid_client` with `WWW-Authenticate: Basic`.
- Comparison uses `crypto.timingSafeEqual` against equal-length buffers; unequal lengths short-circuit to mismatch without leaking timing.
- If the client config has no `clientSecret`: token endpoint accepts the request without a secret (current public-client behavior).

**Discovery doc.** `token_endpoint_auth_methods_supported` becomes `["none", "client_secret_post", "client_secret_basic"]`.

### 5.3 ES256 algorithm support

**Schema change.** `SigningKeySchema.alg` becomes `z.enum(['RS256', 'ES256']).default('RS256')`.

**`src/oidc/keys.ts`.**

- `KeyMaterial.alg` becomes `'RS256' | 'ES256'`.
- `generateEphemeralKey` branches on `alg` to call `jose.generateKeyPair('RS256', { extractable: true })` or `jose.generateKeyPair('ES256', { extractable: true })`.
- `loadKeyFromFile` derives the persisted algorithm from `publicJwk.alg` (which `generateEphemeralKey` already sets when creating the JWK). If the persisted `alg` does not match the configured `alg`, throw with the same alignment guidance the existing `kid` mismatch already provides.
- `saveKeyToFile` is unchanged — `publicJwk.alg` already records the algorithm. This preserves backward compatibility with key files written by `0.1.0-alpha.2`.

**Signing call sites.** `src/oidc/token.ts` replaces both hardcoded `alg: 'RS256'` literals in `setProtectedHeader` calls with `alg: deps.keyMaterial.alg`.

**Discovery doc.** `id_token_signing_alg_values_supported` becomes a single-element array reflecting the configured alg, since dev-oidc runs one key at a time.

### 5.4 JWKS pre-calculation

**Problem.** `src/oidc/jwks.ts` rebuilds the JWKS object on every request to `/.well-known/jwks.json`. The key material is immutable for the server's life — config reload does not regenerate keys.

**Change.** In `src/server.ts`, build the JWKS document once after `createKeyMaterial` resolves and cache it in a `const`. The `/.well-known/jwks.json` handler returns the cached object directly. `buildJwks` keeps its current signature; it simply moves to a one-time-at-boot call site.

## 6. Group 3 — Cleanup

### 6.1 React → tagged-template renderer

**New module: `src/shared/html.ts`.**

- `escape(value: unknown): string` — HTML-entity-encodes `&`, `<`, `>`, `"`, `'`. Suitable for both element text and attribute contexts (the OWASP "always escape these five" set).
- Type `Html` — a branded object `{ readonly __html: string }` so the type system distinguishes pre-escaped HTML strings from arbitrary strings.
- `html(strings: TemplateStringsArray, ...values: unknown[]): Html` — tagged template that:
  - Concatenates `strings` verbatim (these are static and trusted).
  - For each interpolated value:
    - If it is `Html`, splice the underlying string in unescaped (it has already been escaped at construction).
    - If it is an array, join with empty string after recursively handling each element.
    - Otherwise, run `escape(value)`.
- `renderToString(h: Html): string` — exposes the underlying string for use as an HTTP response body.

This renderer composes: nested `html\`\``calls produce`Html` values that pass through unescaped, while user-supplied strings are always escaped.

**Page rewrites.** Same DOM output, same CSS via `src/login/styles.ts`, same form action URLs.

- `src/login/page.tsx` → `src/login/page.ts`.
- `src/admin/page.tsx` → `src/admin/page.ts`.
- New `src/index/page.ts`.
- New `src/oidc/logout-page.ts`.

**Dependency removal.** `package.json` removes `react`, `react-dom`, `@types/react`, `@types/react-dom`. `tsconfig.json` removes `"jsx": "react-jsx"`. `tsup.config.ts` keeps its TS-only config.

### 6.2 Eliminate the `as unknown as FastifyInstance` cast

**Root cause.** `Fastify({ loggerInstance: pinoLogger })` returns `FastifyInstance` parameterized with the pino logger type. Plugins like `@fastify/cors` expect `FastifyInstance` parameterized with `FastifyBaseLogger` (the default). The cast at `src/server.ts:50` papers over a generic-parameter mismatch.

**Fix.** Type the logger surface as `FastifyBaseLogger` at the boundary:

- `src/logger.ts` exports `DevOidcLogger = FastifyBaseLogger` (or a type-equal extension). The factory still returns a real `pino.Logger`; only the exported type changes.
- `Fastify(...)` is invoked with an explicit generic so the inferred instance aligns with the default plugin parameterization, removing the `as unknown` cast.

If structural compatibility cannot be reached this way (because some pino-specific method is referenced downstream), the fallback is to declare the plugin generic parameters explicitly at the call site rather than reaching for `as unknown`.

### 6.3 Documentation

- `README.md`:
  - Refresh-token rotation default (with a note that previous-alpha behavior allowed reuse).
  - Optional `clientSecret` usage with both `client_secret_post` and `client_secret_basic` examples.
  - ES256 support and how to switch (`alg: 'ES256'` plus the file-key migration note).
  - In-memory volatility of `CodeStore` and `PendingAuthStore` documented as an explicit non-goal: restarts invalidate active codes/refresh tokens.
- `CHANGELOG.md`: a `0.1.0` section listing breaking and additive changes.
- `examples/config.json`: add commented examples for `clientSecret` and `alg: 'ES256'`.

## 7. Testing strategy

Tests follow the existing layout (unit tests beside source modules, integration tests under `tests/integration`).

**Group 1.**

- `tests/oidc/codes.test.ts` — `CodeRecord` and `RefreshRecord` carry `scope` round-trip.
- `tests/oidc/authorize.test.ts` — request without `openid` in `scope` returns `400 invalid_scope`; request with custom scope persists it.
- `tests/oidc/complete.test.ts` — `pending.scope` is forwarded into `codes.issue`.
- `tests/oidc/token.test.ts` — response `scope` field reflects the granted scope; access token carries a `scope` claim.
- `tests/oidc/logout.test.ts` — no `post_logout_redirect_uri` returns 200 with the confirmation page (not 302).
- New `tests/index/page.test.ts` — root landing page renders required links.
- `tests/config/runtime.test.ts` — `set` with content-equal config is a no-op (no handler invocation).

**Group 2.**

- `tests/oidc/codes.test.ts` — `consumeRefresh` deletes on success; reuse returns null.
- `tests/oidc/token.test.ts` — refresh-token rotation issues a new token; old token rejected after first use.
- `tests/oidc/token.test.ts` — `clientSecret` enforcement: missing → 401; wrong → 401; correct via post → 200; correct via basic → 200; both with mismatch → 400.
- `tests/oidc/keys.test.ts` — ES256 key generation; ES256 file-backed round-trip; alg-mismatch on persisted key throws.
- `tests/oidc/discovery.test.ts` — `id_token_signing_alg_values_supported` and `token_endpoint_auth_methods_supported` reflect configuration.
- `tests/integration/oidc-flow.test.ts` — full flow with ES256 and a client secret; assert returned `scope` and `scope` claim.

**Group 3.**

- New `tests/shared/html.test.ts` — escape correctness across element text, attribute values, double quotes, single quotes, ampersands, angle brackets, unicode passthrough; nested `html\`\``composes; arrays flatten;`Html` interpolations are not double-escaped.
- Existing `tests/login/page.test.ts` and `tests/admin/page.test.ts` keep their HTML-string assertions; they exercise the new renderer indirectly.

## 8. Migration notes for users

- **Refresh tokens rotate.** Apps that cached a single refresh token for repeated use must update to use the rotation-issued token from each `/token` response.
- **Hardcoded `scope` removed.** Apps that ignored the response `scope` field continue to work; apps that asserted `'openid profile email'` will see the actually-requested value.
- **Logout no longer redirects to `/` on missing `post_logout_redirect_uri`.** It now returns an HTML confirmation page. Tests asserting a 302 to `/` need updating.
- **`alg` defaults to `RS256`** (unchanged). Existing file-backed keys are loaded without modification — the algorithm is derived from `publicJwk.alg`, which alpha.2 already wrote.

## 9. Risks

- **React removal regression in admin/login UI.** Mitigation: the existing snapshot-style assertions in `tests/login/page.test.ts` and `tests/admin/page.test.ts` plus a manual smoke test of both pages in a browser.
- **Type alignment for the Fastify cast may be harder than expected.** Mitigation: the fix is the last item in Group 3; if it cannot be achieved cleanly, fall back to a narrower, well-commented assertion rather than `as unknown`.
- **ES256 key files written on this version will fail to load on `0.1.0-alpha.2` if a user downgrades.** alpha.2's `loadKeyFromFile` calls `jose.importJWK(..., 'RS256')` unconditionally. Mitigation: documented in CHANGELOG. RS256 key files remain bidirectionally compatible.

## 10. Open questions

None at spec time.
