import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer } from '@/server.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

function seed(file: string): void {
  const config: Config = {
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
  writeFileSync(file, JSON.stringify(config, null, 2));
}

describe('admin integration', () => {
  it('GET /admin serves HTML with the profile table', async () => {
    const dir = makeTmpDir('dev-oidc-admin-int-');
    const file = path.join(dir, 'config.json');
    seed(file);
    const config: Config = JSON.parse(readFileSync(file, 'utf8'));

    const server = await createDevOidcServer({
      config,
      configFilePath: file,
      issuer: 'http://localhost:8095',
    });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.payload).toContain('alice');
    } finally {
      await server.close();
    }
  });

  it('POST /admin/api/profiles updates disk and in-memory state', async () => {
    const dir = makeTmpDir('dev-oidc-admin-int-');
    const file = path.join(dir, 'config.json');
    seed(file);
    const config: Config = JSON.parse(readFileSync(file, 'utf8'));

    const server = await createDevOidcServer({
      config,
      configFilePath: file,
      issuer: 'http://localhost:8095',
    });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/admin/api/profiles',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          id: 'bob',
          displayName: 'Bob',
          email: 'bob@example.com',
          claims: { role: 'manager' },
        }),
      });
      expect(res.statusCode).toBe(201);
      const onDisk: Config = JSON.parse(readFileSync(file, 'utf8'));
      expect(onDisk.profiles.map((p) => p.id)).toEqual(['alice', 'bob']);
      expect(server.tenant.runtime.get().profiles.map((p) => p.id)).toEqual(['alice', 'bob']);
    } finally {
      await server.close();
    }
  });
});
