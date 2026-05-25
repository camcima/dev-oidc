import { randomBytes } from 'node:crypto';
import { DEFAULT_MAX_ENTRIES, type Entry, evictForInsert } from '@/oidc/expiring-map.js';

export interface CodeRecord {
  clientId: string;
  profileId: string;
  codeChallenge: string;
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
  refreshTtlMs?: number;
  // Hard cap on live entries per map (codes, refresh) to bound memory in a
  // long-running hub. Defaults to 10k, far above any realistic local-dev load.
  maxEntries?: number;
}

export interface CodeStore {
  issue: (record: CodeRecord) => string;
  consume: (code: string) => CodeRecord | null;
  issueRefresh: (record: RefreshRecord) => string;
  consumeRefresh: (token: string) => RefreshRecord | null;
  /** Total live entries (codes + refresh tokens). For observability/tests. */
  size: () => number;
}

export function createCodeStore(options: CodeStoreOptions): CodeStore {
  const codes = new Map<string, Entry<CodeRecord>>();
  const refresh = new Map<string, Entry<RefreshRecord>>();
  const refreshTtlMs = options.refreshTtlMs ?? 8 * 60 * 60 * 1_000;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const mint = (bytes: number): string => randomBytes(bytes).toString('base64url');
  const isExpired = (e: Entry<unknown>): boolean => Date.now() > e.expiresAt;

  return {
    issue(record) {
      evictForInsert(codes, maxEntries);
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
      evictForInsert(refresh, maxEntries);
      const token = mint(48);
      refresh.set(token, { value: record, expiresAt: Date.now() + refreshTtlMs });
      return token;
    },
    consumeRefresh(token) {
      const entry = refresh.get(token);
      if (!entry) return null;
      refresh.delete(token);
      if (isExpired(entry)) return null;
      return entry.value;
    },
    size() {
      return codes.size + refresh.size;
    },
  };
}
