import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createCodeStore } from '@/oidc/codes.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { registerToken } from '@/oidc/token.js';

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
      {
        id: 'alice',
        displayName: 'Alice',
        email: 'a@x.com',
        avatar: null,
        claims: { role: 'admin' },
      },
    ],
  };
}

async function buildApp() {
  const runtime = createRuntimeConfig(buildConfig());
  const codes = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
  const keyMaterial = await createKeyMaterial(runtime.get().signingKey);
  const app = Fastify();
  await app.register(formbody);
  registerToken(app, { runtime, codes, keyMaterial });
  return { app, runtime, codes, keyMaterial };
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('POST /token (authorization_code)', () => {
  it('exchanges a valid code for a verifiable access token', async () => {
    const { app, codes, keyMaterial } = await buildApp();
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: 'n1',
      redirectUri: 'http://localhost:5173/auth/callback',
      scope: 'openid profile custom_scope',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: 'my-app',
        redirect_uri: 'http://localhost:5173/auth/callback',
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { access_token: string; id_token: string; refresh_token: string };
    expect(body.access_token).toBeTruthy();
    expect(body.id_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();

    const { payload } = await jose.jwtVerify(
      body.access_token,
      await jose.importJWK(keyMaterial.publicJwk, 'RS256'),
      { issuer: 'http://localhost:8095', audience: 'my-api' },
    );
    expect(payload.sub).toBe('alice');
    expect(payload.email).toBe('a@x.com');
    expect((payload as Record<string, unknown>).role).toBe('admin');
    expect((payload as Record<string, unknown>).scope).toBe('openid profile custom_scope');
    expect((res.json() as { scope: string }).scope).toBe('openid profile custom_scope');
    await app.close();
  });

  it('rejects with invalid_grant when PKCE verifier does not match', async () => {
    const { app, codes } = await buildApp();
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256('correct-verifier'),
      nonce: 'n1',
      redirectUri: 'http://localhost:5173/auth/callback',
      scope: 'openid',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'wrong-verifier',
        client_id: 'my-app',
        redirect_uri: 'http://localhost:5173/auth/callback',
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    await app.close();
  });

  it('rejects when the code has already been consumed', async () => {
    const { app, codes } = await buildApp();
    const verifier = 'verifier-0123456789abcdef';
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: 'n1',
      redirectUri: 'http://localhost:5173/auth/callback',
      scope: 'openid',
    });

    const payload = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'my-app',
      redirect_uri: 'http://localhost:5173/auth/callback',
    }).toString();

    const first = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload,
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('invalid_grant');
    await app.close();
  });
});

describe('POST /token (refresh_token)', () => {
  it('exchanges a valid refresh token for a new access token', async () => {
    const { app, codes, keyMaterial } = await buildApp();
    const refreshToken = codes.issueRefresh({
      clientId: 'my-app',
      profileId: 'alice',
      scope: 'openid profile',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'my-app',
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { access_token: string };
    const { payload } = await jose.jwtVerify(
      body.access_token,
      await jose.importJWK(keyMaterial.publicJwk, 'RS256'),
      { issuer: 'http://localhost:8095', audience: 'my-api' },
    );
    expect(payload.sub).toBe('alice');
    expect((payload as Record<string, unknown>).scope).toBe('openid profile');
    await app.close();
  });

  it('rejects unknown refresh token with invalid_grant', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'does-not-exist',
        client_id: 'my-app',
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    await app.close();
  });
});

describe('POST /token (unsupported grants)', () => {
  it('rejects unknown grant types', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'my-app',
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_grant_type');
    await app.close();
  });
});
