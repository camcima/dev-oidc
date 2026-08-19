import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { registerAuthorize } from '@/oidc/authorize.js';
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
        postLogoutRedirectUris: [],
        audience: 'my-api',
      },
    ],
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'T', accentColor: '#000', logoUrl: null },
    profiles: [{ id: 'alice', displayName: 'A', email: 'a@x.com', avatar: null, claims: {} }],
  };
}

async function buildApp() {
  const config = buildConfig();
  const runtime = createRuntimeConfig(config);
  const pending = createPendingAuthStore({ ttlMs: 60_000 });
  const app = Fastify();
  const tenant = buildActiveTenant({ runtime, pending });
  registerAuthorize(app, { getTenant: () => tenant });
  return { app, runtime, pending };
}

const validParams = new URLSearchParams({
  client_id: 'my-app',
  redirect_uri: 'http://localhost:5173/auth/callback',
  response_type: 'code',
  scope: 'openid profile email',
  state: 's1',
  nonce: 'n1',
  code_challenge: 'abc',
  code_challenge_method: 'S256',
});

describe('GET /authorize', () => {
  it('renders the login page on valid params', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/authorize?${validParams}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('<!doctype html>');
    expect(res.payload).toContain('pendingAuthId');
    await app.close();
  });

  it('returns 400 on unknown client_id', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.set('client_id', 'unknown');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 on non-matching redirect_uri', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.set('redirect_uri', 'http://evil.example/cb');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('redirects with unsupported_response_type when response_type is not "code"', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.set('response_type', 'token');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    await app.close();
  });

  it('redirects with invalid_request when code_challenge_method is not S256', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.set('code_challenge_method', 'plain');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    await app.close();
  });

  it('redirects with invalid_request when a public client omits code_challenge', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.delete('code_challenge');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    await app.close();
  });

  it('stores a pending-auth record retrievable by id', async () => {
    const { app, pending } = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/authorize?${validParams}` });
    const match = res.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/);
    expect(match).not.toBeNull();
    const id = match![1]!;
    const rec = pending.consume(id);
    expect(rec?.clientId).toBe('my-app');
    expect(rec?.codeChallenge).toBe('abc');
    expect(rec?.state).toBe('s1');
    await app.close();
  });

  it('redirects with invalid_scope when the requested scope does not include openid', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.set('scope', 'profile email');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    await app.close();
  });

  it('accepts a scope that includes openid plus custom values', async () => {
    const { app, pending } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.set('scope', 'openid custom_scope');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(200);
    const match = res.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/);
    expect(match).not.toBeNull();
    const rec = pending.consume(match![1]!);
    expect(rec?.scope).toBe('openid custom_scope');
    await app.close();
  });

  it('login page links to the per-tenant admin path when adminPath is provided', async () => {
    const config = buildConfig();
    const runtime = createRuntimeConfig(config);
    const pending = createPendingAuthStore({ ttlMs: 60_000 });
    const app = Fastify();
    const tenant = buildActiveTenant({ slug: 'acme', runtime, pending });
    registerAuthorize(app, { getTenant: () => tenant, adminPath: (slug) => `/admin/${slug}` });

    const res = await app.inject({ method: 'GET', url: `/authorize?${validParams}` });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('href="/admin/acme"');
    await app.close();
  });
});

describe('allowedScopes policy', () => {
  function buildScopedConfig(): Config {
    const config = buildConfig();
    return {
      ...config,
      clients: [
        {
          clientId: 'scoped-app',
          redirectUris: ['http://localhost:5173/auth/callback'],
          postLogoutRedirectUris: [],
          audience: 'my-api',
          allowedScopes: ['profile'],
        },
        {
          clientId: 'my-app',
          redirectUris: ['http://localhost:5173/auth/callback'],
          postLogoutRedirectUris: [],
          audience: 'my-api',
        },
      ],
    };
  }

  async function buildScopedApp() {
    const config = buildScopedConfig();
    const runtime = createRuntimeConfig(config);
    const pending = createPendingAuthStore({ ttlMs: 60_000 });
    const app = Fastify();
    const tenant = buildActiveTenant({ runtime, pending });
    registerAuthorize(app, { getTenant: () => tenant });
    return { app, runtime, pending };
  }

  it('rejects scopes outside the allowlist with invalid_scope', async () => {
    const { app } = await buildScopedApp();
    const params = new URLSearchParams(validParams);
    params.set('client_id', 'scoped-app');
    params.set('scope', 'openid profile admin');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('error_description')).toContain('admin');
    await app.close();
  });

  it('accepts scopes inside the allowlist (openid always implied)', async () => {
    const { app } = await buildScopedApp();
    const params = new URLSearchParams(validParams);
    params.set('client_id', 'scoped-app');
    params.set('scope', 'openid profile');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('keeps full passthrough when allowedScopes is absent', async () => {
    const { app } = await buildScopedApp();
    const params = new URLSearchParams(validParams);
    params.set('client_id', 'my-app');
    params.set('scope', 'openid whatever_custom');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
