import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createCodeStore } from '@/oidc/codes.js';
import type { CodeStore } from '@/oidc/codes.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { registerToken } from '@/oidc/token.js';
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
  const config = buildConfig();
  const runtime = createRuntimeConfig(config);
  const codes = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
  const keyMaterial = await createKeyMaterial(runtime.get().signingKey);
  const app = Fastify();
  await app.register(formbody);
  const tenant = buildActiveTenant({ config, runtime, codes, keyMaterial });
  registerToken(app, { getTenant: () => tenant });
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
    expect(payload.email).toBeUndefined();
    expect((payload as Record<string, unknown>).role).toBe('admin');
    expect((payload as Record<string, unknown>).scope).toBe('openid profile custom_scope');
    expect((res.json() as { scope: string }).scope).toBe('openid profile custom_scope');
    await app.close();
  });

  it('rejects with invalid_request when redirect_uri is missing', async () => {
    const { app, codes } = await buildApp();
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
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
        code_verifier: verifier,
        client_id: 'my-app',
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    await app.close();
  });

  it('rejects with invalid_grant when redirect_uri does not match the code', async () => {
    const { app, codes } = await buildApp();
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
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
        code_verifier: verifier,
        client_id: 'my-app',
        redirect_uri: 'http://localhost:5173/other/callback',
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
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

  it('rotates the refresh token: the old one is rejected after first use', async () => {
    const { app, codes } = await buildApp();
    const oldToken = codes.issueRefresh({
      clientId: 'my-app',
      profileId: 'alice',
      scope: 'openid profile',
    });

    const first = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oldToken,
        client_id: 'my-app',
      }).toString(),
    });
    expect(first.statusCode).toBe(200);
    const newToken = (first.json() as { refresh_token: string }).refresh_token;
    expect(newToken).not.toBe(oldToken);

    const second = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oldToken,
        client_id: 'my-app',
      }).toString(),
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('invalid_grant');
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

function buildConfigWithSecret(): Config {
  return {
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [
      {
        clientId: 'confidential-app',
        clientSecret: 's3cr3t-value',
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
        claims: {},
      },
    ],
  };
}

async function buildAppWithSecret() {
  const config = buildConfigWithSecret();
  const runtime = createRuntimeConfig(config);
  const codes = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
  const keyMaterial = await createKeyMaterial(runtime.get().signingKey);
  const app = Fastify();
  await app.register(formbody);
  const tenant = buildActiveTenant({ config, runtime, codes, keyMaterial });
  registerToken(app, { getTenant: () => tenant });
  return { app, codes };
}

describe('POST /token (ID-token fidelity claims)', () => {
  it('emits azp/at_hash/auth_time on the id_token and a scope-gated identity set', async () => {
    const { app, codes, keyMaterial } = await buildApp();
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: 'n1',
      redirectUri: 'http://localhost:5173/auth/callback',
      scope: 'openid profile',
      authTime: 1700000000,
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
    const body = res.json() as { access_token: string; id_token: string };

    const idKey = await jose.importJWK(keyMaterial.publicJwk, 'RS256');
    const { payload: id } = await jose.jwtVerify(body.id_token, idKey, {
      issuer: 'http://localhost:8095',
      audience: 'my-app',
    });
    expect(id.azp).toBe('my-app');
    expect(id.auth_time).toBe(1700000000);
    expect(id.name).toBe('Alice'); // profile scope granted
    expect(id.email).toBeUndefined(); // email scope NOT granted

    const expectedAtHash = createHash('sha256')
      .update(body.access_token)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    expect(id.at_hash).toBe(expectedAtHash);

    const { payload: at } = await jose.jwtVerify(body.access_token, idKey, {
      issuer: 'http://localhost:8095',
      audience: 'my-api',
    });
    expect(at.email).toBeUndefined();
    expect((at as Record<string, unknown>).role).toBe('admin');
    await app.close();
  });

  it('keeps auth_time stable across a refresh', async () => {
    const { app, codes } = await buildApp();
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: 'n1',
      redirectUri: 'http://localhost:5173/auth/callback',
      scope: 'openid',
      authTime: 1700000000,
    });
    const first = await app.inject({
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
    const { id_token: id1, refresh_token } = first.json() as {
      id_token: string;
      refresh_token: string;
    };
    const authTime1 = jose.decodeJwt(id1).auth_time;
    expect(authTime1).toBe(1700000000);

    const second = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: 'my-app',
      }).toString(),
    });
    const { id_token: id2 } = second.json() as { id_token: string };
    expect(jose.decodeJwt(id2).auth_time).toBe(1700000000);
    await app.close();
  });
});

