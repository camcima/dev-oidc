import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import { createHubServer } from '@/hub/server.js';

function pkce() {
  const v = randomBytes(32).toString('base64url');
  const c = createHash('sha256').update(v).digest('base64url');
  return { v, c };
}

function projectConfig(opts: { kid: string }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-iso-'));
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: opts.kid, alg: 'RS256', source: 'generate' },
      clients: [
        { clientId: 'my-app', redirectUris: ['http://localhost:5173/cb'], audience: 'my-api' },
      ],
      profiles: [{ id: 'u', displayName: 'User', email: 'u@example.com' }],
    }),
  );
  return file;
}

function hubConfig(tenants: Array<{ slug: string; configPath: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-iso-hub-'));
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

async function getCode(
  server: Awaited<ReturnType<typeof createHubServer>>,
  slug: string,
  challenge: string,
): Promise<string> {
  const auth = await server.app.inject({
    method: 'GET',
    url:
      `/${slug}/authorize?` +
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
  const pendingId = auth.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1];
  const complete = await server.app.inject({
    method: 'POST',
    url: `/${slug}/authorize/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pendingAuthId=${pendingId}&profileId=u`,
  });
  return new URL(complete.headers.location as string).searchParams.get('code')!;
}

describe('integration: cross-tenant isolation', () => {
  it('rejects a tenant A code presented to tenant B /token', async () => {
    const cfgA = projectConfig({ kid: 'kA' });
    const cfgB = projectConfig({ kid: 'kB' });
    const hub = hubConfig([
      { slug: 'a', configPath: cfgA },
      { slug: 'b', configPath: cfgB },
    ]);
    const server = await createHubServer({ hubConfigPath: hub });
    try {
      const { v, c } = pkce();
      const codeA = await getCode(server, 'a', c);

      const tokenAtB = await server.app.inject({
        method: 'POST',
        url: '/b/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code: codeA,
          code_verifier: v,
          client_id: 'my-app',
          redirect_uri: 'http://localhost:5173/cb',
        }).toString(),
      });
      expect(tokenAtB.statusCode).toBe(400);
      const body = tokenAtB.json() as { error: string };
      expect(body.error).toBe('invalid_grant');
    } finally {
      await server.close();
    }
  });

  it("tenant A's JWKS does not contain tenant B's signing key", async () => {
    const cfgA = projectConfig({ kid: 'kA' });
    const cfgB = projectConfig({ kid: 'kB' });
    const hub = hubConfig([
      { slug: 'a', configPath: cfgA },
      { slug: 'b', configPath: cfgB },
    ]);
    const server = await createHubServer({ hubConfigPath: hub });
    try {
      const a = await server.app.inject({ method: 'GET', url: '/a/.well-known/jwks.json' });
      const b = await server.app.inject({ method: 'GET', url: '/b/.well-known/jwks.json' });
      const aBody = a.json() as { keys: jose.JWK[] };
      const bBody = b.json() as { keys: jose.JWK[] };
      expect(aBody.keys[0]!.kid).toBe('kA');
      expect(bBody.keys[0]!.kid).toBe('kB');
      expect(aBody.keys[0]!.kid).not.toBe(bBody.keys[0]!.kid);
    } finally {
      await server.close();
    }
  });

  it("token issued by A does not verify against B's JWKS", async () => {
    const cfgA = projectConfig({ kid: 'kA' });
    const cfgB = projectConfig({ kid: 'kB' });
    const hub = hubConfig([
      { slug: 'a', configPath: cfgA },
      { slug: 'b', configPath: cfgB },
    ]);
    const server = await createHubServer({ hubConfigPath: hub });
    try {
      const { v, c } = pkce();
      const codeA = await getCode(server, 'a', c);
      const tokenRes = await server.app.inject({
        method: 'POST',
        url: '/a/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code: codeA,
          code_verifier: v,
          client_id: 'my-app',
          redirect_uri: 'http://localhost:5173/cb',
        }).toString(),
      });
      const { access_token } = tokenRes.json() as { access_token: string };

      const jwksB = await server.app.inject({ method: 'GET', url: '/b/.well-known/jwks.json' });
      const bKeys = (jwksB.json() as { keys: jose.JWK[] }).keys;
      const pubB = await jose.importJWK(bKeys[0]!, 'RS256');

      await expect(jose.jwtVerify(access_token, pubB)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
