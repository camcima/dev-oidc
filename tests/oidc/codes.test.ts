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
