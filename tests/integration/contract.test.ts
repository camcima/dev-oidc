import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer } from '@/server.js';

const config: Config = {
  issuer: 'http://localhost:8095',
  port: 0,
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
  subjectClaim: 'oid',
  tokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 28800,
  branding: { title: 'Test', accentColor: '#000', logoUrl: null },
  profiles: [
    { id: 'alice', displayName: 'Alice', email: 'alice@example.com', avatar: null, claims: {} },
  ],
};

describe('contract: tokens verify via real HTTP JWKS fetch', () => {
  it('mints an oid-bearing token that verifies against remote JWKS', async () => {
    const server = await createDevOidcServer({ config });
    const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');

      const authResp = await fetch(
        `${baseUrl}/authorize?` +
          new URLSearchParams({
            client_id: 'my-app',
            redirect_uri: 'http://localhost:5173/auth/callback',
            response_type: 'code',
            scope: 'openid',
            state: 's',
            nonce: 'n',
            code_challenge: challenge,
            code_challenge_method: 'S256',
          }).toString(),
      );
      const html = await authResp.text();
      const pendingId = html.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1];

      const completeResp = await fetch(`${baseUrl}/authorize/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `pendingAuthId=${pendingId}&profileId=alice`,
        redirect: 'manual',
      });
      const code = new URL(completeResp.headers.get('location')!).searchParams.get('code')!;

      const tokenResp = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'my-app',
          redirect_uri: 'http://localhost:5173/auth/callback',
        }).toString(),
      });
      const tokens = (await tokenResp.json()) as { access_token: string };

      const jwks = jose.createRemoteJWKSet(new URL(`${baseUrl}/.well-known/jwks.json`));
      const { payload } = await jose.jwtVerify(tokens.access_token, jwks, {
        issuer: 'http://localhost:8095',
        audience: 'my-api',
      });

      expect(payload.oid).toBe('alice');
      expect(payload.sub).toBe('alice');
      expect(payload.email).toBe('alice@example.com');
    } finally {
      await server.close();
    }
  });
});
