import { describe, expect, it, vi } from 'vitest';
import { createCodeStore } from '@/oidc/codes.js';
import { createPendingAuthStore } from '@/oidc/pending.js';

describe('CodeStore (authorization codes)', () => {
  it('issues a code consumable exactly once', () => {
    const store = createCodeStore({ ttlMs: 60_000 });
    const code = store.issue({
      clientId: 'c1',
      profileId: 'alice',
      codeChallenge: 'xyz',
      nonce: 'n1',
      redirectUri: 'http://localhost/cb',
    });

    const first = store.consume(code);
    expect(first?.profileId).toBe('alice');

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
    });

    vi.advanceTimersByTime(1_500);
    expect(store.consume(code)).toBeNull();
    vi.useRealTimers();
  });
});

describe('CodeStore (refresh tokens)', () => {
  it('issues and validates a refresh token', () => {
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
    const token = store.issueRefresh({ clientId: 'c1', profileId: 'alice' });

    expect(store.consumeRefresh(token)?.profileId).toBe('alice');
  });

  it('refresh token stays valid within its TTL (not single-use)', () => {
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
    const token = store.issueRefresh({ clientId: 'c1', profileId: 'alice' });

    expect(store.consumeRefresh(token)?.profileId).toBe('alice');
    expect(store.consumeRefresh(token)?.profileId).toBe('alice');
  });

  it('refresh token expires after TTL', () => {
    vi.useFakeTimers();
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 1_000 });
    const token = store.issueRefresh({ clientId: 'c1', profileId: 'alice' });
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
