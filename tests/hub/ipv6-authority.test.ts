import { describe, expect, it } from 'vitest';
import { buildAdminAllowedHosts } from '@/admin/guard.js';
import type { Config } from '@/config/schema.js';
import { pickRedirectHost } from '@/hub/issuer.js';
import { createDevOidcServer } from '@/server.js';

// A bare IPv6 listen host must be bracketed wherever it becomes a URL
// authority. The CLI and hub defaults already did this through
// formatHostPort(); the programmatic factory, the HTTPS redirect and the admin
// Host allowlist concatenated the raw host, producing `http://::1:8095`.

const config: Config = {
  signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
  clients: [
    {
      clientId: 'app',
      redirectUris: ['http://localhost/cb'],
      postLogoutRedirectUris: [],
      audience: 'a',
    },
  ],
  subjectClaim: 'sub',
  tokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 28800,
  branding: { title: 'T', accentColor: '#000', logoUrl: null },
  profiles: [],
};

describe('IPv6 listen hosts', () => {
  it('the factory advertises a bracketed issuer', async () => {
    const server = await createDevOidcServer({ config, listenHost: '::1', listenPort: 8095 });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/.well-known/openid-configuration',
      });
      const { issuer } = res.json() as { issuer: string };
      expect(issuer).toBe('http://[::1]:8095');
      expect(() => new URL(issuer)).not.toThrow();
    } finally {
      await server.close();
    }
  });

  it('the HTTPS redirect echoes a matching bracketed Host', () => {
    expect(
      pickRedirectHost({
        requestHost: '[::1]:8095',
        publicUrl: undefined,
        listenHost: '::1',
        listenPort: 8095,
      }),
    ).toBe('[::1]:8095');
  });

  it('the HTTPS redirect falls back to a bracketed authority', () => {
    expect(
      pickRedirectHost({
        requestHost: 'evil.test:8095',
        publicUrl: undefined,
        listenHost: 'fe80::1',
        listenPort: 8095,
      }),
    ).toBe('[fe80::1]:8095');
  });

  it('the admin allowlist accepts the bracketed Host a browser sends', () => {
    const allowed = buildAdminAllowedHosts({ listenHost: 'fe80::1', listenPort: 8095 });
    expect(allowed.has('[fe80::1]:8095')).toBe(true);
    expect(allowed.has('[fe80::1]')).toBe(true);
  });
});
