import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHubServer } from '@/hub/server.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

function projectConfig(): string {
  const dir = makeTmpDir('dev-oidc-hub-admin-');
  const cfg = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
      profiles: [
        { id: 'u1', displayName: 'U1', email: 'u1@example.com' },
        { id: 'u2', displayName: 'U2', email: 'u2@example.com' },
      ],
    }),
  );
  return cfg;
}

function hubFor(tenants: Array<{ slug: string; configPath: string }>): string {
  const dir = makeTmpDir('dev-oidc-hub-admin-cfg-');
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

describe('integration: hub admin', () => {
  it('GET /admin renders the dashboard', async () => {
    const cfg = projectConfig();
    const server = await createHubServer({
      hubConfigPath: hubFor([{ slug: 'app', configPath: cfg }]),
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.payload).toContain('dev-oidc — Hub');
      expect(res.payload).toContain('app');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/api/tenants returns the tenant summary', async () => {
    const cfg = projectConfig();
    const server = await createHubServer({
      hubConfigPath: hubFor([{ slug: 'app', configPath: cfg }]),
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/api/tenants' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ slug: string; status: string; profileCount: number }>;
      expect(body).toHaveLength(1);
      expect(body[0]!.slug).toBe('app');
      expect(body[0]!.status).toBe('active');
      expect(body[0]!.profileCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/:slug renders the per-tenant page', async () => {
    const cfg = projectConfig();
    const server = await createHubServer({
      hubConfigPath: hubFor([{ slug: 'app', configPath: cfg }]),
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/app' });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('U1');
      expect(res.payload).toContain('U2');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/api/:slug/profiles returns profiles', async () => {
    const cfg = projectConfig();
    const server = await createHubServer({
      hubConfigPath: hubFor([{ slug: 'app', configPath: cfg }]),
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/api/app/profiles' });
      expect(res.statusCode).toBe(200);
      const profiles = res.json() as Array<{ id: string }>;
      expect(profiles.map((p) => p.id)).toEqual(['u1', 'u2']);
    } finally {
      await server.close();
    }
  });

  it('returns 404 for /admin/:unknown-slug', async () => {
    const server = await createHubServer({ hubConfigPath: hubFor([]) });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/no-such' });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
