import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCodeStore } from '@/oidc/codes.js';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer } from '@/server.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('CodeStore reads the refresh TTL at issue time', () => {
  it('applies the current TTL to each token rather than the TTL captured at construction', async () => {
    let ttlMs = 20;
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: () => ttlMs });

    const shortLived = store.issueRefresh({ clientId: 'c', profileId: 'p', scope: 'openid' });
    ttlMs = 60_000;
    const longLived = store.issueRefresh({ clientId: 'c', profileId: 'p', scope: 'openid' });

    await sleep(60);

    expect(store.consumeRefresh(shortLived)).toBeNull();
    expect(store.consumeRefresh(longLived)).not.toBeNull();
  });

  it('still accepts a plain number for the TTL', async () => {
    const store = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 20 });
    const token = store.issueRefresh({ clientId: 'c', profileId: 'p', scope: 'openid' });
    await sleep(60);
    expect(store.consumeRefresh(token)).toBeNull();
  });
});

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function config(refreshTokenTtlSeconds: number): Config {
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
    refreshTokenTtlSeconds,
    branding: { title: 'T', accentColor: '#000', logoUrl: null },
    profiles: [{ id: 'bob', displayName: 'Bob', email: 'b@example.com', avatar: null, claims: {} }],
  };
}

async function mintRefreshToken(server: Awaited<ReturnType<typeof createDevOidcServer>>) {
  const { verifier, challenge } = pkcePair();
  const authRes = await server.app.inject({
    method: 'GET',
    url:
      '/authorize?' +
      new URLSearchParams({
        client_id: 'my-app',
        redirect_uri: 'http://localhost:5173/cb',
        response_type: 'code',
        scope: 'openid',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
  });
  const pendingId = authRes.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1]!;
  const completeRes = await server.app.inject({
    method: 'POST',
    url: '/authorize/complete',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pendingAuthId=${pendingId}&profileId=bob`,
  });
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
      redirect_uri: 'http://localhost:5173/cb',
    }).toString(),
  });
  return (tokenRes.json() as { refresh_token: string }).refresh_token;
}

describe('a hot-reloaded refreshTokenTtlSeconds takes effect', () => {
  it('honors the reloaded TTL for tokens issued after the change', async () => {
    // Boot with a 1-second refresh TTL, then raise it the way a config edit
    // would. A token minted after the edit must outlive the original TTL.
    const server = await createDevOidcServer({
      config: config(1),
      issuer: 'http://localhost:8095',
    });
    try {
      server.tenant.runtime.set(config(3600));
      const refreshToken = await mintRefreshToken(server);

      await sleep(1200);

      const res = await server.app.inject({
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
    } finally {
      await server.close();
    }
  });
});
