import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHubServer } from '@/hub/server.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// Hub mode builds its CORS allowlist by walking every active tenant's config,
// a different code path from the single-config legacy server. Without this the
// hub delegate had no coverage at all: a mistake here would either lock out
// legitimate relying parties or reopen the reflect-any-origin hole.
function projectConfig(redirectUri: string): string {
  const dir = makeTmpDir('dev-oidc-hub-cors-');
  const cfg = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [{ clientId: 'app', redirectUris: [redirectUri], audience: 'a' }],
      profiles: [],
    }),
  );
  return cfg;
}

function hubFor(tenants: Array<{ slug: string; configPath: string }>): string {
  const dir = makeTmpDir('dev-oidc-hub-cors-cfg-');
  const hub = path.join(dir, 'hub.json');
  writeFileSync(
    hub,
    JSON.stringify({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
      tenants: tenants.map((t) => ({ ...t, enabled: true })),
    }),
  );
  return hub;
}

async function allowOrigin(hubPath: string, origin: string): Promise<string | undefined> {
  const server = await createHubServer({ hubConfigPath: hubPath });
  try {
    const res = await server.app.inject({
      method: 'GET',
      url: '/app/.well-known/openid-configuration',
      headers: { origin },
    });
    expect(res.statusCode).toBe(200);
    return res.headers['access-control-allow-origin'] as string | undefined;
  } finally {
    await server.close();
  }
}

describe('integration: hub CORS', () => {
  it('allows an origin registered by one of its tenants', async () => {
    const hub = hubFor([
      { slug: 'app', configPath: projectConfig('http://team-app.test:4000/cb') },
    ]);
    expect(await allowOrigin(hub, 'http://team-app.test:4000')).toBe('http://team-app.test:4000');
  });

  it('allows any loopback origin', async () => {
    const hub = hubFor([{ slug: 'app', configPath: projectConfig('http://localhost/cb') }]);
    expect(await allowOrigin(hub, 'http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('refuses an unrelated public origin', async () => {
    const hub = hubFor([{ slug: 'app', configPath: projectConfig('http://localhost/cb') }]);
    expect(await allowOrigin(hub, 'https://evil.example')).toBeUndefined();
  });

  it('does not leak one tenant origin allowance into a refusal for others', async () => {
    // Two tenants: each one's registered origin is allowed, an unrelated one is not.
    const hub = hubFor([
      { slug: 'app', configPath: projectConfig('http://a.test:3000/cb') },
      { slug: 'other', configPath: projectConfig('http://b.test:3000/cb') },
    ]);
    expect(await allowOrigin(hub, 'http://a.test:3000')).toBe('http://a.test:3000');
    expect(await allowOrigin(hub, 'http://b.test:3000')).toBe('http://b.test:3000');
    expect(await allowOrigin(hub, 'http://c.test:3000')).toBeUndefined();
  });
});
