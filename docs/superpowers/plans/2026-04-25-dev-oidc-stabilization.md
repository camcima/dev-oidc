# dev-oidc Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take dev-oidc from `0.1.0-alpha.2` to a stable `0.1.0` by fixing three correctness bugs, raising protocol fidelity (refresh rotation, optional client secrets, ES256), pre-calculating JWKS, removing the React dependency, and resolving the FastifyInstance type cast.

**Architecture:** Three logical groups land sequentially. Group 1 (critical fixes) introduces a small `src/shared/html.ts` tagged-template renderer used by two new pages and adds end-to-end scope propagation, watcher dedup, and a logout/landing UX fix. Group 2 (protocol fidelity) adds refresh rotation, optional client authentication, ES256 algorithm support, and JWKS caching. Group 3 (cleanup) migrates the existing React-rendered admin and login pages to the tagged-template renderer, removes React dependencies, fixes the type cast, and updates documentation.

**Tech Stack:** TypeScript (NodeNext ESM), Fastify 5, jose (JWT/JWK), Zod (schema), Vitest, pino, chokidar.

**Spec:** `docs/superpowers/specs/2026-04-25-dev-oidc-stabilization-design.md` (commit `79a173b`).

---

## File Structure

**New files:**

- `src/shared/html.ts` — Tagged-template HTML renderer with auto-escaping. Single responsibility: produce safe HTML strings.
- `src/index/page.ts` — Root landing page renderer. Single responsibility: render the `/` HTML response.
- `src/oidc/logout-page.ts` — Signed-out confirmation page renderer. Single responsibility: render the `/logout` HTML response when no `post_logout_redirect_uri` is provided.
- `tests/shared/html.test.ts` — Unit tests for the renderer.
- `tests/index/page.test.ts` — Unit tests for the landing page.

**Modified files (Group 1):**

- `src/oidc/codes.ts` — `CodeRecord` and `RefreshRecord` carry `scope: string`.
- `src/oidc/complete.ts` — Forwards `pending.scope` into `codes.issue`.
- `src/oidc/token.ts` — Reads `record.scope`, returns it as the response `scope` field, includes a `scope` claim on the access token.
- `src/oidc/authorize.ts` — Validates that the requested scope contains `openid`.
- `src/config/runtime.ts` — `set` becomes content-aware; identical configs are no-ops.
- `src/oidc/logout.ts` — Returns the confirmation page (HTTP 200) when no `post_logout_redirect_uri` is provided.
- `src/server.ts` — Registers the new `GET /` route.

**Modified files (Group 2):**

- `src/oidc/codes.ts` — `consumeRefresh` deletes on success.
- `src/config/schema.ts` — `clientSecret` optional on `ClientSchema`; `alg` allows `ES256`.
- `src/oidc/token.ts` — Optional client-secret enforcement; algorithm sourced from `keyMaterial.alg`.
- `src/oidc/keys.ts` — ES256 generation; algorithm derived from persisted `publicJwk.alg` for backward compatibility.
- `src/oidc/discovery.ts` — Reflects configured signing alg and supported auth methods.
- `src/server.ts` — Pre-calculates JWKS once at boot.

**Modified files (Group 3):**

- `src/login/page.tsx` → `src/login/page.ts` — Same DOM, rendered via `html\`\``.
- `src/admin/page.tsx` → `src/admin/page.ts` — Same DOM, rendered via `html\`\``.
- `src/logger.ts` — Exports `DevOidcLogger = FastifyBaseLogger`.
- `src/server.ts` — Removes `as unknown as FastifyInstance` cast.
- `tsconfig.json` — Removes `"jsx": "react-jsx"`.
- `package.json` — Removes `react`, `react-dom`, `@types/react`, `@types/react-dom`.
- `README.md`, `CHANGELOG.md`, `examples/config.json` — Documentation updates.

---

## GROUP 1 — Critical Fixes

### Task 1: Build the tagged-template HTML renderer

**Files:**

- Create: `src/shared/html.ts`
- Test: `tests/shared/html.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/shared/html.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escape, html, renderToString, Html } from '@/shared/html.js';

describe('escape', () => {
  it('encodes the five HTML-special characters', () => {
    expect(escape('<')).toBe('&lt;');
    expect(escape('>')).toBe('&gt;');
    expect(escape('&')).toBe('&amp;');
    expect(escape('"')).toBe('&quot;');
    expect(escape("'")).toBe('&#39;');
  });

  it('handles a mixed string in one pass', () => {
    expect(escape('<a href="x">&y</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;');
  });

  it('coerces non-strings via String()', () => {
    expect(escape(42)).toBe('42');
    expect(escape(true)).toBe('true');
  });

  it('treats null and undefined as empty strings', () => {
    expect(escape(null)).toBe('');
    expect(escape(undefined)).toBe('');
  });

  it('passes unicode through unchanged', () => {
    expect(escape('café — 日本語')).toBe('café — 日本語');
  });
});

describe('html tagged template', () => {
  it('returns an Html instance with the assembled string', () => {
    const out = html`<p>hello</p>`;
    expect(out).toBeInstanceOf(Html);
    expect(renderToString(out)).toBe('<p>hello</p>');
  });

  it('escapes interpolated user strings', () => {
    const name = '<script>alert(1)</script>';
    const out = html`<p>${name}</p>`;
    expect(renderToString(out)).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('does not double-escape nested Html values', () => {
    const inner = html`<em>${'<b>x</b>'}</em>`;
    const outer = html`<p>${inner}</p>`;
    expect(renderToString(outer)).toBe('<p><em>&lt;b&gt;x&lt;/b&gt;</em></p>');
  });

  it('flattens arrays of Html values', () => {
    const items = ['a', 'b', 'c'].map((c) => html`<li>${c}</li>`);
    const out = html`<ul>
      ${items}
    </ul>`;
    expect(renderToString(out)).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
  });

  it('renders null, undefined, and false as empty', () => {
    const out = html`<p>${null}${undefined}${false}done</p>`;
    expect(renderToString(out)).toBe('<p>done</p>');
  });

  it('escapes interpolation inside attribute contexts', () => {
    const danger = '" onclick="alert(1)';
    const out = html`<a href="${danger}">x</a>`;
    expect(renderToString(out)).toBe('<a href="&quot; onclick=&quot;alert(1)">x</a>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/html.test.ts`
Expected: FAIL with "Cannot find module '@/shared/html.js'".

- [ ] **Step 3: Implement `src/shared/html.ts`**

Create `src/shared/html.ts`:

```ts
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const ESCAPE_RE = /[&<>"']/g;

export function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(ESCAPE_RE, (c) => ESCAPE_MAP[c] ?? c);
}

export class Html {
  constructor(public readonly value: string) {}
}

function interpolate(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value === null || value === undefined || value === false) return '';
  return escape(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i] ?? '';
    if (i < values.length) out += interpolate(values[i]);
  }
  return new Html(out);
}

export function renderToString(h: Html): string {
  return h.value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/html.test.ts`
Expected: PASS, all 11 tests green.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/html.ts tests/shared/html.test.ts
git commit -m "feat(html): tagged-template renderer with auto-escaping"
```

---

### Task 2: Add `scope` to `CodeRecord` and `RefreshRecord`

**Files:**

- Modify: `src/oidc/codes.ts`
- Modify: `tests/oidc/codes.test.ts`

- [ ] **Step 1: Update the failing tests in `tests/oidc/codes.test.ts`**

Replace the file contents with:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createCodeStore } from '@/oidc/codes.js';
import { createPendingAuthStore } from '@/oidc/pending.js';

describe('CodeStore (authorization codes)', () => {
  it('issues a code consumable exactly once and round-trips scope', () => {
    const store = createCodeStore({ ttlMs: 60_000 });
    const code = store.issue({
      clientId: 'c1',
      profileId: 'alice',
      codeChallenge: 'xyz',
      nonce: 'n1',
      redirectUri: 'http://localhost/cb',
      scope: 'openid profile custom_scope',
    });

    const first = store.consume(code);
    expect(first?.profileId).toBe('alice');
    expect(first?.scope).toBe('openid profile custom_scope');

    const second = store.consume(code);
    expect(second).toBeNull();
  });

  it('rejects consumption after TTL expiry', () => {
    vi.useFakeTimers();
    const store = createCodeStore({ ttlMs: 1_000 });
    const code = store.issue({
      clientId: 'c1',
      profileId: 'alice',
      codeChallenge: 'xyz',
      nonce: 'n1',
      redirectUri: 'http://localhost/cb',
      scope: 'openid',
    });

    vi.advanceTimersByTime(1_500);
    expect(store.consume(code)).toBeNull();
    vi.useRealTimers();
  });
});

describe('CodeStore (refresh tokens)', () => {
  it('issues and validates a refresh token with scope round-trip', () => {
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
    const token = store.issueRefresh({
      clientId: 'c1',
      profileId: 'alice',
      scope: 'openid profile',
    });

    const consumed = store.consumeRefresh(token);
    expect(consumed?.profileId).toBe('alice');
    expect(consumed?.scope).toBe('openid profile');
  });

  it('refresh token expires after TTL', () => {
    vi.useFakeTimers();
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 1_000 });
    const token = store.issueRefresh({
      clientId: 'c1',
      profileId: 'alice',
      scope: 'openid',
    });
    vi.advanceTimersByTime(1_500);
    expect(store.consumeRefresh(token)).toBeNull();
    vi.useRealTimers();
  });
});

describe('PendingAuthStore', () => {
  it('stores and retrieves by id; single-use', () => {
    const store = createPendingAuthStore({ ttlMs: 60_000 });
    const id = store.create({
      clientId: 'c1',
      redirectUri: 'http://localhost/cb',
      codeChallenge: 'xyz',
      codeChallengeMethod: 'S256',
      nonce: 'n1',
      state: 's1',
      scope: 'openid',
    });

    const rec = store.consume(id);
    expect(rec?.clientId).toBe('c1');
    expect(store.consume(id)).toBeNull();
  });
});
```

