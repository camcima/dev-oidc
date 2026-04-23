import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeConfigFile } from '@/config/writer.js';
import type { Config } from '@/config/schema.js';

function baseConfig(): Config {
  return {
    issuer: 'http://localhost:8080',
    port: 8080,
    host: '127.0.0.1',
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
    branding: { title: 'Dev OIDC Login', accentColor: '#1f6feb', logoUrl: null },
    profiles: [{ id: 'alice', displayName: 'Alice', email: 'a@x.com', avatar: null, claims: {} }],
  };
}

describe('writeConfigFile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-writer-'));

  it('writes the config atomically (tmp + rename) with 2-space indent', async () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, '{"placeholder":true}');

    await writeConfigFile(file, baseConfig());

    const content = readFileSync(file, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.issuer).toBe('http://localhost:8080');
    expect(content).toContain('\n  "issuer"');
  });

  it('leaves the target file unchanged on error (atomic)', async () => {
    const file = path.join(dir, 'config2.json');
    const original = '{"placeholder":true}';
    writeFileSync(file, original);

    // Force a serialization error by passing a config with a circular ref
    const bad = baseConfig() as unknown as Record<string, unknown>;
    bad.self = bad;

    await expect(writeConfigFile(file, bad as unknown as Config)).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});
