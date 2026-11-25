import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config, Profile } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// On-disk shape as a v0.8.0 user would have written it: bob has no
// description, carol has one.
const DISK = {
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
  profiles: [
    { id: 'bob', displayName: 'Bob', email: 'bob@example.com', avatar: null, claims: {} },
    {
      id: 'carol',
      displayName: 'Carol',
      email: 'carol@example.com',
      description: 'Portal admin',
      avatar: null,
      claims: { role: 'admin' },
    },
  ],
};

async function buildApp() {
  const dir = makeTmpDir('dev-oidc-desc-');
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(DISK, null, 2));
  const runtime = createRuntimeConfig(structuredClone(DISK) as Config);
  const app = Fastify();
  const tenant = {
    slug: '(legacy)',
    configPath: file,
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    runtime,
  } as unknown as ActiveTenantState;
  registerProfilesRoutes(app, { getTenant: () => tenant });
  return { app, file };
}

function onDisk(file: string): Profile[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as Config).profiles;
}

function send(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  method: 'POST' | 'PUT',
  url: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

const DAVE = { id: 'dave', displayName: 'Dave', email: 'dave@example.com' };
const CAROL_CORE = { id: 'carol', displayName: 'Carol', email: 'carol@example.com' };

describe('POST /admin/api/profiles with description', () => {
  it('stores a trimmed description', async () => {
    const { app, file } = await buildApp();
    const res = await send(app, 'POST', '/admin/api/profiles', {
      ...DAVE,
      description: '  Team leader  ',
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as Profile).description).toBe('Team leader');
    expect(onDisk(file).find((p) => p.id === 'dave')!.description).toBe('Team leader');
  });

  it.each([
    ['omitted', {}],
    ['null', { description: null }],
    ['empty', { description: '' }],
    ['whitespace-only', { description: '   ' }],
  ])('stores no description key when it is %s', async (_label, extra) => {
    const { app, file } = await buildApp();
    const res = await send(app, 'POST', '/admin/api/profiles', { ...DAVE, ...extra });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json() as object)).not.toContain('description');
    expect(Object.keys(onDisk(file).find((p) => p.id === 'dave')!)).not.toContain('description');
  });

  it('rejects a description over 200 characters with the usual error shape', async () => {
    const { app, file } = await buildApp();
    const before = readFileSync(file, 'utf8');
    const res = await send(app, 'POST', '/admin/api/profiles', {
      ...DAVE,
      description: 'x'.repeat(201),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_input');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('rejects a non-string description', async () => {
    const { app } = await buildApp();
    const res = await send(app, 'POST', '/admin/api/profiles', { ...DAVE, description: 42 });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_input');
  });
});

describe('PUT /admin/api/profiles/:id with description', () => {
  it('keeps the stored description when the body leaves it out', async () => {
    const { app, file } = await buildApp();
    const res = await send(app, 'PUT', '/admin/api/profiles/carol', {
      ...CAROL_CORE,
      displayName: 'Carol R.',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Profile).description).toBe('Portal admin');
    expect(onDisk(file).find((p) => p.id === 'carol')!.description).toBe('Portal admin');
  });

  it('replaces the description with a trimmed string', async () => {
    const { app, file } = await buildApp();
    const res = await send(app, 'PUT', '/admin/api/profiles/carol', {
      ...CAROL_CORE,
      description: '  Line manager ',
    });
    expect(res.statusCode).toBe(200);
    expect(onDisk(file).find((p) => p.id === 'carol')!.description).toBe('Line manager');
  });

  it('adds a description to a profile that had none', async () => {
    const { app, file } = await buildApp();
    const res = await send(app, 'PUT', '/admin/api/profiles/bob', {
      id: 'bob',
      displayName: 'Bob',
      email: 'bob@example.com',
      description: 'Outside LATAM',
    });
    expect(res.statusCode).toBe(200);
    expect(onDisk(file).find((p) => p.id === 'bob')!.description).toBe('Outside LATAM');
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['whitespace-only', '  '],
  ])('removes the description key when the body sends %s', async (_label, description) => {
    const { app, file } = await buildApp();
    const res = await send(app, 'PUT', '/admin/api/profiles/carol', {
      ...CAROL_CORE,
      description,
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json() as object)).not.toContain('description');
    const carol = onDisk(file).find((p) => p.id === 'carol')!;
    expect(Object.keys(carol)).not.toContain('description');
    expect(carol.claims).toEqual({ role: 'admin' });
  });

  it('rejects a description over 200 characters and leaves the file alone', async () => {
    const { app, file } = await buildApp();
    const before = readFileSync(file, 'utf8');
    const res = await send(app, 'PUT', '/admin/api/profiles/carol', {
      ...CAROL_CORE,
      description: 'x'.repeat(201),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_input');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not add a description key to profiles that have none, nor reorder them', async () => {
    const { app, file } = await buildApp();
    const res = await send(app, 'PUT', '/admin/api/profiles/carol', {
      ...CAROL_CORE,
      description: 'Changed',
    });
    expect(res.statusCode).toBe(200);
    const raw = readFileSync(file, 'utf8');
    const bob = onDisk(file).find((p) => p.id === 'bob')!;
    expect(Object.keys(bob)).toEqual(['id', 'displayName', 'email', 'avatar', 'claims']);
    // bob's block is written exactly as it would have been before this feature.
    const bobBlock = JSON.stringify(DISK.profiles[0], null, 2)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    expect(raw).toContain(`[\n${bobBlock},\n`);
  });
});
