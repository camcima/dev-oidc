import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// The runtime config lags the file by the watcher's stability wait and
// debounce. Admin mutations used to write the runtime snapshot back to disk,
// silently reverting any edit made in that window. They must build on the
// file as it is when the mutation runs.

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

function setup() {
  const dir = makeTmpDir('dev-oidc-admin-disk-');
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(baseConfig(), null, 2));
  const runtime = createRuntimeConfig(baseConfig());
  const tenant = {
    slug: '(legacy)',
    configPath: file,
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    runtime,
  } as unknown as ActiveTenantState;
  const app = Fastify();
  registerProfilesRoutes(app, { getTenant: () => tenant });
  // An edit the watcher has not published yet.
  const editOnDisk = (edit: (c: Config) => Config): void =>
    writeFileSync(file, JSON.stringify(edit(baseConfig()), null, 2));
  const disk = (): Config => JSON.parse(readFileSync(file, 'utf8')) as Config;
  return { app, runtime, file, editOnDisk, disk };
}

const bob = { id: 'bob', displayName: 'Bob', email: 'b@x.com' };

describe('admin profile mutations build on the file, not the runtime snapshot', () => {
  it('POST preserves an unrelated disk edit and publishes it to runtime', async () => {
    const { app, runtime, editOnDisk, disk } = setup();
    editOnDisk((c) => ({ ...c, tokenTtlSeconds: 123 }));
    const res = await app.inject({ method: 'POST', url: '/admin/api/profiles', payload: bob });
    expect(res.statusCode).toBe(201);
    expect(disk().tokenTtlSeconds).toBe(123);
    expect(disk().profiles.map((p) => p.id)).toEqual(['alice', 'bob']);
    expect(runtime.get().tokenTtlSeconds).toBe(123);
    await app.close();
  });

  it('PUT preserves an unrelated disk edit', async () => {
    const { app, editOnDisk, disk } = setup();
    editOnDisk((c) => ({ ...c, branding: { ...c.branding, title: 'Edited' } }));
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/api/profiles/alice',
      payload: { id: 'alice', displayName: 'Alice 2', email: 'a@x.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(disk().branding.title).toBe('Edited');
    expect(disk().profiles[0]!.displayName).toBe('Alice 2');
    await app.close();
  });

  it('DELETE preserves an unrelated disk edit', async () => {
    const { app, editOnDisk, disk } = setup();
    editOnDisk((c) => ({ ...c, profiles: [...c.profiles, { ...bob, avatar: null, claims: {} }] }));
    const res = await app.inject({ method: 'DELETE', url: '/admin/api/profiles/alice' });
    expect(res.statusCode).toBe(204);
    expect(disk().profiles.map((p) => p.id)).toEqual(['bob']);
    await app.close();
  });

  it('sees a profile added on disk when checking for duplicates', async () => {
    const { app, editOnDisk } = setup();
    editOnDisk((c) => ({ ...c, profiles: [...c.profiles, { ...bob, avatar: null, claims: {} }] }));
    const res = await app.inject({ method: 'POST', url: '/admin/api/profiles', payload: bob });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('refuses to overwrite an invalid file and leaves it untouched', async () => {
    const { app, file } = setup();
    writeFileSync(file, '{ "half-edited": ');
    const res = await app.inject({ method: 'POST', url: '/admin/api/profiles', payload: bob });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('config_invalid');
    expect(readFileSync(file, 'utf8')).toBe('{ "half-edited": ');
    await app.close();
  });
});
