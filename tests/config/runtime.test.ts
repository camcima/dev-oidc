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
