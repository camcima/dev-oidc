import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { registerLogout } from '@/oidc/logout.js';

function buildConfig(): Config {
  return {
    issuer: 'http://localhost:8080',
    port: 8080,
    host: '127.0.0.1',
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [
      {
        clientId: 'my-app',
        redirectUris: ['http://localhost:5173/auth/callback'],
        postLogoutRedirectUris: ['http://localhost:5173/'],
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

async function buildApp() {
  const runtime = createRuntimeConfig(buildConfig());
  const app = Fastify();
  registerLogout(app, { runtime });
  return { app };
}

describe('GET /logout', () => {
  it('redirects to a registered post_logout_redirect_uri', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/logout?post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/');
    await app.close();
  });

  it('redirects to "/" when no post_logout_redirect_uri provided', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/logout' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    await app.close();
  });

  it('rejects non-registered post_logout_redirect_uri', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/logout?post_logout_redirect_uri=http%3A%2F%2Fevil.example%2F',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
