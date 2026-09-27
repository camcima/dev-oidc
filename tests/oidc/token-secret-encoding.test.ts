import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';

// A body client_secret is already decoded by the form or JSON parser. It used
// to be form-decoded a second time and either reading accepted, so the
// literal secret "a+b" authenticated a client whose secret is "a b".
// Only the Basic header keeps the raw-or-encoded tolerance, because
// RFC 6749 §2.3.1 encodes it and many tools do not.

const config: Config = {
  signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
  clients: [
    {
      clientId: 'app',
      clientSecret: 'a b',
      redirectUris: ['http://localhost:5173/cb'],
      postLogoutRedirectUris: [],
      audience: 'api',
    },
  ],
  subjectClaim: 'sub',
  tokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 28800,
  branding: { title: 'T', accentColor: '#000', logoUrl: null },
  profiles: [],
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

function formPost(rawBody: string) {
  return app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=client_credentials&client_id=app&${rawBody}`,
  });
}
function jsonPost(secret: string) {
  return app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/json' },
    payload: { grant_type: 'client_credentials', client_id: 'app', client_secret: secret },
  });
}
function basicPost(secret: string) {
  return app.inject({
    method: 'POST',
    url: '/token',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`app:${secret}`).toString('base64')}`,
    },
    payload: 'grant_type=client_credentials',
  });
}

describe('client secret comparison', () => {
  it.each([
    ['a+b', 200],
    ['a%20b', 200],
    ['a%2Bb', 401],
    ['a%252Bb', 401],
  ])('form body client_secret=%s -> %i', async (raw, status) => {
    expect((await formPost(`client_secret=${raw}`)).statusCode).toBe(status);
  });

  it.each([
    ['a b', 200],
    ['a+b', 401],
    ['a%20b', 401],
  ])('JSON body client_secret %j -> %i', async (secret, status) => {
    expect((await jsonPost(secret)).statusCode).toBe(status);
  });

  it.each([
    ['a b', 200],
    ['a+b', 200],
    ['a%20b', 200],
    ['a%2Bb', 401],
  ])('Basic header secret %j -> %i', async (secret, status) => {
    expect((await basicPost(secret)).statusCode).toBe(status);
  });
});