describe('POST /token does not consume credentials on invalid exchanges', () => {
  const verifier = 'verifier-0123456789abcdef0123456789abcdef';

  function issueCode(codes: CodeStore): string {
    return codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: 'n1',
      redirectUri: 'http://localhost:5173/auth/callback',
      scope: 'openid',
    });
  }

  function exchange(
    app: Awaited<ReturnType<typeof buildApp>>['app'],
    params: Record<string, string>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(params).toString(),
    });
  }

  const validParams = (code: string) => ({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: 'my-app',
    redirect_uri: 'http://localhost:5173/auth/callback',
  });

  it('a wrong PKCE verifier is rejected but the code survives for a valid retry', async () => {
    const { app, codes } = await buildApp();
    const code = issueCode(codes);

    const bad = await exchange(app, {
      ...validParams(code),
      code_verifier: 'wrong-verifier-wrong-verifier-wrong',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error_description).toBe('PKCE verifier mismatch');

    const good = await exchange(app, validParams(code));
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('a wrong redirect_uri is rejected but the code survives', async () => {
    const { app, codes } = await buildApp();
    const code = issueCode(codes);

    const bad = await exchange(app, {
      ...validParams(code),
      redirect_uri: 'http://evil.example/cb',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error_description).toBe('redirect_uri mismatch');

    const good = await exchange(app, validParams(code));
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('a refresh with the wrong client_id is rejected but the refresh token survives', async () => {
    const { app, codes } = await buildApp();
    const refreshToken = codes.issueRefresh({
      clientId: 'my-app',
      profileId: 'alice',
      scope: 'openid',
    });

    const bad = await exchange(app, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'other-app',
    });
    // 'other-app' is unknown, so this fails at client auth; the important
    // assertion is that the token was not burned.
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    const good = await exchange(app, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'my-app',
    });
    expect(good.statusCode).toBe(200);
    await app.close();
  });
});

describe('POST /token (client_secret enforcement)', () => {
  function payload(extra: Record<string, string>): string {
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    return new URLSearchParams({
      grant_type: 'authorization_code',
      code_verifier: verifier,
      client_id: 'confidential-app',
      redirect_uri: 'http://localhost:5173/auth/callback',
      ...extra,
    }).toString();
  }

  function issue(codes: CodeStore): string {
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    return codes.issue({
      clientId: 'confidential-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: 'n1',
      redirectUri: 'http://localhost:5173/auth/callback',
      scope: 'openid',
    });
  }

  it('returns 401 invalid_client when secret is missing', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload({ code }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(res.headers['www-authenticate']).toMatch(/Basic/i);
    await app.close();
  });

  it('returns 401 invalid_client when secret is wrong', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload({ code, client_secret: 'wrong-secret' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    await app.close();
  });

  it('accepts a correct secret via client_secret_post', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload({ code, client_secret: 's3cr3t-value' }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('accepts a correct secret via client_secret_basic (HTTP Basic)', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const basic = Buffer.from('confidential-app:s3cr3t-value').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      payload: payload({ code }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 400 invalid_request when basic and form values disagree', async () => {
    const { app, codes } = await buildAppWithSecret();
    const code = issue(codes);
    const basic = Buffer.from('confidential-app:s3cr3t-value').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      payload: payload({ code, client_secret: 'different-secret' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    await app.close();
  });
});
