import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';

// RFC 6749 §5.1 and §5.2: token responses, successful or not, carry
// Cache-Control: no-store and Pragma: no-cache.

const REDIRECT = 'http://localhost:5173/cb';
const config: Config = {
  signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
  clients: [
    {
      clientId: 'app',
      clientSecret: 'shh',
      redirectUris: [REDIRECT],
      postLogoutRedirectUris: [],
      audience: 'api',
    },
  ],
  subjectClaim: 'sub',
  tokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 28800,
  branding: { title: 'T', accentColor: '#000', logoUrl: null },
  profiles: [{ id: 'alice', displayName: 'A', email: 'a@x.com', avatar: null, claims: {} }],
};

let server: DevOidcServer;
let app: FastifyInstance;
beforeEach(async () => {
  server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
  app = server.app;
});
afterEach(async () => {
  await server.close();
});

function token(fields: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ client_id: 'app', client_secret: 'shh', ...fields }).toString(),
  });
}

function expectNoStore(res: { headers: Record<string, unknown> }): void {
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['pragma']).toBe('no-cache');
}

async function authorizationCode(): Promise<string> {
  const auth = await app.inject({
    method: 'GET',
    url:
      '/authorize?' +
      new URLSearchParams({
        client_id: 'app',
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'openid',
      }).toString(),
  });
  const pendingAuthId = auth.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1]!;
  const complete = await app.inject({
    method: 'POST',
    url: '/authorize/complete',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ pendingAuthId, profileId: 'alice' }).toString(),
  });
  return new URL(complete.headers.location as string).searchParams.get('code')!;
}

describe('token endpoint cache headers', () => {
  it('on code exchange and refresh', async () => {
    const code = await authorizationCode();
    const exchanged = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
    });
    expect(exchanged.statusCode).toBe(200);
    expectNoStore(exchanged);

    const { refresh_token } = exchanged.json() as { refresh_token: string };
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token });
    expect(refreshed.statusCode).toBe(200);
    expectNoStore(refreshed);
  });

  it('on client_credentials', async () => {
    const res = await token({ grant_type: 'client_credentials' });
    expect(res.statusCode).toBe(200);
    expectNoStore(res);
  });

  it('on errors', async () => {
    const badGrant = await token({ grant_type: 'password' });
    expect(badGrant.statusCode).toBe(400);
    expectNoStore(badGrant);

    const badClient = await token({ grant_type: 'client_credentials', client_secret: 'nope' });
    expect(badClient.statusCode).toBe(401);
    expectNoStore(badClient);
  });
});
