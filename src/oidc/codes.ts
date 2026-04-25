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
      refresh.delete(token);
      if (isExpired(entry)) return null;
      return entry.value;
    },
  };
}
