import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '@/config/schema.js';
import { createHubServer } from '@/hub/server.js';
import { createDevOidcServer } from '@/server.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// Fastify decodes percent-escapes before routing, so `/%61dmin/...` reaches the
// admin handlers. The guard must protect whatever the router dispatches to
// admin, not only URLs that literally spell `/admin`.

const HOSTILE = {
  host: 'evil.test',
  origin: 'https://evil.test',
  'sec-fetch-site': 'cross-site',
  'content-type': 'application/x-www-form-urlencoded',
};
const FORM = 'id=injected&displayName=Injected&email=injected%40example.test';

function seed(): string {
  const dir = makeTmpDir('dev-oidc-guard-enc-');
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
      profiles: [{ id: 'alice', displayName: 'Alice', email: 'a@example.com' }],
    }),
  );
  return file;
}

function profileIdsOnDisk(file: string): string[] {
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { profiles: Array<{ id: string }> };
  return cfg.profiles.map((p) => p.id);
}

/** Raw HTTP so the percent-encoded path reaches the server byte-for-byte. */
function rawPost(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: 'POST', path: urlPath, headers: HOSTILE },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(FORM);
  });
}

describe('admin guard: percent-encoded admin paths', () => {
  it('legacy mode rejects a hostile encoded POST over real HTTP and leaves the file alone', async () => {
    const file = seed();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const config: Config = ConfigSchema.parse(raw);
    const server = await createDevOidcServer({ config, configFilePath: file });
    try {
      await server.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = server.app.server.address() as AddressInfo;
      expect(await rawPost(port, '/admin/api/profiles')).toBe(403);
      expect(await rawPost(port, '/%61dmin/api/profiles')).toBe(403);
      expect(await rawPost(port, '/adm%69n/api/profiles')).toBe(403);
      expect(profileIdsOnDisk(file)).toEqual(['alice']);
    } finally {
      await server.close();
    }
  });

  it('hub mode rejects hostile encoded reads and writes', async () => {
    const file = seed();
    const hubDir = makeTmpDir('dev-oidc-guard-enc-hub-');
    const hubPath = path.join(hubDir, 'hub.json');
    writeFileSync(
      hubPath,
      JSON.stringify({
        version: '1',
        server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
        tenants: [{ slug: 'app', configPath: file, enabled: true }],
      }),
    );
    const server = await createHubServer({ hubConfigPath: hubPath });
    try {
      const write = await server.app.inject({
        method: 'POST',
        url: '/%61dmin/api/app/profiles',
        headers: HOSTILE,
        payload: FORM,
      });
      expect(write.statusCode).toBe(403);
      const read = await server.app.inject({
        method: 'GET',
        url: '/%61dmin/api/tenants',
        headers: { host: 'evil.test' },
      });
      expect(read.statusCode).toBe(403);
      expect(profileIdsOnDisk(file)).toEqual(['alice']);
    } finally {
      await server.close();
    }
  });
});
