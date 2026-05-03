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

  it('derives an https:// issuer when server.tls is set and server.publicUrl is omitted', async () => {
    const cfg = tmpProjectConfig();
    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'tls');
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-tls-'));
    const hubCfg = path.join(dir, 'hub.json');
    writeFileSync(
      hubCfg,
      JSON.stringify({
        version: '1',
        // No publicUrl — the test asserts the default scheme follows tls.
        server: {
          port: 8095,
          host: '127.0.0.1',
          tls: {
            cert: path.join(fixturesDir, 'cert.pem'),
            key: path.join(fixturesDir, 'key.pem'),
          },
        },
        tenants: [{ slug: 'app', configPath: cfg, enabled: true }],
      }),
    );
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      // app.inject() goes through the onRequest redirect hook (plain "HTTP"
      // socket), so we can't hit /.well-known/discovery directly. Assert on
      // the tenant registry's resolved issuer instead — that's what the
      // discovery doc would render.
      const tenant = server.registry.get('app');
      expect(tenant?.status).toBe('active');
      if (tenant?.status === 'active') {
        expect(tenant.issuer).toBe('https://127.0.0.1:8095/app');
      }
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

  it('serves a landing page at / listing registered tenants', async () => {
    const cfg = tmpProjectConfig();
    const hubCfg = tmpHubConfig([{ slug: 'my-app', configPath: cfg }]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      // Tenant slug, public URL, and discovery link are all present.
      expect(res.payload).toContain('my-app');
      expect(res.payload).toContain('http://localhost:8095');
      expect(res.payload).toContain('/.well-known/openid-configuration');
    } finally {
      await server.close();
    }
  });

  it('serves an empty-state landing page when no tenants are registered', async () => {
    const hubCfg = tmpHubConfig([]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('(none)');
      // The "register" hint is shown so the user knows what to do next.
      expect(res.payload).toContain('dev-oidc register');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/<slug> returns 503 HTML for an error-state tenant', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const badCfg = path.join(dir, 'bad.json');
    writeFileSync(badCfg, 'not json');
    const hubCfg = tmpHubConfig([{ slug: 'broken', configPath: badCfg }]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/broken' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.payload).toContain('Tenant "broken" error');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/<slug> returns 404 for an unknown slug', async () => {
    const hubCfg = tmpHubConfig([]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/no-such' });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/<slug> renders the profile CRUD page for an active tenant', async () => {
    const cfg = tmpProjectConfig();
    const hubCfg = tmpHubConfig([{ slug: 'app', configPath: cfg }]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/app' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      // The page is the existing profile CRUD UI parameterised by slug —
      // its title carries the slug so the user knows which tenant they're editing.
      expect(res.payload).toMatch(/app/);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/api/tenants serializes both active and error tenants', async () => {
    // Drives the dashboard JSON endpoint (and the dashboard HTML render
    // path) covering both branches of the tenant.map: active tenants
    // expose issuer + profileCount; error tenants expose lastError. The
    // dashboard polls this endpoint, so its shape is part of the wire
    // contract.
    const goodCfg = tmpProjectConfig();
    const badDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-mixed-bad-'));
    const badCfg = path.join(badDir, 'bad.json');
    writeFileSync(badCfg, 'not json');
    const hubCfg = tmpHubConfig([
      { slug: 'good', configPath: goodCfg },
      { slug: 'broken', configPath: badCfg },
    ]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/api/tenants' });
      expect(res.statusCode).toBe(200);
      const tenants = res.json() as Array<{
        slug: string;
        status: 'active' | 'error';
        issuer: string | null;
        profileCount: number | null;
        lastError: string | null;
      }>;
      const good = tenants.find((t) => t.slug === 'good')!;
      expect(good.status).toBe('active');
      expect(good.issuer).toBe('http://localhost:8095/good');
      expect(good.profileCount).toBe(1);
      const broken = tenants.find((t) => t.slug === 'broken')!;
      expect(broken.status).toBe('error');
      expect(broken.issuer).toBeNull();
      expect(broken.lastError).toBeTruthy();

      // And the dashboard HTML renders both rows without throwing.
      const html = await server.app.inject({ method: 'GET', url: '/admin' });
      expect(html.statusCode).toBe(200);
      expect(html.payload).toContain('good');
      expect(html.payload).toContain('broken');
    } finally {
      await server.close();
    }
  });

  it('rejects reserved slugs at the OIDC pre-handler (defense-in-depth)', async () => {
    // Even if a tenant named "api" or "_internal" somehow ended up in the
    // tenants map (HubConfigSchema rejects it on parse, but be safe), the
    // pre-handler short-circuits to 404 before the resolver consults the
    // map.
    const hubCfg = tmpHubConfig([]);
    const server = await createHubServer({ hubConfigPath: hubCfg });
    try {
      for (const slug of ['admin', 'api', '_internal']) {
        const res = await server.app.inject({
          method: 'GET',
          url: `/${slug}/.well-known/openid-configuration`,
        });
        expect(res.statusCode).toBe(404);
      }
    } finally {
      await server.close();
    }
  });
});
