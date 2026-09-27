import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';

// UserInfo describes an authenticated end-user (OIDC Core §5.3). A
// client_credentials token has the client id as its subject, so when a
// client id equals a profile id, UserInfo used to return that person's
// claims for a token no person ever authorized.

const config: Config = {
  signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
  clients: [
    {
      clientId: 'alice',
      clientSecret: 's3cret',
      redirectUris: ['http://localhost:5173/cb'],
      postLogoutRedirectUris: [],
      audience: 'api',
    },
  ],
  subjectClaim: 'sub',
  tokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 28800,
  branding: { title: 'T', accentColor: '#000', logoUrl: null },
  profiles: [
    {
      id: 'alice',
      displayName: 'Alice Human',
      email: 'alice@example.test',
      avatar: null,
      // A custom claim must not be able to impersonate the server's marker.
      claims: { gty: 'client-credentials' },
    },
  ],
};

async function machineToken(app: FastifyInstance, scope: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'alice',
      client_secret: 's3cret',
      scope,
    }).toString(),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { access_token: string }).access_token;
}

async function userToken(app: FastifyInstance): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = await app.inject({
    method: 'GET',
    url:
      '/authorize?' +
      new URLSearchParams({
        client_id: 'alice',
        redirect_uri: 'http://localhost:5173/cb',
        response_type: 'code',
        scope: 'openid profile email',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
  });
  const pendingAuthId = auth.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1]!;
  const complete = await app.inject({
    method: 'POST',
    url: '/authorize/complete',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ pendingAuthId, profileId: 'alice' }).toString(),
  });
  const code = new URL(complete.headers.location as string).searchParams.get('code')!;
  const token = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: 'http://localhost:5173/cb',
      client_id: 'alice',
      client_secret: 's3cret',
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  return (token.json() as { access_token: string }).access_token;
}

describe('userinfo and machine tokens', () => {
  let server: DevOidcServer;
  beforeEach(async () => {
    server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
  });
  afterEach(async () => {
    await server.close();
  });

  it('marks client_credentials access tokens with gty', async () => {
    const token = await machineToken(server.app, '');
    expect(jose.decodeJwt(token).gty).toBe('client-credentials');
  });

  it.each(['openid profile email', ''])(
    'rejects a machine token whose sub equals a profile id (scope %j)',
    async (scope) => {
      const token = await machineToken(server.app, scope);
      const res = await server.app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('invalid_token');
    },
  );

  it('still serves a user token for the same id, ignoring a gty custom claim', async () => {
    const token = await userToken(server.app);
    expect(jose.decodeJwt(token).gty).toBeUndefined();
    const res = await server.app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe('Alice Human');
  });
});
