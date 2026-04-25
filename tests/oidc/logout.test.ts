import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { registerLogout } from '@/oidc/logout.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

function buildActiveTenant(overrides: Partial<ActiveTenantState>): ActiveTenantState {
  return {
    slug: '(legacy)',
    configPath: '/dev/null',
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    ...overrides,
  } as ActiveTenantState;
}

function buildConfig(): Config {
  return {
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
  const config = buildConfig();
  const runtime = createRuntimeConfig(config);
  const app = Fastify();
  const tenant = buildActiveTenant({ config, runtime });
  registerLogout(app, { getTenant: () => tenant });
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

  it('returns a 200 HTML confirmation page when no post_logout_redirect_uri is provided', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/logout' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('Signed out');
    expect(res.payload).toMatch(/href="\/"/);
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
