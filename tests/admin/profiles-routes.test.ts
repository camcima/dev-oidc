import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

function buildActiveTenant(overrides: Partial<ActiveTenantState>): ActiveTenantState {
  return {
    slug: '(legacy)',
    configPath: '/dev/null',
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    ...overrides,
  } as ActiveTenantState;
}

function baseConfig(): Config {
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
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'T', accentColor: '#000', logoUrl: null },
    profiles: [{ id: 'alice', displayName: 'Alice', email: 'a@x.com', avatar: null, claims: {} }],
  };
}

async function buildApp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-admin-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(baseConfig(), null, 2));
  const config = baseConfig();
  const runtime = createRuntimeConfig(config);
  const app = Fastify();
  const tenant = buildActiveTenant({ config, runtime, configPath: file });
  registerProfilesRoutes(app, { getTenant: () => tenant });
  return { app, runtime, file };
}

describe('admin profiles routes', () => {
  it('GET /admin/api/config returns the full config', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/api/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Config;
    expect(body.signingKey.kid).toBe('k1');
    await app.close();
  });

  it('GET /admin/api/profiles returns the profiles array', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/api/profiles' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown[];
    expect(body).toHaveLength(1);
  });

  it('POST /admin/api/profiles adds a profile and writes to disk', async () => {
    const { app, file } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/profiles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: 'bob',
        displayName: 'Bob',
        email: 'bob@example.com',
        claims: { role: 'admin' },
      }),
    });
    expect(res.statusCode).toBe(201);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.profiles.map((p: { id: string }) => p.id)).toEqual(['alice', 'bob']);
    await app.close();
  });

  it('POST /admin/api/profiles rejects duplicate id', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/profiles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'alice', displayName: 'X', email: 'x@x.com' }),
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('POST /admin/api/profiles rejects invalid input', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/profiles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: '', displayName: 'X', email: 'not-email' }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PUT /admin/api/profiles/:id updates and writes', async () => {
    const { app, file } = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/api/profiles/alice',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: 'alice',
        displayName: 'Alice Updated',
        email: 'alice@example.com',
        claims: { role: 'auditor' },
      }),
    });
    expect(res.statusCode).toBe(200);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.profiles[0].displayName).toBe('Alice Updated');
    expect(disk.profiles[0].claims.role).toBe('auditor');
    await app.close();
  });

  it('PUT /admin/api/profiles/:id allows renaming when the new id is free', async () => {
    const { app, file } = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/api/profiles/alice',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: 'alice-renamed',
        displayName: 'Alice',
        email: 'alice@example.com',
      }),
    });
    expect(res.statusCode).toBe(200);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.profiles.map((p: { id: string }) => p.id)).toEqual(['alice-renamed']);
    await app.close();
  });

  it('PUT /admin/api/profiles/:id rejects rename that collides with an existing id', async () => {
    const { app, file } = await buildApp();
    // Add a second profile so we have a collision target.
    await app.inject({
      method: 'POST',
      url: '/admin/api/profiles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'bob', displayName: 'Bob', email: 'bob@x.com' }),
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/api/profiles/alice',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: 'bob', // collides with the existing 'bob' profile
        displayName: 'Alice',
        email: 'alice@example.com',
      }),
    });
    expect(res.statusCode).toBe(409);
    // Disk must be unchanged from the post-POST state (alice + bob, both
    // with their original ids).
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.profiles.map((p: { id: string }) => p.id).sort()).toEqual(['alice', 'bob']);
    await app.close();
  });

  it('PUT /admin/api/profiles/:id returns 404 for unknown id', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/api/profiles/ghost',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'ghost', displayName: 'G', email: 'g@x.com' }),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE /admin/api/profiles/:id removes and writes', async () => {
    const { app, file } = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/admin/api/profiles/alice' });
    expect(res.statusCode).toBe(204);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.profiles).toHaveLength(0);
    await app.close();
  });

  it('DELETE /admin/api/profiles/:id returns 404 for unknown id', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/admin/api/profiles/ghost' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
