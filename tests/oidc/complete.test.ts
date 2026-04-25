import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { createCodeStore } from '@/oidc/codes.js';
import { registerComplete } from '@/oidc/complete.js';

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
    profiles: [
      { id: 'alice', displayName: 'A', email: 'a@x.com', avatar: null, claims: {} },
      { id: 'bob', displayName: 'B', email: 'b@x.com', avatar: null, claims: {} },
    ],
  };
}

async function buildApp() {
  const runtime = createRuntimeConfig(buildConfig());
  const pending = createPendingAuthStore({ ttlMs: 60_000 });
  const codes = createCodeStore({ ttlMs: 60_000 });
  const app = Fastify();
  await app.register(formbody);
  registerComplete(app, { runtime, pending, codes });
  return { app, pending, codes };
}

describe('POST /authorize/complete', () => {
  it('issues a code and redirects to the registered redirect_uri', async () => {
    const { app, pending } = await buildApp();
    const id = pending.create({
      clientId: 'my-app',
      redirectUri: 'http://localhost:5173/auth/callback',
      codeChallenge: 'xyz',
      codeChallengeMethod: 'S256',
      nonce: 'n1',
      state: 's1',
      scope: 'openid',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/authorize/complete',
      payload: `pendingAuthId=${id}&profileId=alice`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toMatch(/^http:\/\/localhost:5173\/auth\/callback\?/);
    const url = new URL(location);
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('code')).not.toBeNull();
    await app.close();
  });

  it('stored code carries the chosen profile', async () => {
    const { app, pending, codes } = await buildApp();
    const id = pending.create({
      clientId: 'my-app',
      redirectUri: 'http://localhost:5173/auth/callback',
      codeChallenge: 'xyz',
      codeChallengeMethod: 'S256',
      nonce: 'n1',
      state: 's1',
      scope: 'openid',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/authorize/complete',
      payload: `pendingAuthId=${id}&profileId=bob`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    const code = new URL(res.headers.location as string).searchParams.get('code')!;
    const record = codes.consume(code);
    expect(record?.profileId).toBe('bob');
    expect(record?.codeChallenge).toBe('xyz');
    await app.close();
  });

  it('returns 400 when pendingAuthId is unknown/expired', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/authorize/complete',
      payload: `pendingAuthId=nonexistent&profileId=alice`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when profileId is unknown', async () => {
    const { app, pending } = await buildApp();
    const id = pending.create({
      clientId: 'my-app',
      redirectUri: 'http://localhost:5173/auth/callback',
      codeChallenge: 'xyz',
      codeChallengeMethod: 'S256',
      nonce: 'n1',
      state: 's1',
      scope: 'openid',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/authorize/complete',
      payload: `pendingAuthId=${id}&profileId=ghost`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('forwards the pending-record scope into the issued code', async () => {
    const { app, codes, pending } = await buildApp();
    const pendingId = pending.create({
      clientId: 'my-app',
      redirectUri: 'http://localhost:5173/auth/callback',
      codeChallenge: 'cc',
      codeChallengeMethod: 'S256',
      nonce: 'n1',
      state: 's1',
      scope: 'openid email custom_scope',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/authorize/complete',
      payload: { pendingAuthId: pendingId, profileId: 'alice' },
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    const codeMatch = /[?&]code=([^&]+)/.exec(location);
    expect(codeMatch).not.toBeNull();
    const record = codes.consume(codeMatch![1]!);
    expect(record?.scope).toBe('openid email custom_scope');
    await app.close();
  });
});
