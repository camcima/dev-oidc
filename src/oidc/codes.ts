import { randomBytes } from 'node:crypto';
import { DEFAULT_MAX_ENTRIES, type Entry, evictForInsert } from '@/oidc/expiring-map.js';

/** Authorization codes are exchanged immediately; a minute is generous. */
export const DEFAULT_CODE_TTL_MS = 60_000;

export interface CodeRecord {
  clientId: string;
  profileId: string;
  /** Absent when the authorization request carried no PKCE challenge. */
  codeChallenge?: string;
  nonce: string;
  redirectUri: string;
  scope: string;
  authTime?: number;
}

export interface RefreshRecord {
  clientId: string;
  profileId: string;
  scope: string;
  authTime?: number;
}

export interface CodeStoreOptions {
  ttlMs: number;
  // Accepts a getter so a hot-reloaded `refreshTokenTtlSeconds` applies to
  // tokens minted after the edit. A fixed number captured at construction
  // silently ignored every later config change.
  refreshTtlMs?: number | (() => number);
  // Hard cap on live entries per map (codes, refresh) to bound memory in a
  // long-running hub. Defaults to 10k, far above any realistic local-dev load.
  maxEntries?: number;
}

export type ConsumeResult<T> =
  | { status: 'consumed'; record: T }
  | { status: 'missing' }
  | { status: 'rejected'; reason: string };

export interface CodeStore {
  issue: (record: CodeRecord) => string;
  consume: (code: string) => CodeRecord | null;
  consumeIf: (
    code: string,
    check: (record: CodeRecord) => string | null,
  ) => ConsumeResult<CodeRecord>;
  issueRefresh: (record: RefreshRecord) => string;
  consumeRefresh: (token: string) => RefreshRecord | null;
  consumeRefreshIf: (
    token: string,
    check: (record: RefreshRecord) => string | null,
  ) => ConsumeResult<RefreshRecord>;
  /** Total live entries (codes + refresh tokens). For observability/tests. */
  size: () => number;
}

export function createCodeStore(options: CodeStoreOptions): CodeStore {
  const codes = new Map<string, Entry<CodeRecord>>();
  const refresh = new Map<string, Entry<RefreshRecord>>();
  const configured = options.refreshTtlMs ?? 8 * 60 * 60 * 1_000;
  const refreshTtlMs = (): number => (typeof configured === 'function' ? configured() : configured);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const mint = (bytes: number): string => randomBytes(bytes).toString('base64url');
  const isExpired = (e: Entry<unknown>): boolean => Date.now() > e.expiresAt;

  function consumeFrom<T>(
    map: Map<string, Entry<T>>,
    key: string,
    check: (record: T) => string | null,
    burnOnReject: boolean,
  ): ConsumeResult<T> {
    const entry = map.get(key);
    if (!entry) return { status: 'missing' };
    if (isExpired(entry)) {
      map.delete(key);
      return { status: 'missing' };
    }
    const reason = check(entry.value);
    if (reason !== null) {
      if (burnOnReject) map.delete(key);
      return { status: 'rejected', reason };
    }
    map.delete(key);
    return { status: 'consumed', record: entry.value };
  }

  return {
    issue(record) {
      evictForInsert(codes, maxEntries);
      const code = mint(32);
      codes.set(code, { value: record, expiresAt: Date.now() + options.ttlMs });
      return code;
    },
    consume(code) {
      const result = consumeFrom(codes, code, () => null, true);
      return result.status === 'consumed' ? result.record : null;
    },
    consumeIf(code, check) {
      // A failed exchange revokes the code: RFC 6749 §4.1.2 has the AS do so,
      // and real IdPs do. Leaving it live let a client with a wrong verifier
      // or redirect_uri succeed on retry in dev while failing in production.
      return consumeFrom(codes, code, check, true);
    },
    issueRefresh(record) {
      evictForInsert(refresh, maxEntries);
      const token = mint(48);
      refresh.set(token, { value: record, expiresAt: Date.now() + refreshTtlMs() });
      return token;
    },
    consumeRefresh(token) {
      const result = consumeFrom(refresh, token, () => null, false);
      return result.status === 'consumed' ? result.record : null;
    },
    consumeRefreshIf(token, check) {
      // Unlike codes, a refresh token survives a failed check. Single-use
      // rotation already makes replay fail on its own, and no mainstream IdP
      // revokes a refresh token merely because client_id did not match.
      return consumeFrom(refresh, token, check, false);
    },
    size() {
      return codes.size + refresh.size;
    },
  };
}
