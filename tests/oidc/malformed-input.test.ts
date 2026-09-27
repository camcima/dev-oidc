import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';

// Request bodies and query strings were cast to TypeScript interfaces without
// checking their runtime shape, so client mistakes surfaced as 500s with
// internal exception text. RFC 6749 §4.1.2.1 and §5.2 call these
// invalid_request, and forbid repeating a parameter.

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

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_CT = { 'content-type': 'application/json' };

let server: DevOidcServer;
let app: FastifyInstance;
beforeEach(async () => {
  server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
  app = server.app;
});
afterEach(async () => {
  await server.close();
});

function expectInvalidRequest(res: { statusCode: number; json: () => unknown }): void {
  expect(res.statusCode).toBe(400);
  expect((res.json() as { error: string }).error).toBe('invalid_request');
}

describe('POST /token with malformed input', () => {
  it('answers invalid_request for an empty body', async () => {
    expectInvalidRequest(await app.inject({ method: 'POST', url: '/token' }));
  });

  it('answers invalid_request for a JSON null body', async () => {
    expectInvalidRequest(
      await app.inject({ method: 'POST', url: '/token', headers: JSON_CT, payload: 'null' }),
    );
  });

  it('answers invalid_request for a numeric client_secret', async () => {
    expectInvalidRequest(
      await app.inject({
        method: 'POST',
        url: '/token',
        headers: JSON_CT,
        payload: { grant_type: 'client_credentials', client_id: 'app', client_secret: 123 },
      }),
    );
  });

  it('answers invalid_request for a repeated form parameter', async () => {
    expectInvalidRequest(
      await app.inject({
        method: 'POST',
        url: '/token',
        headers: FORM,
        payload: 'grant_type=client_credentials&client_id=app&client_id=app&client_secret=shh',
      }),
    );
  });

  it('answers invalid_request for an array-valued grant_type', async () => {
    expectInvalidRequest(
      await app.inject({
        method: 'POST',
        url: '/token',
        headers: JSON_CT,
        payload: { grant_type: ['client_credentials'], client_id: 'app', client_secret: 'shh' },
      }),
    );
  });
});

describe('POST /authorize/complete with malformed input', () => {
  it('answers invalid_request for an empty body', async () => {
    expectInvalidRequest(await app.inject({ method: 'POST', url: '/authorize/complete' }));
  });

  it('answers invalid_request for a repeated parameter', async () => {
    expectInvalidRequest(
      await app.inject({
        method: 'POST',
        url: '/authorize/complete',
        headers: FORM,
        payload: 'pendingAuthId=a&pendingAuthId=b&profileId=alice',
      }),
    );
  });
});

describe('GET /authorize with repeated parameters', () => {
  const base = `client_id=app&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`;

  it('redirects invalid_request with state for a repeated scope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/authorize?${base}&scope=openid&scope=email&state=s1`,
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('redirects invalid_request without echoing a repeated state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/authorize?${base}&scope=openid&state=a&state=b`,
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.has('state')).toBe(false);
  });

  it('answers 400 directly for a repeated client_id, since no callback is validated', async () => {
    expectInvalidRequest(
      await app.inject({ method: 'GET', url: `/authorize?${base}&client_id=app&scope=openid` }),
    );
  });

  it('answers 400 directly for a repeated redirect_uri', async () => {
    expectInvalidRequest(
      await app.inject({
        method: 'GET',
        url: `/authorize?${base}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=openid`,
      }),
    );
  });
});
