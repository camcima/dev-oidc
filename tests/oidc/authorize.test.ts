import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { registerAuthorize } from '@/oidc/authorize.js';

function buildConfig(): Config {
  return {
    issuer: 'http://localhost:8095',
    port: 8095,
    host: '127.0.0.1',
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
  const runtime = createRuntimeConfig(buildConfig());
  const pending = createPendingAuthStore({ ttlMs: 60_000 });
  const app = Fastify();
  registerAuthorize(app, { runtime, pending });
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

  it('returns 400 when response_type is not "code"', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.set('response_type', 'token');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when code_challenge_method is not S256', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.set('code_challenge_method', 'plain');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when code_challenge is missing', async () => {
    const { app } = await buildApp();
    const params = new URLSearchParams(validParams);
    params.delete('code_challenge');
    const res = await app.inject({ method: 'GET', url: `/authorize?${params}` });
    expect(res.statusCode).toBe(400);
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
});
