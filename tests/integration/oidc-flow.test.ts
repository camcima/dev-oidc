import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer } from '@/server.js';

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const config: Config = {
  signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
  clients: [
    {
      clientId: 'my-app',
      redirectUris: ['http://localhost:5173/auth/callback'],
      postLogoutRedirectUris: ['http://localhost:5173/'],
      audience: 'my-api',
    },
  ],
  subjectClaim: 'sub',
  tokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 28800,
  branding: { title: 'Test', accentColor: '#000', logoUrl: null },
  profiles: [
    {
      id: 'bob',
      displayName: 'Bob',
      email: 'bob@example.com',
      avatar: null,
      claims: { role: 'manager' },
    },
  ],
};

describe('integration: full auth-code + PKCE flow', () => {
  it('mints a verifiable access token end-to-end', async () => {
    const server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
    try {
      const { verifier, challenge } = pkcePair();

      const authRes = await server.app.inject({
        method: 'GET',
        url:
          '/authorize?' +
          new URLSearchParams({
            client_id: 'my-app',
            redirect_uri: 'http://localhost:5173/auth/callback',
            response_type: 'code',
            scope: 'openid profile email',
            state: 'xyz',
            nonce: 'n1',
            code_challenge: challenge,
            code_challenge_method: 'S256',
          }).toString(),
      });
      expect(authRes.statusCode).toBe(200);
      const pendingId = authRes.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1];

      const completeRes = await server.app.inject({
        method: 'POST',
        url: '/authorize/complete',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `pendingAuthId=${pendingId}&profileId=bob`,
      });
      expect(completeRes.statusCode).toBe(302);
      const code = new URL(completeRes.headers.location as string).searchParams.get('code')!;

      const tokenRes = await server.app.inject({
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
      expect(tokenRes.statusCode).toBe(200);
      const tokens = tokenRes.json() as { access_token: string; scope: string };

      const jwksRes = await server.app.inject({
        method: 'GET',
        url: '/.well-known/jwks.json',
      });
      const jwksBody = jwksRes.json() as { keys: jose.JWK[] };
      const pubKey = await jose.importJWK(jwksBody.keys[0]!, 'RS256');

      const { payload } = await jose.jwtVerify(tokens.access_token, pubKey, {
        issuer: 'http://localhost:8095',
        audience: 'my-api',
      });
      expect(payload.sub).toBe('bob');
      expect(payload.email).toBe('bob@example.com');
      expect((payload as Record<string, unknown>).role).toBe('manager');
      expect(tokens.scope).toContain('openid');
      expect((payload as Record<string, unknown>).scope).toBe('openid profile email');
    } finally {
      await server.close();
    }
  });

  it('discovery document links to all endpoints', async () => {
    const server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/.well-known/openid-configuration',
      });
      expect(res.statusCode).toBe(200);
      const doc = res.json() as Record<string, unknown>;
      expect(doc.authorization_endpoint).toBe('http://localhost:8095/authorize');
      expect(doc.token_endpoint).toBe('http://localhost:8095/token');
      expect(doc.jwks_uri).toBe('http://localhost:8095/.well-known/jwks.json');
    } finally {
      await server.close();
    }
  });
});
