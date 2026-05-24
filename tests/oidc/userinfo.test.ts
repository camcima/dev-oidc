import Fastify from 'fastify';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { registerUserInfo } from '@/oidc/userinfo.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

function buildConfig(): Config {
  return {
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [
      {
        clientId: 'my-app',
        redirectUris: ['http://localhost:5173/cb'],
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
        displayName: 'Alice Dev',
        email: 'alice@example.com',
        avatar: null,
        emailVerified: true,
        givenName: 'Alice',
        familyName: 'Dev',
        claims: { role: 'admin' },
      },
    ],
  };
}

async function buildApp() {
  const config = buildConfig();
  const runtime = createRuntimeConfig(config);
  const keyMaterial = await createKeyMaterial(runtime.get().signingKey);
  const app = Fastify();
  const tenant = {
    slug: '(legacy)',
    configPath: '/dev/null',
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    config,
    runtime,
    keyMaterial,
  } as unknown as ActiveTenantState;
  registerUserInfo(app, { getTenant: () => tenant });
  return { app, keyMaterial };
}

async function mintAccessToken(
  keyMaterial: Awaited<ReturnType<typeof createKeyMaterial>>,
  scope: string,
): Promise<string> {
  return new jose.SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', kid: keyMaterial.kid, typ: 'JWT' })
    .setIssuer('http://localhost:8095')
    .setAudience('my-api')
    .setSubject('alice')
    .setIssuedAt()
    .setExpirationTime('900s')
    .sign(keyMaterial.privateKey);
}

describe('GET/POST /userinfo', () => {
  it('returns scope-gated claims incl. sub for a valid token', async () => {
    const { app, keyMaterial } = await buildApp();
    const token = await mintAccessToken(keyMaterial, 'openid profile email');
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({
        method,
        url: '/userinfo',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.sub).toBe('alice');
      expect(body.name).toBe('Alice Dev');
      expect(body.given_name).toBe('Alice');
      expect(body.email).toBe('alice@example.com');
      expect(body.role).toBe('admin');
    }
    await app.close();
  });

  it('omits profile/email claims when those scopes are absent', async () => {
    const { app, keyMaterial } = await buildApp();
    const token = await mintAccessToken(keyMaterial, 'openid');
    const res = await app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as Record<string, unknown>;
    expect(body.sub).toBe('alice');
    expect(body.name).toBeUndefined();
    expect(body.email).toBeUndefined();
    await app.close();
  });

  it('401 + WWW-Authenticate: Bearer when the token is missing', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/userinfo' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/i);
    await app.close();
  });

  it('401 invalid_token when the token is malformed', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/invalid_token/);
    await app.close();
  });

  it('401 invalid_token when the token is expired', async () => {
    const { app, keyMaterial } = await buildApp();
    const token = await new jose.SignJWT({ scope: 'openid' })
      .setProtectedHeader({ alg: 'RS256', kid: keyMaterial.kid, typ: 'JWT' })
      .setIssuer('http://localhost:8095')
      .setAudience('my-api')
      .setSubject('alice')
      .setIssuedAt()
      .setExpirationTime('-1s')
      .sign(keyMaterial.privateKey);
    const res = await app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/invalid_token/);
    await app.close();
  });

  it('401 invalid_token when the token sub has no matching profile', async () => {
    const { app, keyMaterial } = await buildApp();
    const token = await new jose.SignJWT({ scope: 'openid profile' })
      .setProtectedHeader({ alg: 'RS256', kid: keyMaterial.kid, typ: 'JWT' })
      .setIssuer('http://localhost:8095')
      .setAudience('my-api')
      .setSubject('ghost-user-not-in-config')
      .setIssuedAt()
      .setExpirationTime('900s')
      .sign(keyMaterial.privateKey);
    const res = await app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/invalid_token/);
    await app.close();
  });
});
