import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config, Profile } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// A profile carrying every optional field the schema supports — the shape the
// admin edit dialog historically dropped on save.
function richProfile(): Profile {
  return {
    id: 'alice',
    displayName: 'Alice Developer',
    email: 'alice@example.com',
    avatar: 'https://cdn.example.com/alice.png',
    emailVerified: true,
    givenName: 'Alice',
    familyName: 'Developer',
    locale: 'en',
    hostedDomain: 'example.com',
    claims: { role: 'admin' },
  };
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
    profiles: [richProfile()],
  };
}

async function buildApp() {
  const dir = makeTmpDir('dev-oidc-merge-');
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(baseConfig(), null, 2));
  const runtime = createRuntimeConfig(baseConfig());
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
  return { app, runtime, file };
}

function persisted(file: string): Profile {
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as Config;
  return cfg.profiles[0]!;
}

describe('PUT /admin/api/profiles/:id preserves unsubmitted fields', () => {
  it('keeps every optional field when the body carries only the core three', async () => {
    const { app, file } = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/api/profiles/alice',
      payload: { id: 'alice', displayName: 'Alice Renamed', email: 'alice@example.com' },
    });
    expect(res.statusCode).toBe(200);

    const saved = persisted(file);
    expect(saved.displayName).toBe('Alice Renamed');
    expect(saved.givenName).toBe('Alice');
    expect(saved.familyName).toBe('Developer');
    expect(saved.avatar).toBe('https://cdn.example.com/alice.png');
    expect(saved.locale).toBe('en');
    expect(saved.hostedDomain).toBe('example.com');
    expect(saved.emailVerified).toBe(true);
    expect(saved.claims).toEqual({ role: 'admin' });

    await app.close();
  });

  it('clears an optional field when the body sends null for it', async () => {
    const { app, file } = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/api/profiles/alice',
      payload: {
        id: 'alice',
        displayName: 'Alice Developer',
        email: 'alice@example.com',
        givenName: null,
        hostedDomain: null,
      },
    });
    expect(res.statusCode).toBe(200);

    const saved = persisted(file);
    expect(saved.givenName).toBeUndefined();
    expect(saved.hostedDomain).toBeUndefined();
    // Untouched optional fields survive the same request.
    expect(saved.familyName).toBe('Developer');
    expect(saved.locale).toBe('en');

    await app.close();
  });

  it('still overwrites a field that the body does submit', async () => {
    const { app, file } = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/api/profiles/alice',
      payload: {
        id: 'alice',
        displayName: 'Alice Developer',
        email: 'alice@example.com',
        givenName: 'Alicia',
        claims: { role: 'viewer' },
      },
    });
    expect(res.statusCode).toBe(200);

    const saved = persisted(file);
    expect(saved.givenName).toBe('Alicia');
    expect(saved.claims).toEqual({ role: 'viewer' });

    await app.close();
  });
});
