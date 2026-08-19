import net from 'node:net';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startLegacy } from '@/cli/legacy.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// startLegacy is what `dev-oidc start --config` actually runs, but every test
// touching it previously mocked it out, leaving the real boot path — config
// load, issuer derivation, listen — with no coverage at all.

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function projectConfig(): string {
  const dir = makeTmpDir('dev-oidc-startlegacy-');
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [{ clientId: 'app', redirectUris: ['http://localhost:5173/cb'], audience: 'api' }],
      profiles: [{ id: 'alice', displayName: 'Alice', email: 'alice@example.com' }],
    }),
  );
  return file;
}

describe('startLegacy', () => {
  it('boots a listening server whose discovery matches the derived issuer', async () => {
    const port = await freePort();
    const result = await startLegacy({ configPath: projectConfig(), port, host: '127.0.0.1' });
    try {
      expect(result.issuer).toBe(`http://127.0.0.1:${port}`);

      const res = await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as Record<string, string>;
      expect(doc.issuer).toBe(`http://127.0.0.1:${port}`);
      expect(doc.token_endpoint).toBe(`http://127.0.0.1:${port}/token`);
    } finally {
      await result.server.close();
    }
  });

  it('prefers an explicit publicUrl over the listen address for the issuer', async () => {
    const port = await freePort();
    const result = await startLegacy({
      configPath: projectConfig(),
      port,
      host: '127.0.0.1',
      publicUrl: 'https://idp.example.test:8443/',
    });
    try {
      // Trailing slash is stripped so the issuer matches what tokens carry.
      expect(result.issuer).toBe('https://idp.example.test:8443');
      const res = await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`);
      const doc = (await res.json()) as Record<string, string>;
      expect(doc.issuer).toBe('https://idp.example.test:8443');
    } finally {
      await result.server.close();
    }
  });

  it('serves the tenant admin API, proving the config path was threaded through', async () => {
    const port = await freePort();
    const result = await startLegacy({ configPath: projectConfig(), port, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/api/profiles`, {
        headers: { host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown[]).toHaveLength(1);
    } finally {
      await result.server.close();
    }
  });

  it('refuses to bind all interfaces without a publicUrl', async () => {
    const port = await freePort();
    await expect(
      startLegacy({ configPath: projectConfig(), port, host: '0.0.0.0' }),
    ).rejects.toThrow(/publicUrl/);
  });

  it('surfaces a config-load failure instead of starting', async () => {
    const dir = makeTmpDir('dev-oidc-startlegacy-bad-');
    const bad = path.join(dir, 'dev-oidc.config.json');
    writeFileSync(bad, '{ not json');
    const port = await freePort();
    await expect(startLegacy({ configPath: bad, port, host: '127.0.0.1' })).rejects.toThrow(
      /invalid JSON/,
    );
  });
});

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/tls');

describe('startLegacy with BYO TLS', () => {
  it('serves HTTPS from the supplied cert/key and advertises an https issuer', async () => {
    const port = await freePort();
    const result = await startLegacy({
      configPath: projectConfig(),
      port,
      host: '127.0.0.1',
      tls: {
        mode: 'byo',
        cert: path.join(fixtureDir, 'cert.pem'),
        key: path.join(fixtureDir, 'key.pem'),
      },
    });
    try {
      // TLS flips the derived issuer's scheme; getting this wrong breaks
      // token verification with an issuer mismatch.
      expect(result.issuer).toBe(`https://127.0.0.1:${port}`);

      // The same port also speaks plain HTTP and redirects it upward.
      const res = await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(308);
      expect(res.headers.get('location')).toBe(`https://127.0.0.1:${port}/.well-known/jwks.json`);
    } finally {
      await result.server.close();
    }
  });

  it('resolves relative BYO cert paths against the working directory', async () => {
    const port = await freePort();
    const cwd = process.cwd();
    const rel = (abs: string): string => path.relative(cwd, abs);
    const result = await startLegacy({
      configPath: projectConfig(),
      port,
      host: '127.0.0.1',
      tls: {
        mode: 'byo',
        cert: rel(path.join(fixtureDir, 'cert.pem')),
        key: rel(path.join(fixtureDir, 'key.pem')),
      },
    });
    try {
      expect(result.issuer).toBe(`https://127.0.0.1:${port}`);
    } finally {
      await result.server.close();
    }
  });

  it('fails with a clear TLS error when the cert file is missing', async () => {
    const port = await freePort();
    await expect(
      startLegacy({
        configPath: projectConfig(),
        port,
        host: '127.0.0.1',
        tls: { mode: 'byo', cert: '/nonexistent/cert.pem', key: '/nonexistent/key.pem' },
      }),
    ).rejects.toThrow(/cannot read TLS cert/);
  });
});
