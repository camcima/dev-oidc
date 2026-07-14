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

describe('CodeStore authTime', () => {
  it('round-trips authTime on code records', () => {
    const store = createCodeStore({ ttlMs: 60_000 });
    const code = store.issue({
      clientId: 'app',
      profileId: 'alice',
      codeChallenge: 'c',
      nonce: 'n',
      redirectUri: 'http://localhost/cb',
      scope: 'openid',
      authTime: 1700000000,
    });
    expect(store.consume(code)?.authTime).toBe(1700000000);
  });

  it('round-trips authTime on refresh records', () => {
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
    const token = store.issueRefresh({
      clientId: 'app',
      profileId: 'alice',
      scope: 'openid',
      authTime: 1700000000,
    });
    expect(store.consumeRefresh(token)?.authTime).toBe(1700000000);
  });
});

describe('CodeStore expiry sweep and size cap', () => {
  function sampleCode(): Parameters<ReturnType<typeof createCodeStore>['issue']>[0] {
    return {
      clientId: 'c1',
      profileId: 'alice',
      codeChallenge: 'xyz',
      nonce: 'n1',
      redirectUri: 'http://localhost/cb',
      scope: 'openid',
    };
  }

  it('sweeps expired authorization codes on the next issue', () => {
    vi.useFakeTimers();
    const store = createCodeStore({ ttlMs: 1_000 });
    store.issue(sampleCode());
    expect(store.size()).toBe(1);
    vi.advanceTimersByTime(1_500);
    // The expired code was never consumed; issuing a new one should reclaim it.
    store.issue(sampleCode());
    expect(store.size()).toBe(1);
    vi.useRealTimers();
  });

  it('sweeps expired refresh tokens on the next issueRefresh', () => {
    vi.useFakeTimers();
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 1_000 });
    store.issueRefresh({ clientId: 'c1', profileId: 'alice', scope: 'openid' });
    vi.advanceTimersByTime(1_500);
    store.issueRefresh({ clientId: 'c1', profileId: 'alice', scope: 'openid' });
    expect(store.size()).toBe(1);
    vi.useRealTimers();
  });

  it('caps the number of live entries, evicting the oldest', () => {
    const store = createCodeStore({ ttlMs: 60_000, maxEntries: 2 });
    const a = store.issue(sampleCode());
    const b = store.issue(sampleCode());
    const c = store.issue(sampleCode());
    expect(store.size()).toBe(2);
    expect(store.consume(a)).toBeNull(); // evicted as the oldest
    expect(store.consume(b)?.profileId).toBe('alice');
    expect(store.consume(c)?.profileId).toBe('alice');
  });
});

describe('consumeIf', () => {
  it('leaves the record stored when the check rejects, then allows a valid consume', () => {
    const store = createCodeStore({ ttlMs: 60_000 });
    const code = store.issue({
      clientId: 'app',
      profileId: 'alice',
      codeChallenge: 'c',
      nonce: '',
      redirectUri: 'http://localhost:3000/cb',
      scope: 'openid',
    });

    const rejected = store.consumeIf(code, () => 'client_id mismatch');
    expect(rejected).toEqual({ status: 'rejected', reason: 'client_id mismatch' });

    const consumed = store.consumeIf(code, () => null);
    expect(consumed.status).toBe('consumed');

    expect(store.consumeIf(code, () => null)).toEqual({ status: 'missing' });
  });

  it('reports missing for unknown and expired codes', () => {
    const store = createCodeStore({ ttlMs: -1 });
    const code = store.issue({
      clientId: 'app',
      profileId: 'alice',
      codeChallenge: 'c',
      nonce: '',
      redirectUri: 'http://localhost:3000/cb',
      scope: 'openid',
    });
    expect(store.consumeIf('nope', () => null)).toEqual({ status: 'missing' });
    expect(store.consumeIf(code, () => null)).toEqual({ status: 'missing' });
  });

  it('consumeRefreshIf mirrors the same semantics', () => {
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
    const token = store.issueRefresh({ clientId: 'app', profileId: 'alice', scope: 'openid' });
    expect(store.consumeRefreshIf(token, () => 'client_id mismatch').status).toBe('rejected');
    expect(store.consumeRefreshIf(token, () => null).status).toBe('consumed');
    expect(store.consumeRefreshIf(token, () => null).status).toBe('missing');
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

  function samplePending(): Parameters<ReturnType<typeof createPendingAuthStore>['create']>[0] {
    return {
      clientId: 'c1',
      redirectUri: 'http://localhost/cb',
      codeChallenge: 'xyz',
      codeChallengeMethod: 'S256',
      nonce: 'n1',
      state: 's1',
      scope: 'openid',
    };
  }

  it('sweeps expired pending records on the next create', () => {
    vi.useFakeTimers();
    const store = createPendingAuthStore({ ttlMs: 1_000 });
    store.create(samplePending());
    expect(store.size()).toBe(1);
    vi.advanceTimersByTime(1_500);
    store.create(samplePending());
    expect(store.size()).toBe(1);
    vi.useRealTimers();
  });

  it('caps the number of live pending records, evicting the oldest', () => {
    const store = createPendingAuthStore({ ttlMs: 60_000, maxEntries: 2 });
    const a = store.create(samplePending());
    store.create(samplePending());
    store.create(samplePending());
    expect(store.size()).toBe(2);
    expect(store.consume(a)).toBeNull();
  });
});
