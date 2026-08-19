import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer } from '@/server.js';
import { isLoopbackOrigin } from '@/server/cors.js';

function config(): Config {
  return {
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [
      {
        clientId: 'my-app',
        redirectUris: ['http://app.test:4000/cb'],
        postLogoutRedirectUris: [],
        audience: 'my-api',
      },
    ],
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'T', accentColor: '#000', logoUrl: null },
    profiles: [],
  };
}

describe('isLoopbackOrigin', () => {
  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.2:3000',
    'https://app.localhost:8443',
    'http://[::1]:5173',
  ])('accepts %s', (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each(['https://evil.example', 'http://notlocalhost.com', 'http://10.0.0.5:3000'])(
    'rejects %s',
    (origin) => {
      expect(isLoopbackOrigin(origin)).toBe(false);
    },
  );
});

async function originAllowed(origin: string): Promise<boolean> {
  const server = await createDevOidcServer({ config: config(), issuer: 'http://localhost:8095' });
  try {
    const res = await server.app.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration',
      headers: { origin },
    });
    return res.headers['access-control-allow-origin'] !== undefined;
  } finally {
    await server.close();
  }
}

describe('CORS is limited to local development origins', () => {
  it('allows a loopback origin', async () => {
    expect(await originAllowed('http://localhost:5173')).toBe(true);
  });

  it('allows an origin registered as a client redirect URI', async () => {
    // Supports LAN/mobile and custom-domain setups without extra config.
    expect(await originAllowed('http://app.test:4000')).toBe(true);
  });

  it('refuses an arbitrary public website', async () => {
    expect(await originAllowed('https://evil.example')).toBe(false);
  });

  it('still serves requests that carry no Origin header at all', async () => {
    const server = await createDevOidcServer({ config: config(), issuer: 'http://localhost:8095' });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/.well-known/openid-configuration',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
