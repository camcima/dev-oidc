# Architecture review — dev-oidc 0.6.0

**Date:** 2026-09-26  
**Revision:** `788ac053fc2ca44ea343877ba2f179306bb602d5`  
**Scope:** Public library API, single-project and hub servers, OIDC handlers, configuration persistence and reload, admin protection, signing keys, TLS, packaging, documentation, and tests.

## Assessment

The architecture fits a local authentication test double: a small Fastify application, shared protocol handlers, isolated tenant state, schema-validated configuration, and bounded in-memory token stores. The earlier review prompted useful changes, particularly shared server setup, authorization error redirects, profile merge behavior, and client-credentials support.

The next investment should be boundary correctness. There are two urgent issues: an admin guard bypass and configuration writes that can lose recent disk edits. There are also reproducible gaps in tenant reconciliation, token identity handling, request validation, and protocol compatibility. Passing tests currently leave these cases uncovered.

The assessment treats profile selection, ephemeral sessions, optional client secrets, and explicitly documented scope passthrough as intentional development features. Production identity management, distributed storage, and horizontal scaling would add little value to this tool's stated purpose.

## Verification

| Check               | Result                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Existing test suite | **501 tests passed across 63 files**                                                       |
| TypeScript          | `npm run typecheck` passed                                                                 |
| ESLint              | `npm run lint` passed                                                                      |
| Package build       | `npm run build` passed, including declarations and ESM/CommonJS output                     |
| Runtime             | Node.js 22.22.2; npm 10.9.7                                                                |
| Additional probes   | Temporary configurations, Fastify injection, direct registry calls, and real loopback HTTP |

The numbered findings below were reproduced against the current source. Temporary probes did not modify project configurations or implementation files. This review did not run Docker, a browser attack harness, an external OIDC client compatibility matrix, dependency vulnerability scanning, or formal OIDC conformance certification. The HTTP guard bypass is verified; browser exploitability also depends on browser network restrictions and deployment conditions.

## Priorities

P1 means fix promptly because the issue defeats an existing safeguard or loses configuration. P2 means a reproducible correctness or interoperability defect. P3 means a lower-impact documentation or maintenance issue.

| ID  | Priority | Finding                                                               |
| --- | -------- | --------------------------------------------------------------------- |
| F1  | P1       | Encoded admin paths bypass every admin guard check                    |
| F2  | P1       | Admin writes overwrite file edits that have not reached runtime state |
| F3  | P2       | Overlapping reconciliations can leave removed tenants active          |
| F4  | P2       | Machine tokens can resolve to human profiles at UserInfo              |
| F5  | P2       | Malformed protocol input produces internal server errors              |
| F6  | P2       | Body client secrets are decoded twice and accept incorrect values     |
| F7  | P2       | Token responses omit cache prevention headers                         |
| F8  | P2       | IPv6 URL construction remains inconsistent across entry points        |
| F9  | P2       | Form POST authorization requests return 404                           |
| F10 | P2       | Nested configuration typos silently disable intended client policies  |

## Findings

### F1 — Encoded admin paths bypass the guard

**Location:** [src/admin/guard.ts](../src/admin/guard.ts), lines 81–87.

The guard decides whether a request is administrative by comparing the raw `req.url` against `/admin`. Fastify resolves percent-encoded static path characters when matching routes. Consequently, `/%61dmin/api/profiles` reaches the profile route but skips Host, Origin, and Fetch Metadata checks.

**Verified over real loopback HTTP:** the following form request returned `403` at `/admin/api/profiles` and **`201` at `/%61dmin/api/profiles`**. The new profile appeared in the temporary configuration file.

```http
POST /%61dmin/api/profiles HTTP/1.1
Host: evil.test
Origin: https://evil.test
Sec-Fetch-Site: cross-site
Content-Type: application/x-www-form-urlencoded

id=injected&displayName=Injected&email=injected%40example.test
```

**Impact:** requests can bypass the application's DNS rebinding and CSRF defenses and change local configuration. CORS response restrictions do not prevent the form handler from writing the file. Both server modes install the same guard.

**Recommendation:** attach the guard directly to the administrative routes or an encapsulated admin plugin. This lets route matching determine which handlers require protection. Avoid maintaining a second interpretation of URL routing inside the guard.

**Regression coverage:** encoded characters at multiple positions in `admin`, ordinary paths, read and mutation routes, hostile Host/Origin/Fetch Metadata headers, and both run modes. Retain an actual HTTP test alongside injection tests.

