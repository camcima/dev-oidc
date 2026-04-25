import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import { createHubServer } from '@/hub/server.js';

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function tmpProjectConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
      clients: [
        {
          clientId: 'my-app',
          redirectUris: ['http://localhost:5173/cb'],
          audience: 'my-api',
        },
      ],
      profiles: [{ id: 'bob', displayName: 'Bob', email: 'bob@example.com' }],
    }),
  );
  return file;
}

function tmpHubConfig(tenants: Array<{ slug: string; configPath: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hubcfg-'));
  const file = path.join(dir, 'hub.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
      tenants: tenants.map((t) => ({ ...t, enabled: true })),
    }),
  );
  return file;
}

describe('integration: hub mode auth-code flow', () => {
  it('mints a verifiable token namespaced under the tenant slug', async () => {
    const cfg = tmpProjectConfig();
    const hubCfg = tmpHubConfig([{ slug: 'app', configPath: cfg }]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const { verifier, challenge } = pkcePair();

      const authRes = await server.app.inject({
        method: 'GET',
        url:
          '/app/authorize?' +
          new URLSearchParams({
            client_id: 'my-app',
            redirect_uri: 'http://localhost:5173/cb',
            response_type: 'code',
            scope: 'openid',
            state: 's',
            code_challenge: challenge,
            code_challenge_method: 'S256',
          }).toString(),
      });
      expect(authRes.statusCode).toBe(200);
      const pendingId = authRes.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1];

      const completeRes = await server.app.inject({
        method: 'POST',
        url: '/app/authorize/complete',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `pendingAuthId=${pendingId}&profileId=bob`,
      });
      expect(completeRes.statusCode).toBe(302);
      const code = new URL(completeRes.headers.location as string).searchParams.get('code')!;

      const tokenRes = await server.app.inject({
        method: 'POST',
        url: '/app/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'my-app',
          redirect_uri: 'http://localhost:5173/cb',
        }).toString(),
      });
      expect(tokenRes.statusCode).toBe(200);
      const tokens = tokenRes.json() as { access_token: string };

      const jwksRes = await server.app.inject({ method: 'GET', url: '/app/.well-known/jwks.json' });
      const jwksBody = jwksRes.json() as { keys: jose.JWK[] };
      const pubKey = await jose.importJWK(jwksBody.keys[0]!, 'RS256');

      const { payload } = await jose.jwtVerify(tokens.access_token, pubKey, {
        issuer: 'http://localhost:8095/app',
        audience: 'my-api',
      });
      expect(payload.sub).toBe('bob');
    } finally {
      await server.close();
    }
  });

  it('returns 404 for unknown slug', async () => {
    const hubCfg = tmpHubConfig([]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/no-such-slug/.well-known/openid-configuration',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('returns 503 for an error-state tenant', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const badCfg = path.join(dir, 'bad.json');
    writeFileSync(badCfg, 'not json');
    const hubCfg = tmpHubConfig([{ slug: 'broken', configPath: badCfg }]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/broken/.well-known/openid-configuration',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string };
      expect(body.error).toBe('service_unavailable');
    } finally {
      await server.close();
    }
  });

  it('rejects a malformed slug with 404', async () => {
    const hubCfg = tmpHubConfig([]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/SOME-UPPERCASE/.well-known/openid-configuration',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
