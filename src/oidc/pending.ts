import { randomBytes } from 'node:crypto';
import { DEFAULT_MAX_ENTRIES, type Entry, evictForInsert } from '@/oidc/expiring-map.js';

/** How long a rendered login page stays submittable. */
export const DEFAULT_PENDING_TTL_MS = 10 * 60_000;

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  /** Absent when the client is allowed to skip PKCE. Always S256 when set. */
  codeChallenge?: string;
  nonce: string;
  state: string;
  scope: string;
}

export interface PendingAuthStoreOptions {
  ttlMs: number;
  // Hard cap on live pending records to bound memory in a long-running hub.
  maxEntries?: number;
}

export interface PendingAuthStore {
  create: (record: PendingAuth) => string;
  consume: (id: string) => PendingAuth | null;
  /** Live pending-record count. For observability/tests. */
  size: () => number;
}

export function createPendingAuthStore(options: PendingAuthStoreOptions): PendingAuthStore {
  const store = new Map<string, Entry<PendingAuth>>();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  return {
    create(record) {
      evictForInsert(store, maxEntries);
      const id = randomBytes(24).toString('base64url');
      store.set(id, { value: record, expiresAt: Date.now() + options.ttlMs });
      return id;
    },
    consume(id) {
      const entry = store.get(id);
      if (!entry) return null;
      store.delete(id);
      if (Date.now() > entry.expiresAt) return null;
      return entry.value;
    },
    size() {
      return store.size;
    },
  };
}