### F2 — Admin mutations can discard recent file edits

**Locations:** [src/admin/profiles-routes.ts](../src/admin/profiles-routes.ts), lines 116–126, 139–162, and 172–183; [src/config/watcher.ts](../src/config/watcher.ts), reload debounce; [src/config/writer.ts](../src/config/writer.ts).

Every profile mutation reads `tenant.runtime.get()` and writes that entire configuration to disk. The per-path mutex serializes admin operations, but runtime state can lag behind an editor's write while the watcher waits for stability and its 200 ms debounce.

**Reproduction:** start with `tokenTtlSeconds: 900`; write `123` to the config file; immediately create a profile through the admin API. The API returned `201`, but the persisted TTL reverted to **900**. The same mechanism can discard client, secret, signing-key, branding, and other profile edits.

Atomic rename prevents partially written JSON. It does not prevent replacing newer content with an older snapshot.

**Recommendation:** base mutations on a fresh, validated disk read inside the mutation queue. Add revision/conflict handling for external changes and coordinate watcher publications with writes. An invalid or conflicting disk version should produce an actionable error instead of being replaced with the last runtime snapshot. External editors do not participate in the in-process mutex, so document and test the remaining conflict policy.

**Regression coverage:** change an unrelated disk field immediately before each POST/PUT/DELETE and verify its preservation; also exercise invalid disk content and delayed watcher callbacks.

### F3 — Reconciliation does not serialize complete desired-state updates

**Locations:** [src/hub/registry.ts](../src/hub/registry.ts), lines 186–212; [src/hub/server.ts](../src/hub/server.ts), lines 136–138.

The registry serializes individual operations per slug, but concurrent `reconcile()` calls inspect different snapshots of the tenant map. The hub watcher starts reconciliation without awaiting an earlier run.

**Reproduction:** on an empty registry, with a valid enabled entry:

```ts
const adding = registry.reconcile([entry]);
await registry.reconcile([]);
await adding;
// Observed: registry.list() still contains entry.slug.
```

The second call sees no mounted tenant to remove while the first activation is still loading configuration or generating keys. The older call subsequently mounts the tenant, contradicting the newer desired state. A similar lifecycle hazard exists when `closeAll()` races with pending activation.

**Impact:** rapid register/remove or enable/disable changes can leave an issuer available after it has been removed from hub configuration, until a later reconciliation or restart.

**Recommendation:** serialize complete reconciliations or use a desired-state generation number that activation checks before publishing. Shutdown should stop accepting work and drain or cancel pending activation before closing watchers.

**Regression coverage:** deterministically pause activation, submit a newer empty configuration, resume activation, and assert an empty registry. Apply the same barrier test to shutdown.

### F4 — UserInfo confuses machine identities with human identities

**Locations:** [src/oidc/userinfo.ts](../src/oidc/userinfo.ts), lines 44–70; [src/oidc/token.ts](../src/oidc/token.ts), `handleClientCredentialsGrant`.

UserInfo accepts any correctly signed token from the issuer that has a string `scope`, then looks up a profile using `payload.sub`. A client-credentials token also has a string scope, and its subject is the client ID. Client IDs and profile IDs may legitimately collide.

**Reproduction:** configure client ID `alice` and profile ID `alice`; request a client-credentials token with `openid profile email`; present it to `/userinfo`. The response was **200 with Alice's name and email**, despite no user authorization flow. With an empty scope, the colliding human subject is still accepted.

