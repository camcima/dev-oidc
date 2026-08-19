import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Client, Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { registerAuthorize } from '@/oidc/authorize.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

const REDIRECT_URI = 'http://localhost:5173/auth/callback';

function client(overrides: Partial<Client> = {}): Client {
  return {
    clientId: 'my-app',
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [],
    audience: 'my-api',
    ...overrides,
  };
}

function buildConfig(clients: Client[]): Config {
  return {
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients,
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'T', accentColor: '#000', logoUrl: null },
    profiles: [{ id: 'alice', displayName: 'A', email: 'a@x.com', avatar: null, claims: {} }],
  };
}

function buildApp(clients: Client[] = [client()]) {
  const config = buildConfig(clients);
  const runtime = createRuntimeConfig(config);
  const pending = createPendingAuthStore({ ttlMs: 60_000 });
  const app = Fastify();
  const tenant = {
    slug: '(legacy)',
    configPath: '/dev/null',
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    runtime,
    pending,
  } as unknown as ActiveTenantState;
  registerAuthorize(app, { getTenant: () => tenant });
  return { app, pending };
}

function params(overrides: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    client_id: 'my-app',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid',
    state: 'st-1',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return new URLSearchParams(base).toString();
}

async function authorize(app: ReturnType<typeof buildApp>['app'], query: string) {
  return app.inject({ method: 'GET', url: `/authorize?${query}` });
}

describe('authorization errors redirect to the client (RFC 6749 4.1.2.1)', () => {
  it('redirects with unsupported_response_type instead of rendering JSON', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ response_type: 'token' }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('state')).toBe('st-1');
    await app.close();
  });

  it('redirects with invalid_request when response_type is absent', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ response_type: null }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    await app.close();
  });

  it('redirects with invalid_scope when openid is missing', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ scope: 'profile email' }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('state')).toBe('st-1');
    await app.close();
  });

  it('redirects with invalid_scope when a scope is outside allowedScopes', async () => {
    const { app } = buildApp([client({ allowedScopes: ['profile'] })]);
    const res = await authorize(app, params({ scope: 'openid profile admin' }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('error_description')).toContain('admin');
    await app.close();
  });

  it('redirects with invalid_request when code_challenge_method is not S256', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ code_challenge_method: 'plain' }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    await app.close();
  });

  it('omits state from the error redirect when the request carried none', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ response_type: 'token', state: null }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.has('state')).toBe(false);
    await app.close();
  });

  it('preserves a redirect_uri that already has query parameters', async () => {
    const withQuery = 'http://localhost:5173/auth/callback?tenant=acme';
    const { app } = buildApp([client({ redirectUris: [withQuery] })]);
    const res = await authorize(app, params({ response_type: 'token', redirect_uri: withQuery }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('tenant')).toBe('acme');
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    await app.close();
  });

  it('still answers 400 when the client is unknown (nowhere safe to redirect)', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ client_id: 'nope' }));

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_client');
    await app.close();
  });

  it('still answers 400 when redirect_uri is unregistered', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ redirect_uri: 'http://evil.example/cb' }));

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('PKCE requirement follows client type', () => {
  it('requires PKCE for a public client', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ code_challenge: null }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('error_description')).toContain('code_challenge');
    await app.close();
  });

  it('lets a confidential client omit PKCE, as Entra and Auth0 do', async () => {
    const { app } = buildApp([client({ clientSecret: 's3cret' })]);
    const res = await authorize(app, params({ code_challenge: null, code_challenge_method: null }));

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('pendingAuthId');
    await app.close();
  });

  it('still verifies PKCE for a confidential client that opts in', async () => {
    const { app, pending } = buildApp([client({ clientSecret: 's3cret' })]);
    const res = await authorize(app, params());

    expect(res.statusCode).toBe(200);
    const id = res.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1]!;
    expect(pending.consume(id)?.codeChallenge).toBe('abc');
    await app.close();
  });

  it('honours an explicit requirePkce:true on a confidential client', async () => {
    const { app } = buildApp([client({ clientSecret: 's3cret', requirePkce: true })]);
    const res = await authorize(app, params({ code_challenge: null }));

    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe(
      'invalid_request',
    );
    await app.close();
  });

  it('honours an explicit requirePkce:false on a public client', async () => {
    const { app } = buildApp([client({ requirePkce: false })]);
    const res = await authorize(app, params({ code_challenge: null, code_challenge_method: null }));

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('prompt=none', () => {
  it('answers login_required rather than rendering a login page into a hidden iframe', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ prompt: 'none' }));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('state')).toBe('st-1');
    await app.close();
  });

  it('renders the login page normally for other prompt values', async () => {
    const { app } = buildApp();
    const res = await authorize(app, params({ prompt: 'login' }));

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