> Note: The previous "refresh token stays valid within its TTL (not single-use)" assertion is intentionally removed. Group 2 makes refresh tokens single-use; this plan accepts that the existing test asserts the soon-to-change behavior and replaces it with the round-trip test now. Group 2 will add the rotation test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/oidc/codes.test.ts`
Expected: FAIL with TypeScript / property-missing errors on `scope`.

- [ ] **Step 3: Update `src/oidc/codes.ts` to add `scope`**

Replace the file contents with:

```ts
import { randomBytes } from 'node:crypto';

export interface CodeRecord {
  clientId: string;
  profileId: string;
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
  scope: string;
}

export interface RefreshRecord {
  clientId: string;
  profileId: string;
  scope: string;
}

export interface CodeStoreOptions {
  ttlMs: number;
  refreshTtlMs?: number;
}

export interface CodeStore {
  issue: (record: CodeRecord) => string;
  consume: (code: string) => CodeRecord | null;
  issueRefresh: (record: RefreshRecord) => string;
  consumeRefresh: (token: string) => RefreshRecord | null;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createCodeStore(options: CodeStoreOptions): CodeStore {
  const codes = new Map<string, Entry<CodeRecord>>();
  const refresh = new Map<string, Entry<RefreshRecord>>();
  const refreshTtlMs = options.refreshTtlMs ?? 8 * 60 * 60 * 1_000;

  const mint = (bytes: number): string => randomBytes(bytes).toString('base64url');
  const isExpired = (e: Entry<unknown>): boolean => Date.now() > e.expiresAt;

  return {
    issue(record) {
      const code = mint(32);
      codes.set(code, { value: record, expiresAt: Date.now() + options.ttlMs });
      return code;
    },
    consume(code) {
      const entry = codes.get(code);
      if (!entry) return null;
      codes.delete(code);
      if (isExpired(entry)) return null;
      return entry.value;
    },
    issueRefresh(record) {
      const token = mint(48);
      refresh.set(token, { value: record, expiresAt: Date.now() + refreshTtlMs });
      return token;
    },
    consumeRefresh(token) {
      const entry = refresh.get(token);
      if (!entry) return null;
      if (isExpired(entry)) {
        refresh.delete(token);
        return null;
      }
      return entry.value;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/oidc/codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: errors in `src/oidc/complete.ts` and `src/oidc/token.ts` because `scope` is now required on `CodeRecord` and `RefreshRecord`. These are fixed in the next task — proceed.

- [ ] **Step 6: Commit (deferred)**

Do **not** commit yet — the typecheck errors block compilation. The next task closes them.

---

### Task 3: Forward `scope` through `complete.ts` and `token.ts`

**Files:**

- Modify: `src/oidc/complete.ts`
- Modify: `src/oidc/token.ts`
- Modify: `tests/oidc/token.test.ts`
- Modify: `tests/integration/oidc-flow.test.ts`

- [ ] **Step 1: Update `src/oidc/complete.ts`**

Replace lines 53-59 (the call to `deps.codes.issue`):

Old:

```ts
const code = deps.codes.issue({
  clientId: pending.clientId,
  profileId: profile.id,
  codeChallenge: pending.codeChallenge,
  nonce: pending.nonce,
  redirectUri: allowedUri,
});
```

New:

```ts
const code = deps.codes.issue({
  clientId: pending.clientId,
  profileId: profile.id,
  codeChallenge: pending.codeChallenge,
  nonce: pending.nonce,
  redirectUri: allowedUri,
  scope: pending.scope,
});
```

- [ ] **Step 2: Update `src/oidc/token.ts` to forward scope**

Apply these edits:

1. Change the `issueTokenSet` signature to accept `scope`:

Old (lines 115-121):

```ts
async function issueTokenSet(
  deps: TokenDeps,
  profile: Profile,
  clientId: string,
  nonce: string,
  reply: FastifyReply,
): Promise<unknown> {
```

New:

```ts
async function issueTokenSet(
  deps: TokenDeps,
  profile: Profile,
  clientId: string,
  nonce: string,
  scope: string,
  reply: FastifyReply,
): Promise<unknown> {
```

2. In `handleCodeGrant`, change the call (line 87) from:

```ts
return issueTokenSet(deps, profile, record.clientId, record.nonce, reply);
```

to:

```ts
return issueTokenSet(deps, profile, record.clientId, record.nonce, record.scope, reply);
```

3. In `handleRefreshGrant`, change the call (line 112) from:

```ts
return issueTokenSet(deps, profile, record.clientId, '', reply);
```

to:

```ts
return issueTokenSet(deps, profile, record.clientId, '', record.scope, reply);
```

4. Inside `issueTokenSet`, include `scope` as a claim on the access token. Replace the `accessToken` block (lines 129-136):

Old:

```ts
const accessToken = await new jose.SignJWT(baseClaims)
  .setProtectedHeader({ alg: 'RS256', kid: deps.keyMaterial.kid, typ: 'JWT' })
  .setIssuer(config.issuer)
  .setAudience(client.audience)
  .setSubject(profile.id)
  .setIssuedAt()
  .setExpirationTime(`${config.tokenTtlSeconds}s`)
  .sign(deps.keyMaterial.privateKey);
```

New:

```ts
const accessToken = await new jose.SignJWT({ ...baseClaims, scope })
  .setProtectedHeader({ alg: 'RS256', kid: deps.keyMaterial.kid, typ: 'JWT' })
  .setIssuer(config.issuer)
  .setAudience(client.audience)
  .setSubject(profile.id)
  .setIssuedAt()
  .setExpirationTime(`${config.tokenTtlSeconds}s`)
  .sign(deps.keyMaterial.privateKey);
```

5. Replace the `issueRefresh` call (line 147) from:

```ts
const refreshToken = deps.codes.issueRefresh({ clientId, profileId: profile.id });
```

to:

```ts
const refreshToken = deps.codes.issueRefresh({ clientId, profileId: profile.id, scope });
```

6. Replace the response body (lines 149-156) from:

```ts
return reply.code(200).send({
  access_token: accessToken,
  token_type: 'Bearer',
  expires_in: config.tokenTtlSeconds,
  refresh_token: refreshToken,
  id_token: idToken,
  scope: 'openid profile email',
});
```

to:

```ts
return reply.code(200).send({
  access_token: accessToken,
  token_type: 'Bearer',
  expires_in: config.tokenTtlSeconds,
  refresh_token: refreshToken,
  id_token: idToken,
  scope,
});
```

- [ ] **Step 3: Update `tests/oidc/token.test.ts` — first existing test seeds scope and asserts on it**

In `tests/oidc/token.test.ts`, find the test "exchanges a valid code for a verifiable access token" (around line 57). Locate the `codes.issue` call and add `scope`:

Old:

```ts
const code = codes.issue({
  clientId: 'my-app',
  profileId: 'alice',
  codeChallenge: s256(verifier),
  nonce: 'n1',
  redirectUri: 'http://localhost:5173/auth/callback',
});
```

New:

```ts
const code = codes.issue({
  clientId: 'my-app',
  profileId: 'alice',
  codeChallenge: s256(verifier),
  nonce: 'n1',
  redirectUri: 'http://localhost:5173/auth/callback',
  scope: 'openid profile custom_scope',
});
```

After the `expect(payload.sub).toBe('alice')` assertion (around line 92), add:

```ts
expect((payload as Record<string, unknown>).scope).toBe('openid profile custom_scope');
expect((res.json() as { scope: string }).scope).toBe('openid profile custom_scope');
```

- [ ] **Step 4: Update remaining existing token tests to include scope**

For the other `codes.issue` calls in `tests/oidc/token.test.ts` (the "rejects with invalid_grant" test and the "rejects when the code has already been consumed" test), append `scope: 'openid'` to each `codes.issue` payload.

For the `codes.issueRefresh` call in the "exchanges a valid refresh token" test (around line 168), change it from:

```ts
const refreshToken = codes.issueRefresh({ clientId: 'my-app', profileId: 'alice' });
```

to:

```ts
const refreshToken = codes.issueRefresh({
  clientId: 'my-app',
  profileId: 'alice',
  scope: 'openid profile',
});
```

After the `expect(payload.sub).toBe('alice')` assertion in that test, add:

```ts
expect((payload as Record<string, unknown>).scope).toBe('openid profile');
```

- [ ] **Step 5: Update `tests/oidc/complete.test.ts` to assert scope is forwarded**

Open `tests/oidc/complete.test.ts`. Locate any test that asserts `codes.issue` was called and add an assertion about the `scope` field reflecting the value persisted in the pending record. If no such test exists, add this test at the end of the existing `describe` block:

```ts
it('forwards the pending-record scope into the issued code', async () => {
  const { app, codes, pending } = await buildApp();
  const pendingId = pending.create({
    clientId: 'my-app',
    redirectUri: 'http://localhost:5173/cb',
    codeChallenge: 'cc',
    codeChallengeMethod: 'S256',
    nonce: 'n1',
    state: 's1',
    scope: 'openid email custom_scope',
  });

  const res = await app.inject({
    method: 'POST',
    url: '/authorize/complete',
    payload: { pendingAuthId: pendingId, profileId: 'alice' },
  });
  expect(res.statusCode).toBe(302);
  const location = res.headers.location as string;
  const codeMatch = /[?&]code=([^&]+)/.exec(location);
  expect(codeMatch).not.toBeNull();
  const record = codes.consume(codeMatch![1]!);
  expect(record?.scope).toBe('openid email custom_scope');
  await app.close();
});
```

(If `tests/oidc/complete.test.ts` does not currently expose `codes` and `pending` from `buildApp`, mirror the helper signature already used in `tests/oidc/authorize.test.ts` — return them alongside the app.)

- [ ] **Step 6: Update `tests/integration/oidc-flow.test.ts` to assert end-to-end scope**

Open `tests/integration/oidc-flow.test.ts`. In the principal happy-path test, after exchanging the code for tokens, add:

```ts
expect((tokenBody as { scope: string }).scope).toContain('openid');
```

If a custom scope is requested in the integration test, also assert that the access-token payload carries the matching `scope` claim.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: PASS across all suites.

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/oidc/codes.ts src/oidc/complete.ts src/oidc/token.ts tests/oidc/codes.test.ts tests/oidc/token.test.ts tests/oidc/complete.test.ts tests/integration/oidc-flow.test.ts
git commit -m "fix(oidc): propagate scope through pending → code → token response"
```

---

### Task 4: Reject `/authorize` requests missing `openid` from scope

**Files:**

- Modify: `src/oidc/authorize.ts`
- Modify: `tests/oidc/authorize.test.ts`

- [ ] **Step 1: Add the failing test**

Open `tests/oidc/authorize.test.ts`. Inside the existing `describe('GET /authorize')` block, add:

```ts
it('returns 400 invalid_scope when the requested scope does not include openid', async () => {
  const { app } = await buildApp();
  const params = new URLSearchParams(validParams);
  params.set('scope', 'profile email');
  const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe('invalid_scope');
  await app.close();
});

it('accepts a scope that includes openid plus custom values', async () => {
  const { app, pending } = await buildApp();
  const params = new URLSearchParams(validParams);
  params.set('scope', 'openid custom_scope');
  const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
  expect(res.statusCode).toBe(200);
  const match = res.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/);
  expect(match).not.toBeNull();
  const rec = pending.consume(match![1]!);
  expect(rec?.scope).toBe('openid custom_scope');
  await app.close();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/oidc/authorize.test.ts`
Expected: FAIL on the new "invalid_scope" test (server currently returns 200 because it does not enforce `openid`).

- [ ] **Step 3: Implement the validation in `src/oidc/authorize.ts`**

After the existing `code_challenge_method` validation (around line 60, after the `if (query.code_challenge_method !== 'S256')` block), insert:

```ts
const requestedScope = query.scope ?? 'openid';
const scopeTokens = requestedScope.split(/\s+/).filter(Boolean);
if (!scopeTokens.includes('openid')) {
  return reply.code(400).send({
    error: 'invalid_scope',
    error_description: 'scope must contain "openid"',
  });
}
```

Then change the `pending.create` call (line 62 onward) to use the validated `requestedScope`. The full block becomes:

```ts
const pendingAuthId = deps.pending.create({
  clientId: client.clientId,
  redirectUri: query.redirect_uri,
  codeChallenge: query.code_challenge,
  codeChallengeMethod: 'S256',
  nonce: query.nonce ?? '',
  state: query.state ?? '',
  scope: requestedScope,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/oidc/authorize.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/oidc/authorize.ts tests/oidc/authorize.test.ts
git commit -m "feat(authorize): require openid in requested scope"
```

---

### Task 5: Make `runtime.set` content-aware (watcher dedup)

**Files:**

- Modify: `src/config/runtime.ts`
- Test: `tests/config/runtime.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `tests/config/runtime.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';

function baseConfig(): Config {
  return {
    issuer: 'http://localhost:8095',
    port: 8095,
    host: '127.0.0.1',
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [
      {
        clientId: 'a',
        redirectUris: ['http://localhost/cb'],
        postLogoutRedirectUris: [],
        audience: 'aud',
      },
    ],
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'T', accentColor: '#000', logoUrl: null },
    profiles: [],
  };
}

describe('createRuntimeConfig', () => {
  it('exposes the initial config via get()', () => {
    const r = createRuntimeConfig(baseConfig());
    expect(r.get().issuer).toBe('http://localhost:8095');
  });

  it('updates and notifies handlers when set() receives a different config', () => {
    const r = createRuntimeConfig(baseConfig());
    const handler = vi.fn();
    r.onChange(handler);

    const next = { ...baseConfig(), issuer: 'http://localhost:9000' };
    r.set(next);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(r.get().issuer).toBe('http://localhost:9000');
  });

  it('is a no-op when set() receives a content-equal config (same shape, key order differs)', () => {
    const r = createRuntimeConfig(baseConfig());
    const handler = vi.fn();
    r.onChange(handler);

    // Same fields, different property order — canonical form must match.
    const cfg = baseConfig();
    const reordered: Config = {
      profiles: cfg.profiles,
      branding: cfg.branding,
      refreshTokenTtlSeconds: cfg.refreshTokenTtlSeconds,
      tokenTtlSeconds: cfg.tokenTtlSeconds,
      subjectClaim: cfg.subjectClaim,
      clients: cfg.clients,
      signingKey: cfg.signingKey,
      host: cfg.host,
      port: cfg.port,
      issuer: cfg.issuer,
    };
    r.set(reordered);

    expect(handler).not.toHaveBeenCalled();
  });

  it('removes the handler when the unsubscribe is called', () => {
    const r = createRuntimeConfig(baseConfig());
    const handler = vi.fn();
    const unsubscribe = r.onChange(handler);
    unsubscribe();
    r.set({ ...baseConfig(), issuer: 'http://localhost:9000' });
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/runtime.test.ts`
Expected: FAIL on the "content-equal" test — current implementation invokes handlers unconditionally.

- [ ] **Step 3: Implement content-aware `set` in `src/config/runtime.ts`**

Replace the file contents with:

```ts
import type { Config } from '@/config/schema.js';

export interface RuntimeConfig {
  get: () => Config;
  set: (config: Config) => void;
  onChange: (handler: (config: Config) => void) => () => void;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

export function createRuntimeConfig(initial: Config): RuntimeConfig {
  let current = initial;
  let currentCanonical = canonicalize(initial);
  const handlers = new Set<(config: Config) => void>();

  return {
    get: () => current,
    set: (config: Config) => {
      const nextCanonical = canonicalize(config);
      if (nextCanonical === currentCanonical) return;
      current = config;
      currentCanonical = nextCanonical;
      for (const handler of handlers) handler(current);
    },
    onChange: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: PASS — confirms the change is compatible with admin and integration tests.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config/runtime.ts tests/config/runtime.test.ts
git commit -m "fix(runtime): dedupe identical config updates from watcher and admin writes"
```

---

### Task 6: Add the root landing page

**Files:**

- Create: `src/index/page.ts`
- Create: `tests/index/page.test.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/index/page.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderIndexPage } from '@/index/page.js';
import type { Config } from '@/config/schema.js';

function config(): Config {
  return {
    issuer: 'http://localhost:8095',
    port: 8095,
    host: '127.0.0.1',
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [],
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'Dev OIDC', accentColor: '#1f6feb', logoUrl: null },
    profiles: [],
  };
}

describe('renderIndexPage', () => {
  it('returns a full HTML document', () => {
    const html = renderIndexPage({ config: config(), adminEnabled: false });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>');
  });

  it('lists discovery and JWKS endpoints', () => {
    const html = renderIndexPage({ config: config(), adminEnabled: false });
    expect(html).toContain('/.well-known/openid-configuration');
    expect(html).toContain('/.well-known/jwks.json');
  });

  it('shows the issuer from config', () => {
    const html = renderIndexPage({ config: config(), adminEnabled: false });
    expect(html).toContain('http://localhost:8095');
  });

  it('includes a link to /admin only when adminEnabled is true', () => {
    expect(renderIndexPage({ config: config(), adminEnabled: false })).not.toMatch(
      /href="\/admin"/,
    );
    expect(renderIndexPage({ config: config(), adminEnabled: true })).toMatch(/href="\/admin"/);
  });

  it('escapes the issuer when interpolated into HTML', () => {
    const cfg = config();
    cfg.issuer = 'http://<evil>';
    const html = renderIndexPage({ config: cfg, adminEnabled: false });
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/index/page.test.ts`
Expected: FAIL with "Cannot find module '@/index/page.js'".

- [ ] **Step 3: Implement `src/index/page.ts`**

Create `src/index/page.ts`:

```ts
import type { Config } from '@/config/schema.js';
import { Html, html, renderToString } from '@/shared/html.js';

const STYLES = `
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c;
    max-width: 720px;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.125rem; margin: 1.75rem 0 0.5rem; }
  p { line-height: 1.5; }
  code { background: #eef0f3; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.95em; }
  ul { padding-left: 1.25rem; }
  li { margin: 0.25rem 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
`.trim();

export interface RenderIndexPageInput {
  config: Config;
  adminEnabled: boolean;
}

export function renderIndexPage(input: RenderIndexPageInput): string {
  const { config, adminEnabled } = input;
  const adminLink = adminEnabled ? html`<li><a href="/admin">Admin UI</a></li>` : '';

  const doc = html`<!doctype html>
    <html lang="en" style="--accent: ${config.branding.accentColor}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${config.branding.title}</title>
        <style>
          ${new Html(STYLES)}
        </style>
      </head>
      <body>
        <h1>dev-oidc</h1>
        <p>Local OIDC provider running at <code>${config.issuer}</code>.</p>
        <h2>Endpoints</h2>
        <ul>
          <li><a href="/.well-known/openid-configuration">Discovery document</a></li>
          <li><a href="/.well-known/jwks.json">JWKS</a></li>
          ${adminLink}
        </ul>
        <h2>Start a login</h2>
        <p>
          Send a browser to
          <code
            >/authorize?client_id=...&amp;redirect_uri=...&amp;response_type=code&amp;code_challenge=...&amp;code_challenge_method=S256&amp;scope=openid</code
          >
          to begin the auth-code flow.
        </p>
      </body>
    </html>`;

  return renderToString(doc);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/index/page.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the route in `src/server.ts`**

Open `src/server.ts`. Add the import near the other page imports (top of file):

```ts
import { renderIndexPage } from '@/index/page.js';
```

After the JWKS route (around line 70, immediately before `registerAuthorize(...)`), insert:

```ts
app.get('/', async (_request, reply) => {
  const adminEnabled = Boolean(options.configFilePath);
  return reply
    .code(200)
    .type('text/html; charset=utf-8')
    .send(renderIndexPage({ config: runtime.get(), adminEnabled }));
});
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/index/page.ts tests/index/page.test.ts src/server.ts
git commit -m "feat(server): add root landing page with endpoint links"
```

---

### Task 7: Replace logout-fallback redirect with a confirmation page

**Files:**

- Create: `src/oidc/logout-page.ts`
- Modify: `src/oidc/logout.ts`
- Modify: `tests/oidc/logout.test.ts`

- [ ] **Step 1: Update `tests/oidc/logout.test.ts`**

Replace the test "redirects to '/' when no post_logout_redirect_uri provided" (lines 48-54). Change it to assert HTML 200:

```ts
it('returns a 200 HTML confirmation page when no post_logout_redirect_uri is provided', async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/logout' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/html');
  expect(res.payload).toContain('Signed out');
  expect(res.payload).toMatch(/href="\/"/);
  await app.close();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/oidc/logout.test.ts`
Expected: FAIL on the new test (current implementation returns 302).

- [ ] **Step 3: Create `src/oidc/logout-page.ts`**

Create `src/oidc/logout-page.ts`:

```ts
import type { Branding } from '@/config/schema.js';
import { Html, html, renderToString } from '@/shared/html.js';

const STYLES = `
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c;
    display: flex; flex-direction: column; align-items: flex-start;
    max-width: 480px;
  }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  p { line-height: 1.5; margin: 0 0 1rem; }
  a {
    display: inline-block;
    color: var(--accent); text-decoration: none;
    border-bottom: 1px dashed currentColor;
  }
  a:hover { text-decoration: none; border-bottom-style: solid; }
`.trim();

export interface RenderLogoutPageInput {
  branding: Branding;
}

export function renderLogoutPage(input: RenderLogoutPageInput): string {
  const { branding } = input;
  const doc = html`<!doctype html>
    <html lang="en" style="--accent: ${branding.accentColor}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${branding.title} — Signed out</title>
        <style>
          ${new Html(STYLES)}
        </style>
      </head>
      <body>
        <h1>Signed out</h1>
        <p>You have been logged out of dev-oidc.</p>
        <a href="/">Back to home</a>
      </body>
    </html>`;
  return renderToString(doc);
}
```

- [ ] **Step 4: Update `src/oidc/logout.ts`**

Replace the file contents with:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RuntimeConfig } from '@/config/runtime.js';
import { renderLogoutPage } from '@/oidc/logout-page.js';

export interface LogoutDeps {
  runtime: RuntimeConfig;
}

interface LogoutQuery {
  post_logout_redirect_uri?: string;
}

export function registerLogout(app: FastifyInstance, deps: LogoutDeps): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const query = request.query as LogoutQuery;
    const requested = query.post_logout_redirect_uri;
    const config = deps.runtime.get();

    if (!requested) {
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(renderLogoutPage({ branding: config.branding }));
    }

    const allowedUri = config.clients
      .flatMap((c) => c.postLogoutRedirectUris)
      .find((u) => u === requested);

    if (!allowedUri) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'post_logout_redirect_uri not registered',
      });
    }

    return reply.code(302).header('location', allowedUri).send();
  };

  app.get('/logout', handler);
  app.post('/logout', handler);
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/oidc/logout.test.ts`
Expected: PASS.

- [ ] **Step 6: Run all tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/oidc/logout.ts src/oidc/logout-page.ts tests/oidc/logout.test.ts
git commit -m "fix(logout): replace fallback redirect to / with HTML confirmation page"
```

---

## GROUP 2 — Protocol Fidelity

### Task 8: Refresh token rotation

**Files:**

- Modify: `src/oidc/codes.ts`
- Modify: `tests/oidc/codes.test.ts`
- Modify: `tests/oidc/token.test.ts`

- [ ] **Step 1: Add the rotation tests in `tests/oidc/codes.test.ts`**

Inside the existing `describe('CodeStore (refresh tokens)', ...)` block, add (after the round-trip test):

```ts
it('rotates: a refresh token is single-use; second consumption returns null', () => {
  const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
  const token = store.issueRefresh({
    clientId: 'c1',
    profileId: 'alice',
    scope: 'openid',
  });

  expect(store.consumeRefresh(token)?.profileId).toBe('alice');
  expect(store.consumeRefresh(token)).toBeNull();
});
```

- [ ] **Step 2: Add an end-to-end rotation test in `tests/oidc/token.test.ts`**

Inside the existing `describe('POST /token (refresh_token)', ...)` block, add:

```ts
it('rotates the refresh token: the old one is rejected after first use', async () => {
  const { app, codes } = await buildApp();
  const oldToken = codes.issueRefresh({
    clientId: 'my-app',
    profileId: 'alice',
    scope: 'openid profile',
  });

  const first = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: oldToken,
      client_id: 'my-app',
    }).toString(),
  });
  expect(first.statusCode).toBe(200);
  const newToken = (first.json() as { refresh_token: string }).refresh_token;
  expect(newToken).not.toBe(oldToken);

  const second = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: oldToken,
      client_id: 'my-app',
    }).toString(),
  });
  expect(second.statusCode).toBe(400);
  expect(second.json().error).toBe('invalid_grant');
  await app.close();
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run tests/oidc/codes.test.ts tests/oidc/token.test.ts`
Expected: FAIL — `consumeRefresh` currently returns the same record on every call.

- [ ] **Step 4: Update `consumeRefresh` in `src/oidc/codes.ts`**

In the `consumeRefresh` body, delete the entry on every successful read. Replace:

```ts
consumeRefresh(token) {
  const entry = refresh.get(token);
  if (!entry) return null;
  if (isExpired(entry)) {
    refresh.delete(token);
    return null;
  }
  return entry.value;
},
```

with:

```ts
consumeRefresh(token) {
  const entry = refresh.get(token);
  if (!entry) return null;
  refresh.delete(token);
  if (isExpired(entry)) return null;
  return entry.value;
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/oidc/codes.ts tests/oidc/codes.test.ts tests/oidc/token.test.ts
git commit -m "feat(token): rotate refresh tokens on every use"
```

---

### Task 9: Optional client authentication via `clientSecret`

**Files:**

- Modify: `src/config/schema.ts`
- Modify: `src/oidc/token.ts`
- Modify: `src/oidc/discovery.ts`
- Modify: `tests/oidc/token.test.ts`
- Modify: `tests/oidc/discovery.test.ts`

- [ ] **Step 1: Add tests covering all client-secret cases**

Inside `tests/oidc/token.test.ts`, add a new top-level `describe` block at the end of the file:

```ts
function buildConfigWithSecret(): Config {
  return {
    issuer: 'http://localhost:8095',
    port: 8095,
    host: '127.0.0.1',
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [
      {
        clientId: 'confidential-app',
        clientSecret: 's3cr3t-value',
        redirectUris: ['http://localhost:5173/auth/callback'],
        postLogoutRedirectUris: [],
        audience: 'my-api',
      },
    ],
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'T', accentColor: '#000', logoUrl: null },
    profiles: [
      {
        id: 'alice',
        displayName: 'Alice',
        email: 'a@x.com',
        avatar: null,
        claims: {},
      },
    ],
  };
}

async function buildAppWithSecret() {
  const runtime = createRuntimeConfig(buildConfigWithSecret());
  const codes = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
  const keyMaterial = await createKeyMaterial(runtime.get().signingKey);
  const app = Fastify();
  await app.register(formbody);
  registerToken(app, { runtime, codes, keyMaterial });
  return { app, codes };
}

describe('POST /token (client_secret enforcement)', () => {
  function payload(extra: Record<string, string>): string {
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    return new URLSearchParams({
      grant_type: 'authorization_code',
      code_verifier: verifier,
      client_id: 'confidential-app',
      redirect_uri: 'http://localhost:5173/auth/callback',
      ...extra,
    }).toString();
  }

  function issue(codes: CodeStore): string {
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    return codes.issue({
      clientId: 'confidential-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: 'n1',
      redirectUri: 'http://localhost:5173/auth/callback',
      scope: 'openid',
    });
  }

  it('returns 401 invalid_client when secret is missing', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload({ code }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(res.headers['www-authenticate']).toMatch(/Basic/i);
    await app.close();
  });

  it('returns 401 invalid_client when secret is wrong', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload({ code, client_secret: 'wrong-secret' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    await app.close();
  });

  it('accepts a correct secret via client_secret_post', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload({ code, client_secret: 's3cr3t-value' }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('accepts a correct secret via client_secret_basic (HTTP Basic)', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const basic = Buffer.from('confidential-app:s3cr3t-value').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      payload: payload({ code }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 400 invalid_request when basic and form values disagree', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const basic = Buffer.from('confidential-app:s3cr3t-value').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      payload: payload({ code, client_secret: 'different-secret' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    await app.close();
  });
});
```

At the top of the file, add the missing imports:

```ts
import type { CodeStore } from '@/oidc/codes.js';
```

- [ ] **Step 2: Update `src/config/schema.ts`**

In `ClientSchema` (line 9), add `clientSecret`:

```ts
const ClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  redirectUris: z.array(z.string().url()).min(1),
  postLogoutRedirectUris: z.array(z.string().url()).default([]),
  audience: z.string().min(1),
});
```

- [ ] **Step 3: Update `src/oidc/token.ts` to enforce the secret**

At the top of `src/oidc/token.ts`, add:

```ts
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
```

(merge with existing fastify import — `import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';`).

Update the `TokenBody` interface to include `client_secret`:

```ts
interface TokenBody {
  grant_type?: string;
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
}
```

Add a credentials extraction helper near the top (after `s256`):

```ts
interface ExtractedCreds {
  clientId?: string;
  secret?: string;
  conflict?: boolean;
}

function extractClientCredentials(request: FastifyRequest, body: TokenBody): ExtractedCreds {
  const auth = request.headers.authorization;
  let basicId: string | undefined;
  let basicSecret: string | undefined;
  if (auth && /^Basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx > 0) {
      basicId = decoded.slice(0, idx);
      basicSecret = decoded.slice(idx + 1);
    }
  }

  const formId = body.client_id;
  const formSecret = body.client_secret;

  if (basicId && formId && basicId !== formId) return { conflict: true };
  if (basicSecret && formSecret && basicSecret !== formSecret) return { conflict: true };

  return { clientId: basicId ?? formId, secret: basicSecret ?? formSecret };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
```

Update `registerToken` to accept the request reference and replace the dispatcher:

```ts
export function registerToken(app: FastifyInstance, deps: TokenDeps): void {
  app.post('/token', async (request, reply) => {
    const body = request.body as TokenBody;
    const creds = extractClientCredentials(request, body);
    if (creds.conflict) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'client credentials disagree between Authorization header and body',
      });
    }
    if (!creds.clientId) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'client_id required' });
    }

    const config = deps.runtime.get();
    const client = config.clients.find((c) => c.clientId === creds.clientId);
    if (!client) {
      return reply.code(401).header('www-authenticate', 'Basic').send({ error: 'invalid_client' });
    }

    if (client.clientSecret) {
      if (!creds.secret || !constantTimeEqual(client.clientSecret, creds.secret)) {
        return reply
          .code(401)
          .header('www-authenticate', 'Basic')
          .send({ error: 'invalid_client' });
      }
    }

    // Override body.client_id with the verified id, in case the body field
    // was missing but Basic auth supplied it.
    body.client_id = creds.clientId;

    switch (body.grant_type) {
      case 'authorization_code':
        return handleCodeGrant(deps, body, reply);
      case 'refresh_token':
        return handleRefreshGrant(deps, body, reply);
      default:
        return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
  });
}
```

- [ ] **Step 4: Update `src/oidc/discovery.ts`**

Change the discovery doc to advertise the new methods. Replace the function body to add the methods supported list:

```ts
export interface DiscoveryInput {
  issuer: string;
  signingAlg: 'RS256' | 'ES256';
  authMethods: readonly ('none' | 'client_secret_post' | 'client_secret_basic')[];
}

export function buildDiscoveryDocument(input: DiscoveryInput): DiscoveryDocument {
  const issuer = input.issuer.replace(/\/+$/, '');
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    end_session_endpoint: `${issuer}/logout`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: [input.signingAlg],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: input.authMethods,
  };
}
```

- [ ] **Step 5: Update the discovery call site in `src/server.ts`**

Replace the discovery handler (around line 64-66):

```ts
app.get('/.well-known/openid-configuration', async () => {
  return buildDiscoveryDocument({ issuer: runtime.get().issuer });
});
```

with:

```ts
app.get('/.well-known/openid-configuration', async () => {
  const cfg = runtime.get();
  const hasSecretClient = cfg.clients.some((c) => c.clientSecret !== undefined);
  const authMethods: ('none' | 'client_secret_post' | 'client_secret_basic')[] = hasSecretClient
    ? ['none', 'client_secret_post', 'client_secret_basic']
    : ['none'];
  return buildDiscoveryDocument({
    issuer: cfg.issuer,
    signingAlg: keyMaterial.alg,
    authMethods,
  });
});
```

- [ ] **Step 6: Update `tests/oidc/discovery.test.ts`**

Replace the existing tests to call with the new signature:

```ts
import { describe, expect, it } from 'vitest';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';

describe('buildDiscoveryDocument', () => {
  it('returns a conformant doc with all required endpoints', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none'],
    });
    expect(doc.issuer).toBe('http://localhost:8095');
    expect(doc.authorization_endpoint).toBe('http://localhost:8095/authorize');
    expect(doc.token_endpoint).toBe('http://localhost:8095/token');
    expect(doc.end_session_endpoint).toBe('http://localhost:8095/logout');
    expect(doc.jwks_uri).toBe('http://localhost:8095/.well-known/jwks.json');
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('reflects ES256 when configured', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'ES256',
      authMethods: ['none'],
    });
    expect(doc.id_token_signing_alg_values_supported).toEqual(['ES256']);
  });

  it('reflects client-secret auth methods', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none', 'client_secret_post', 'client_secret_basic'],
    });
    expect(doc.token_endpoint_auth_methods_supported).toContain('client_secret_basic');
  });

  it('strips trailing slashes from issuer', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095/',
      signingAlg: 'RS256',
      authMethods: ['none'],
    });
    expect(doc.issuer).toBe('http://localhost:8095');
  });
});
```

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/config/schema.ts src/oidc/token.ts src/oidc/discovery.ts src/server.ts tests/oidc/token.test.ts tests/oidc/discovery.test.ts
git commit -m "feat(token): optional clientSecret with post and basic auth"
```

---

### Task 10: ES256 algorithm support

**Files:**

- Modify: `src/config/schema.ts`
- Modify: `src/oidc/keys.ts`
- Modify: `src/oidc/token.ts`
- Modify: `tests/oidc/keys.test.ts`

- [ ] **Step 1: Update tests with ES256 cases**

Append to `tests/oidc/keys.test.ts` after the existing `describe('createKeyMaterial (file-backed)', ...)`:

```ts
describe('createKeyMaterial (ES256)', () => {
  it('generates an ES256 keypair when alg is ES256', async () => {
    const km = await createKeyMaterial({ kid: 'es-1', alg: 'ES256', source: 'generate' });
    expect(km.alg).toBe('ES256');
    expect(km.publicJwk.alg).toBe('ES256');
    expect(km.publicJwk.kty).toBe('EC');
    expect(km.publicJwk.crv).toBe('P-256');
  });

  it('persists and reloads an ES256 key from file', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-es-'));
    const file = path.join(tmpDir, 'es-key.json');

    const first = await createKeyMaterial({
      kid: 'es-persist',
      alg: 'ES256',
      source: `file:${file}`,
    });
    const second = await createKeyMaterial({
      kid: 'es-persist',
      alg: 'ES256',
      source: `file:${file}`,
    });

    expect(second.alg).toBe('ES256');
    expect(second.publicJwk.x).toBe(first.publicJwk.x);
    expect(second.publicJwk.y).toBe(first.publicJwk.y);
  });

  it('throws when configured alg differs from persisted alg', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-mismatch-'));
    const file = path.join(tmpDir, 'rs-key.json');

    await createKeyMaterial({ kid: 'k', alg: 'RS256', source: `file:${file}` });

    await expect(
      createKeyMaterial({ kid: 'k', alg: 'ES256', source: `file:${file}` }),
    ).rejects.toThrow(/has alg "RS256", but config expects "ES256"/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/oidc/keys.test.ts`
Expected: FAIL — `alg: 'ES256'` is not allowed by the schema, and `keys.ts` is hardcoded to RS256.

- [ ] **Step 3: Update `src/config/schema.ts`**

Change `SigningKeySchema.alg` from:

```ts
alg: z.enum(['RS256']).default('RS256'),
```

to:

```ts
alg: z.enum(['RS256', 'ES256']).default('RS256'),
```

- [ ] **Step 4: Update `src/oidc/keys.ts`**

Replace the file contents with:

```ts
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

export async function createKeyMaterial(config: SigningKey): Promise<KeyMaterial> {
  const alg: SigningAlg = config.alg;
  if (config.source === 'generate') {
    return generateEphemeralKey(config.kid, alg);
  }

  const filePath = config.source.slice('file:'.length);
  const existing = await loadKeyFromFile(filePath, config.kid, alg);
  if (existing) return existing;
  const generated = await generateEphemeralKey(config.kid, alg);
  await saveKeyToFile(filePath, generated);
  return generated;
}

async function generateEphemeralKey(kid: string, alg: SigningAlg): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await jose.generateKeyPair(alg, { extractable: true });
  const jwk: jose.JWK = {
    ...(await jose.exportJWK(publicKey)),
    kid,
    use: 'sig',
    alg,
  };
  return { kid, alg, privateKey, publicJwk: jwk };
}

interface PersistedKey {
  kid: string;
  privateJwk: jose.JWK;
  publicJwk: jose.JWK;
}

async function loadKeyFromFile(
  filePath: string,
  kid: string,
  configAlg: SigningAlg,
): Promise<KeyMaterial | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') return null;
    throw error;
  }

  const parsed = JSON.parse(raw) as PersistedKey;
  if (parsed.kid !== kid) {
    throw new Error(
      `dev-oidc: signing key at ${filePath} has kid "${parsed.kid}", but config expects "${kid}". ` +
        `Either align the config kid, delete the file to regenerate, or use a different path.`,
    );
  }

  const persistedAlg = (parsed.publicJwk.alg as SigningAlg | undefined) ?? 'RS256';
  if (persistedAlg !== configAlg) {
    throw new Error(
      `dev-oidc: signing key at ${filePath} has alg "${persistedAlg}", but config expects "${configAlg}". ` +
        `Either align the config alg, delete the file to regenerate, or use a different path.`,
    );
  }

  const privateKey = (await jose.importJWK(parsed.privateJwk, configAlg)) as jose.KeyLike;
  return { kid, alg: configAlg, privateKey, publicJwk: parsed.publicJwk };
}

async function saveKeyToFile(filePath: string, material: KeyMaterial): Promise<void> {
  const privateJwk = await jose.exportJWK(material.privateKey);
  const payload: PersistedKey = {
    kid: material.kid,
    privateJwk,
    publicJwk: material.publicJwk,
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}
```

- [ ] **Step 5: Update `src/oidc/token.ts` to source `alg` from `keyMaterial`**

In `issueTokenSet`, replace both occurrences of `alg: 'RS256'` (in the two `setProtectedHeader({...})` calls) with `alg: deps.keyMaterial.alg`.

After the change, both call sites read:

```ts
.setProtectedHeader({ alg: deps.keyMaterial.alg, kid: deps.keyMaterial.kid, typ: 'JWT' })
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/config/schema.ts src/oidc/keys.ts src/oidc/token.ts tests/oidc/keys.test.ts
git commit -m "feat(keys): support ES256 signing alongside RS256"
```

---

### Task 11: JWKS pre-calculation at boot

**Files:**

- Modify: `src/server.ts`

- [ ] **Step 1: Move `buildJwks` to a one-time call in `src/server.ts`**

After the `createKeyMaterial` line (around line 40), add:

```ts
const jwksDocument = buildJwks(keyMaterial);
```

Replace the JWKS handler (line 68-70):

```ts
app.get('/.well-known/jwks.json', async () => {
  return buildJwks(keyMaterial);
});
```

with:

```ts
app.get('/.well-known/jwks.json', async () => jwksDocument);
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS — existing JWKS-using tests verify the JWKS document content.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "perf(jwks): cache JWKS document built once at server boot"
```

---

## GROUP 3 — Cleanup

### Task 12: Migrate `src/login/page.tsx` to tagged-template renderer

**Files:**

- Delete: `src/login/page.tsx`
- Create: `src/login/page.ts`

- [ ] **Step 1: Delete the old TSX file and create the new TS implementation**

Delete `src/login/page.tsx`.

Create `src/login/page.ts`:

```ts
import type { Branding, Profile } from '@/config/schema.js';
import { Html, html, renderToString } from '@/shared/html.js';
import { STATIC_STYLES } from '@/login/styles.js';

export interface RenderLoginPageInput {
  pendingAuthId: string;
  profiles: readonly Profile[];
  branding: Branding;
  actionUrl: string;
}

export function renderLoginPage(input: RenderLoginPageInput): string {
  const { pendingAuthId, profiles, branding, actionUrl } = input;

  const tiles = profiles.map(
    (p) =>
      html`<form class="tile" method="post" action="${actionUrl}">
        <input type="hidden" name="pendingAuthId" value="${pendingAuthId}" />
        <input type="hidden" name="profileId" value="${p.id}" />
        <button type="submit" class="tile">
          <div class="name">${p.displayName}</div>
          <div class="email">${p.email}</div>
        </button>
      </form>`,
  );

  const doc = html`<!doctype html>
    <html lang="en" style="--accent: ${branding.accentColor}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${branding.title}</title>
        <style>
          ${new Html(STATIC_STYLES)}
        </style>
      </head>
      <body>
        <h1>${branding.title}</h1>
        <div class="grid">${tiles}</div>
        <a class="admin-link" href="/admin">Manage profiles →</a>
      </body>
    </html>`;

  return renderToString(doc);
}
```

- [ ] **Step 2: Run the existing login page tests**

Run: `npx vitest run tests/login/page.test.ts`
Expected: PASS — the existing assertions check rendered HTML strings (title, tile content, hidden inputs, action URL, escaping, admin link).

- [ ] **Step 3: Run all tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/login/page.ts src/login/page.tsx
git commit -m "refactor(login): render page with tagged-template renderer"
```

---

### Task 13: Migrate `src/admin/page.tsx` to tagged-template renderer

**Files:**

- Delete: `src/admin/page.tsx`
- Create: `src/admin/page.ts`

- [ ] **Step 1: Delete the old TSX file and create the new TS implementation**

Delete `src/admin/page.tsx`.

Create `src/admin/page.ts`:

```ts
import type { Config, Profile } from '@/config/schema.js';
import { Html, html, renderToString } from '@/shared/html.js';

const STYLES = `
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c; max-width: 1100px; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1.125rem; margin: 2rem 0 1rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; overflow: hidden; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin: 2rem 0 1rem; }
  .section-head h2 { margin: 0; }
  .primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .primary:hover { background: #155ac7; border-color: #155ac7; }
  th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid #eaecf0; vertical-align: middle; }
  th { background: #f9fafb; font-weight: 600; font-size: 0.875rem; color: #667085; }
  tr:last-child td { border-bottom: none; }
  button { font: inherit; cursor: pointer; padding: 0.375rem 0.75rem; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; }
  button.danger { color: #b42318; border-color: #fda29b; }
  button:hover { border-color: #1f6feb; }
  .actions { display: flex; gap: 0.5rem; align-items: center; }
  .actions form { margin: 0; }
  .json { background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; padding: 1rem; white-space: pre; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; }
  form.edit { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; align-items: center; max-width: 600px; background: #fff; padding: 1rem; border: 1px solid #d0d5dd; border-radius: 8px; }
  form.edit input, form.edit textarea { font: inherit; padding: 0.375rem 0.5rem; border: 1px solid #d0d5dd; border-radius: 4px; }
  form.edit textarea { min-height: 4rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; }
  form.edit .wide { grid-column: 1 / -1; display: flex; gap: 0.5rem; justify-content: flex-end; }
  .banner { background: #fef7c3; border: 1px solid #fec84b; padding: 0.5rem 1rem; border-radius: 6px; margin-bottom: 1rem; display: none; }
  .banner.visible { display: block; }
  dialog.edit-dialog { border: 1px solid #d0d5dd; border-radius: 10px; padding: 0; background: #fff; max-width: 640px; width: calc(100vw - 2rem); box-shadow: 0 10px 40px rgba(16, 24, 40, 0.18); }
  dialog.edit-dialog::backdrop { background: rgba(16, 24, 40, 0.45); }
  dialog.edit-dialog .dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 0.875rem 1.125rem; border-bottom: 1px solid #eaecf0; }
  dialog.edit-dialog .dialog-head h3 { margin: 0; font-size: 1rem; font-weight: 600; }
  dialog.edit-dialog form.edit { border: none; border-radius: 0; max-width: none; padding: 1rem 1.125rem; }
`.trim();

const CLIENT_SCRIPT = `
  (function() {
    const banner = document.getElementById('reload-banner');
    const es = new EventSource('/admin/events');
    es.addEventListener('config-changed', () => {
      if (banner) banner.classList.add('visible');
    });

    document.getElementById('reload-link').addEventListener('click', (e) => {
      e.preventDefault();
      window.location.reload();
    });

    document.body.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;

      const edit = target.closest('[data-edit-dialog]');
      if (edit instanceof HTMLElement) {
        const id = edit.dataset.editDialog;
        const dialog = id ? document.getElementById('edit-dialog-' + id) : null;
        if (dialog instanceof HTMLDialogElement) dialog.showModal();
        return;
      }

      const opener = target.closest('[data-open-dialog]');
      if (opener instanceof HTMLElement) {
        const id = opener.dataset.openDialog;
        const dialog = id ? document.getElementById(id) : null;
        if (dialog instanceof HTMLDialogElement) dialog.showModal();
        return;
      }

      const closer = target.closest('[data-dialog-close]');
      if (closer instanceof HTMLElement) {
        const dialog = closer.closest('dialog');
        if (dialog instanceof HTMLDialogElement) dialog.close();
      }
    });

    document.body.addEventListener('submit', async (ev) => {
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (!form.dataset.api) return;
      ev.preventDefault();
      const method = form.dataset.method || 'POST';
      const url = form.dataset.api;
      let body = undefined;
      if (method === 'POST' || method === 'PUT') {
        const data = {};
        for (const el of form.elements) {
          if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) continue;
          if (!el.name) continue;
          if (el.name === 'claims') {
            try { data[el.name] = el.value ? JSON.parse(el.value) : {}; }
            catch (e) { alert('Invalid JSON in claims'); return; }
          } else {
            data[el.name] = el.value;
          }
        }
        body = JSON.stringify(data);
      }
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body,
      });
      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        alert(err.error_description || err.details || err.error || 'Request failed');
      }
    });
  })();
`.trim();

function profileForm(profile: Profile | null): Html {
  const isEdit = profile !== null;
  const idSuffix = profile?.id ?? 'new';
  const apiUrl = isEdit ? `/admin/api/profiles/${profile!.id}` : '/admin/api/profiles';
  const method = isEdit ? 'PUT' : 'POST';
  const claimsJson = JSON.stringify(profile?.claims ?? {}, null, 2);
  const idValue = profile?.id ?? '';
  const displayValue = profile?.displayName ?? '';
  const emailValue = profile?.email ?? '';
  const idReadonly = isEdit ? html`readonly` : '';

  return html`<form class="edit" data-api="${apiUrl}" data-method="${method}" method="post">
    <label for="id-${idSuffix}">ID</label>
    <input name="id" id="id-${idSuffix}" value="${idValue}" required ${idReadonly} />
    <label for="displayName-${idSuffix}">Display name</label>
    <input name="displayName" id="displayName-${idSuffix}" value="${displayValue}" required />
    <label for="email-${idSuffix}">Email</label>
    <input name="email" id="email-${idSuffix}" type="email" value="${emailValue}" required />
    <label for="claims-${idSuffix}">Claims (JSON)</label>
    <textarea name="claims" id="claims-${idSuffix}">${claimsJson}</textarea>
    <div class="wide">
      <button type="button" data-dialog-close>Cancel</button>
      <button type="submit">${isEdit ? 'Save' : 'Add'}</button>
    </div>
  </form>`;
}

function profileRow(profile: Profile): Html {
  const claimsCount = Object.keys(profile.claims).length;
  return html`<tr>
    <td>${profile.id}</td>
    <td>${profile.displayName}</td>
    <td>${profile.email}</td>
    <td>${claimsCount} claim(s)</td>
    <td>
      <div class="actions">
        <button type="button" data-edit-dialog="${profile.id}">Edit</button>
        <form data-api="/admin/api/profiles/${profile.id}" data-method="DELETE" method="post">
          <button type="submit" class="danger">Delete</button>
        </form>
      </div>
      <dialog id="edit-dialog-${profile.id}" class="edit-dialog">
        <div class="dialog-head">
          <h3>Edit profile — ${profile.displayName}</h3>
          <button type="button" data-dialog-close aria-label="Close">✕</button>
        </div>
        ${profileForm(profile)}
      </dialog>
    </td>
  </tr>`;
}

export function renderAdminPage(config: Config): string {
  // The raw-config dump sits inside a <div> element body. Quotes are not
  // dangerous in element-text context, only in attribute values. Standard
  // escape would convert " to &quot;, which is correct but visually noisy
  // for a JSON dump. Escape only the chars that break out of element-text.
  const configJson = JSON.stringify(config, null, 2);
  const safeJson = configJson.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>dev-oidc Admin</title>
        <style>
          ${new Html(STYLES)}
        </style>
      </head>
      <body>
        <h1>dev-oidc Admin</h1>
        <div id="reload-banner" class="banner">
          Config changed on disk. <a id="reload-link" href="#">Reload</a>
        </div>

        <div class="section-head">
          <h2>Profiles (${config.profiles.length})</h2>
          <button type="button" class="primary" data-open-dialog="add-dialog">Add profile</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Claims</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${config.profiles.map(profileRow)}
          </tbody>
        </table>

        <dialog id="add-dialog" class="edit-dialog">
          <div class="dialog-head">
            <h3>Add profile</h3>
            <button type="button" data-dialog-close aria-label="Close">✕</button>
          </div>
          ${profileForm(null)}
        </dialog>

        <h2>Raw config</h2>
        <div class="json">${new Html(safeJson)}</div>

        <script>
          ${new Html(CLIENT_SCRIPT)};
        </script>
      </body>
    </html>`;

  return renderToString(doc);
}
```

- [ ] **Step 2: Run admin tests**

Run: `npx vitest run tests/admin/page.test.ts`
Expected: PASS — assertions check the same DOM fragments (`class="actions"`, `data-edit-dialog="alice"`, dialogs per profile, Cancel buttons, etc.).

- [ ] **Step 3: Run all tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/admin/page.ts src/admin/page.tsx
git commit -m "refactor(admin): render page with tagged-template renderer"
```

---

### Task 14: Remove React dependencies and JSX config

**Files:**

- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Remove React-related deps from `package.json`**

In `package.json`, delete these entries:

From `dependencies`:

```json
"react": "^19.0.0",
"react-dom": "^19.0.0",
```

From `devDependencies`:

```json
"@types/react": "^19.0.0",
"@types/react-dom": "^19.0.0",
```

- [ ] **Step 2: Reinstall lockfile**

Run: `npm install`
Expected: `package-lock.json` updated; React packages removed.

- [ ] **Step 3: Remove JSX setting from `tsconfig.json`**

Delete the `"jsx": "react-jsx",` line.

- [ ] **Step 4: Run all tests + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS — no `.tsx` files remain in `src/`, build produces `dist/index.js` and `dist/cli.js`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore(deps): remove react and react-dom (unused after renderer migration)"
```

---

### Task 15: Eliminate the `as unknown as FastifyInstance` cast

**Files:**

- Modify: `src/logger.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Update `src/logger.ts`**

Replace the file contents with:

```ts
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

export type DevOidcLogger = FastifyBaseLogger;

export function createLogger(options?: { level?: string }): DevOidcLogger {
  return pino({
    level: options?.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { component: 'dev-oidc' },
  });
}
```

- [ ] **Step 2: Remove the cast in `src/server.ts`**

Replace lines 47-50 in `src/server.ts`:

Old:

```ts
const rawApp = Fastify({ loggerInstance: logger });
// Cast to the default FastifyInstance type so that register helpers typed
// against FastifyBaseLogger (the Fastify default) accept this instance.
const app = rawApp as unknown as FastifyInstance;
```

New:

```ts
const app = Fastify({ loggerInstance: logger });
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

If TypeScript still complains about an `unknown` type at the `Fastify(...)` call (because `loggerInstance` widens to `FastifyBaseLogger | undefined` but the inferred FastifyInstance still picks up pino specifics), fall back to:

```ts
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';

const app: FastifyInstance = Fastify({ loggerInstance: logger as FastifyBaseLogger });
```

This is still narrower than `as unknown` and limits the assertion to the boundary value, not the whole instance.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts src/server.ts
git commit -m "refactor(server): align logger type with FastifyBaseLogger to drop unknown cast"
```

---

### Task 16: Documentation updates

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `examples/config.json`

- [ ] **Step 1: Update `README.md`**

Locate the section that lists features or behaviors and add notes for:

- **Refresh token rotation:** "dev-oidc rotates refresh tokens on every use; the old token becomes invalid as soon as `/token` returns the new one."
- **Optional `clientSecret`:** Show a config snippet:

  ```json
  {
    "clients": [
      {
        "clientId": "confidential-app",
        "clientSecret": "s3cr3t-value",
        "redirectUris": ["http://localhost:5173/auth/callback"],
        "audience": "my-api"
      }
    ]
  }
  ```

  Mention both auth methods: `client_secret_post` (form field `client_secret`) and `client_secret_basic` (HTTP Basic).

- **ES256:** Show how to switch:

  ```json
  {
    "signingKey": { "kid": "k1", "alg": "ES256", "source": "generate" }
  }
  ```

- **In-memory volatility:** Add a "Limitations" section listing: "Authorization codes (60s) and refresh tokens (8h by default) are held in memory. A server restart invalidates active codes and refresh tokens. Persistent storage is intentionally out of scope; signing keys can be persisted via `signingKey.source: file:<path>`."

- **Logout behavior:** Note that requests without `post_logout_redirect_uri` now return an HTML "Signed out" confirmation page instead of redirecting to `/`.

- **Root landing page:** Mention `GET /` lists endpoints and links to the admin UI when enabled.

- [ ] **Step 2: Update `CHANGELOG.md`**

Add a `## [0.1.0]` section above the existing `## [0.1.0-alpha.2]` entry:

```markdown
## [0.1.0] — 2026-04-25

### Breaking

- `scope` is now propagated end-to-end. The `/token` response `scope` field reflects the granted scope rather than the previously-hardcoded `"openid profile email"`. Apps that asserted on the old hardcoded value need updates.
- `/authorize` rejects requests whose `scope` does not include `openid` with `400 invalid_scope`.
- Refresh tokens are single-use; reuse returns `400 invalid_grant`. Apps must capture each new `refresh_token` from `/token` responses.
- `/logout` without a `post_logout_redirect_uri` returns a 200 HTML confirmation page instead of redirecting to `/`.

### Added

- `GET /` landing page with discovery, JWKS, and admin links.
- Optional `clientSecret` on clients; supports both `client_secret_post` and `client_secret_basic`.
- `ES256` signing algorithm; configurable via `signingKey.alg`.
- Access tokens carry a `scope` claim.

### Changed

- JWKS document is built once at startup rather than rebuilt per request.
- Identical config updates from the file watcher and admin writes are deduplicated.
- The login and admin pages render via a tagged-template renderer; React is no longer a dependency.
```

- [ ] **Step 3: Update `examples/config.json`**

Add a comment-style example showing optional `clientSecret` and ES256. JSON does not allow comments, so add a second example client and a top-level note in the README rather than the JSON itself. In `examples/config.json`, add:

- A second entry in `clients` showing `clientSecret`:

  ```json
  {
    "clientId": "confidential-app",
    "clientSecret": "example-secret-replace-me",
    "redirectUris": ["http://localhost:5174/auth/callback"],
    "postLogoutRedirectUris": ["http://localhost:5174/"],
    "audience": "confidential-api"
  }
  ```

- (Optional) Switch the existing `signingKey.alg` to demonstrate `ES256` if you want the example to default to that — otherwise leave as `RS256` and document switching in the README.

- [ ] **Step 4: Verify formatting and commit**

Run: `npm run format && npm test && npm run typecheck`
Expected: all pass; no test changes required.

```bash
git add README.md CHANGELOG.md examples/config.json
git commit -m "docs: stabilization release notes and config examples"
```

---

## Self-Review Checklist

Run through this before declaring the plan complete.

**Spec coverage**

- [x] §4.1 Scope propagation — Tasks 2, 3, 4
- [x] §4.2 Logout fallback + landing page — Tasks 6, 7
- [x] §4.3 Watcher / admin write dedup — Task 5
- [x] §5.1 Refresh token rotation — Task 8
- [x] §5.2 Optional client authentication — Task 9
- [x] §5.3 ES256 algorithm support — Task 10
- [x] §5.4 JWKS pre-calculation — Task 11
- [x] §6.1 React → tagged-template renderer — Tasks 1, 12, 13, 14
- [x] §6.2 Eliminate `as unknown` cast — Task 15
- [x] §6.3 Documentation — Task 16

**Testing strategy coverage** — every test in spec §7 maps to a step in this plan.

**Type consistency** — `CodeRecord.scope`, `RefreshRecord.scope`, `SigningAlg`, `KeyMaterial.alg`, `DiscoveryInput.signingAlg`, `Html`, `escape`, `html`, `renderToString` are referenced consistently across tasks.

**No placeholders** — every code block contains executable code; no "TBD" or "implement later"; commit messages are concrete.