**Impact:** integration tests can falsely validate a service identity as a user. UserInfo represents an authenticated end-user, as described in [OIDC Core §5.3](https://openid.net/specs/openid-connect-core-1_0.html#UserInfo).

**Recommendation:** encode and validate a server-managed distinction between user access tokens and machine access tokens. Reserve that claim so profile custom claims cannot override it. Requiring `openid` alone is insufficient because the current machine grant can issue that scope.

**Regression coverage:** equal client/profile IDs, machine tokens with empty and identity scopes, ordinary user tokens, and ID-token rejection.

### F5 — Type assertions leave protocol requests unvalidated

**Locations:** [src/oidc/token.ts](../src/oidc/token.ts), lines 56–108; [src/oidc/authorize.ts](../src/oidc/authorize.ts), lines 62, 108–109, and 126; [src/oidc/complete.ts](../src/oidc/complete.ts), lines 18–21.

Casting request input to a TypeScript interface does not validate its runtime shape. The following probes all returned **500**:

| Input                                                       | Observed failure                       |
| ----------------------------------------------------------- | -------------------------------------- |
| Empty `POST /token`                                         | Reads `client_id` from `undefined`     |
| Empty `POST /authorize/complete`                            | Reads `pendingAuthId` from `undefined` |
| Valid authorization request with `scope=openid&scope=email` | Calls `.split()` on an array           |
| Token JSON with numeric `client_secret`                     | Passes a number to `Buffer.from()`     |

**Impact:** client mistakes appear as provider failures, expose internal exception messages, and prevent applications from exercising the expected OAuth error path. OAuth defines malformed and repeated parameters as `invalid_request`; see [RFC 6749 §4.1.2.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2.1) and [§5.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.2).

**Recommendation:** validate object shape and scalar types before credential parsing, string operations, or store access. Reject duplicate scalar parameters. Preserve the current rule that authorization errors redirect only after the client and callback have been validated; a generic Fastify validation response alone would lose that behavior.

**Regression coverage:** absent/null bodies, arrays, duplicate query and form parameters, numeric secrets/verifiers, and invalid types for state/nonce/prompt.

### F6 — Body secret decoding accepts a different secret

**Location:** [src/oidc/token.ts](../src/oidc/token.ts), lines 50–53 and 82–84.

`candidates(formSecret)` applies form decoding to a value already decoded by the body parser. It accepts both the original and the additionally decoded value. JSON values pass through the same logic.

**Reproduction:** configure secret `a b`. Submit form body `client_secret=a%2Bb`, which represents the literal secret `a+b`. Authentication succeeds with **200**. Sending the JSON secret `"a+b"` also succeeds. Those values should not match the configured space-containing secret.

**Impact:** tests can pass with incorrectly encoded or incorrect client credentials. The comparison is timing-safe, but it compares against too many possible values.

**Recommendation:** compare parsed body secrets exactly. Keep Basic-header decoding separate and decode its credential components once, following [RFC 6749 §2.3.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1). If raw Basic compatibility remains intentional, make that policy explicit and keep it out of body authentication.

**Regression coverage:** distinguish spaces, literal `+`, literal `%20`, and percent signs across Basic, form, and JSON requests.

### F7 — Token responses lack cache prevention headers

**Locations:** [src/oidc/token.ts](../src/oidc/token.ts), successful responses in `handleClientCredentialsGrant` and `issueTokenSet`; [src/server/base.ts](../src/server/base.ts).

Successful token responses are sent without `Cache-Control` or `Pragma`. A client-credentials probe returned **200 with both headers absent**; code exchange and refresh use the same unprotected response pattern.

**Impact:** the provider omits the explicit instruction that browsers and intermediaries must not store token responses. This does not establish that any particular cache currently stores them. [RFC 6749 §5.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1) requires `Cache-Control: no-store` and `Pragma: no-cache` on sensitive token responses.

**Recommendation:** centralize these headers for the token endpoint, covering all grant types and error responses. Also review caching policy for login pages containing pending authorization identifiers and admin responses containing profile data.

**Regression coverage:** assert the headers for code exchange, refresh, machine grants, and token errors.

### F8 — IPv6 support differs between library, CLI, and redirect paths

**Locations:** [src/server.ts](../src/server.ts), lines 54–60; [src/hub/issuer.ts](../src/hub/issuer.ts), lines 58–81.

The CLI and hub default URL logic use the existing `formatHostPort()` helper. The public factory still concatenates the raw host, and `pickRedirectHost()` does the same for its allowlist and fallback.

**Reproduction:** `createDevOidcServer({ config, listenHost: '::1' })` advertises **`http://::1:8095`**. Separately, `pickRedirectHost()` given request host `[::1]:8095`, listen host `::1`, and no public URL returns **`::1:8095`**. Both authorities are missing IPv6 brackets.

**Impact:** programmatic IPv6 discovery contains invalid URLs; an HTTP request to a TLS listener can receive an invalid HTTPS redirect. Supplying an explicit valid public URL avoids these paths.

**Recommendation:** use `formatHostPort()` consistently for issuer derivation, redirect authority construction, and Host allowlists. Validate programmatic URL options at the factory boundary as well.

**Regression coverage:** bare `::1` through the public factory, hub and CLI startup, and real HTTP-to-HTTPS redirects without an explicit public URL.

### F9 — The authorization endpoint does not accept form POST

**Location:** [src/oidc/authorize.ts](../src/oidc/authorize.ts), line 60.

Only GET is registered. A valid form-encoded authorization request sent to `POST /authorize` returned **404**; `/authorize/complete` is a separate login-selection endpoint.

**Impact:** relying parties that submit authorization parameters by POST cannot use the advertised authorization endpoint. [OIDC Core §3.1.2.1](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest) requires support for GET and POST authorization requests.

**Recommendation:** share one validated authorization handler between GET query parameters and POST form parameters. Keep response-mode support separate: accepting a POST request does not require adding `response_mode=form_post`.

**Regression coverage:** identical successful and failing authorization requests through both methods, in both server modes.

### F10 — Nested schema typos silently remove client policy

**Location:** [src/config/schema.ts](../src/config/schema.ts), `ClientSchema` and the top-level unknown-key refinement.

Unknown keys are rejected at the project root, but nested client objects use ordinary `z.object()`, which strips unknown keys. The policy defaults then take effect without a warning.

**Reproduction:** a client with `allowedScope: ['email']` parses successfully and has `allowedScopes === undefined`. The operator intended a scope allowlist; the actual configuration uses unrestricted scope passthrough. Similar misspellings can drop `clientSecret` or `requirePkce` settings.

**Impact:** configuration mistakes weaken the simulated policy while contradicting the README's promise that schema typos fail fast.

**Recommendation:** reject unknown keys in schema-owned nested objects, including clients, signing keys, profiles, and branding. Preserve arbitrary keys only where intentional, such as the profile `claims` record. Apply the same decision explicitly to hub tenant and TLS objects.

**Regression coverage:** misspelled policy fields must produce errors identifying the nested path; arbitrary custom claim names must remain supported.

## Architectural recommendations

### Keep the existing module structure

The shared `getTenant` route dependency and `createBaseApp()` are useful boundaries. Tenant-specific signing material and token stores make isolation understandable. The current scale does not justify introducing a service container, database, generic plugin framework, or a new routing abstraction.

Three focused changes would address most of the findings:

1. **Validate at protocol boundaries.** Parse requests into validated values before entering grant logic. Represent user and machine token identity explicitly.
2. **Give one component ownership of config mutation.** Combine disk reads, revisions, validation, persistence, and runtime publication so route handlers cannot save stale snapshots independently.
3. **Give the registry ownership of lifecycle ordering.** Reconciliation, activation, and shutdown need a shared ordering contract. Per-slug locks alone cannot enforce whole-registry desired state.

### Extend tests at component boundaries

The existing suite covers many isolated behaviors, and the remote-JWKS contract test verifies real signing and verification. The newly reproduced failures occur where components meet: router decoding versus the guard, disk state versus runtime state, machine issuance versus UserInfo, and one reconciliation versus the next.

Prioritize regression tests for those boundaries. Add at least one independent OIDC relying-party contract covering discovery, authorization, token exchange, UserInfo, refresh, and logout. The existing contract test builds its own requests and uses the same JWT library as the provider, so it does not establish compatibility with a full client stack.

### Clarify resource ownership

The exported factory returns both the Fastify `app` and a separate `close()`. File watchers belong to the wrapper and are closed only through that wrapper. Prefer tying watcher cleanup to Fastify lifecycle hooks, or make the required disposal contract explicit. Startup failures should unwind resources already acquired. These are design follow-ups; this review did not reproduce every startup failure path.

## Documentation corrections — P3

- [SECURITY.md](../SECURITY.md) says signing keys never persist and there is no client authentication. The implementation supports file-backed keys and optional client secrets.
- [README.md](../README.md), “Partial config hot-reload” and “What a refresh re-reads,” says changing `refreshTokenTtlSeconds` requires restart. Both factories now supply a live TTL getter; newly issued refresh tokens use the updated value. Existing token expiry remains fixed at issuance.
- The README's scope section still describes `400 invalid_scope` for missing `openid`, while the validated authorization path now redirects with an error. Update endpoint descriptions to include the machine grant as well.
- The August review's statement that every finding was addressed should remain historical context. Its successful fixes do not cover the new cases above.

## Suggested delivery order

1. Fix F1 and F2 with regression tests: restore admin protection and prevent configuration loss.
2. Fix F3 and F4: enforce tenant lifecycle ordering and user/machine identity separation.
3. Fix F5, F6, and F10: make malformed input and configuration mistakes fail predictably.
4. Fix F7–F9, update documentation, and add the independent client contract.

This keeps the library small while improving its central promise: application authentication code should behave predictably against the development provider, including error and lifecycle paths.
