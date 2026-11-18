import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { createCodeStore } from '@/oidc/codes.js';
import { registerComplete } from '@/oidc/complete.js';
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
    profiles: [
      { id: 'alice', displayName: 'A', email: 'a@x.com', avatar: null, claims: {} },
      { id: 'bob', displayName: 'B', email: 'b@x.com', avatar: null, claims: {} },
    ],
  };
}

async function buildApp() {
  const config = buildConfig();
  const runtime = createRuntimeConfig(config);
  const pending = createPendingAuthStore({ ttlMs: 60_000 });
  const codes = createCodeStore({ ttlMs: 60_000 });
  const app = Fastify();
  await app.register(formbody);
  const tenant = buildActiveTenant({ runtime, pending, codes });
  registerComplete(app, { getTenant: () => tenant });
  return { app, pending, codes };
}

describe('POST /authorize/complete', () => {
  it('issues a code and redirects to the registered redirect_uri', async () => {
    const { app, pending } = await buildApp();
    const id = pending.create({
      clientId: 'my-app',
      redirectUri: 'http://localhost:5173/auth/callback',
      codeChallenge: 'xyz',
      nonce: 'n1',
      state: 's1',
      scope: 'openid',
      responseMode: 'query',
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
      nonce: 'n1',
      state: 's1',
      scope: 'openid',
      responseMode: 'query',
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
      nonce: 'n1',
      state: 's1',
      scope: 'openid',
      responseMode: 'query',
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
      nonce: 'n1',
      state: 's1',
      scope: 'openid email custom_scope',
      responseMode: 'query',
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

  describe('response_mode', () => {
    function createPending(
      pending: Awaited<ReturnType<typeof buildApp>>['pending'],
      responseMode: 'query' | 'fragment' | 'form_post',
    ): string {
      return pending.create({
        clientId: 'my-app',
        redirectUri: 'http://localhost:5173/auth/callback',
        codeChallenge: 'xyz',
        nonce: 'n1',
        state: 's1',
        scope: 'openid',
        responseMode,
      });
    }

    async function complete(app: Awaited<ReturnType<typeof buildApp>>['app'], id: string) {
      return app.inject({
        method: 'POST',
        url: '/authorize/complete',
        payload: `pendingAuthId=${id}&profileId=alice`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    }

    it('query keeps the exact pre-response_mode Location (regression guard)', async () => {
      const { app, pending } = await buildApp();
      const res = await complete(app, createPending(pending, 'query'));

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(
        /^http:\/\/localhost:5173\/auth\/callback\?code=[A-Za-z0-9_-]+&state=s1$/,
      );
      await app.close();
    });

    it('fragment puts code and state in the fragment', async () => {
      const { app, pending, codes } = await buildApp();
      const res = await complete(app, createPending(pending, 'fragment'));

      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
      expect(url.origin + url.pathname).toBe('http://localhost:5173/auth/callback');
      expect(url.search).toBe('');
      const fragment = new URLSearchParams(url.hash.slice(1));
      expect(fragment.get('state')).toBe('s1');
      expect(codes.consume(fragment.get('code')!)?.profileId).toBe('alice');
      await app.close();
    });

    it('form_post answers an auto-submitting form carrying code and state', async () => {
      const { app, pending, codes } = await buildApp();
      const res = await complete(app, createPending(pending, 'form_post'));

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.location).toBeUndefined();
      expect(res.payload).toContain(
        '<form method="post" action="http://localhost:5173/auth/callback">',
      );
      expect(res.payload).toContain('<input type="hidden" name="state" value="s1">');
      const code = res.payload.match(/name="code" value="([^"]+)"/)![1]!;
      expect(codes.consume(code)?.profileId).toBe('alice');
      await app.close();
    });
  });
});
