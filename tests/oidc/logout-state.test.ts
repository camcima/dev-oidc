import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { registerLogout } from '@/oidc/logout.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

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
  await app.register(formbody);
  const tenant = {
    slug: '(legacy)',
    configPath: '/dev/null',
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    runtime,
  } as unknown as ActiveTenantState;
  registerLogout(app, { getTenant: () => tenant });
  return app;
}

describe('RP-initiated logout echoes state', () => {
  it('appends the state parameter to the post-logout redirect', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/logout?post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F&state=xyz789',
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('state')).toBe('xyz789');
    await app.close();
  });

  it('leaves the redirect untouched when no state was supplied', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/logout?post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/');
    await app.close();
  });

  it('reads post_logout_redirect_uri and state from a form-encoded POST body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F&state=from-body',
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe('http://localhost:5173/');
    expect(location.searchParams.get('state')).toBe('from-body');
    await app.close();
  });

  it('still rejects an unregistered post_logout_redirect_uri from the body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'post_logout_redirect_uri=http%3A%2F%2Fevil.example%2F&state=s',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
