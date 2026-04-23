import { randomBytes } from 'node:crypto';

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  nonce: string;
  state: string;
  scope: string;
}

export interface PendingAuthStoreOptions {
  ttlMs: number;
}

export interface PendingAuthStore {
  create: (record: PendingAuth) => string;
  consume: (id: string) => PendingAuth | null;
}

interface Entry {
  value: PendingAuth;
  expiresAt: number;
}

export function createPendingAuthStore(options: PendingAuthStoreOptions): PendingAuthStore {
  const store = new Map<string, Entry>();

  return {
    create(record) {
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
  };
}
