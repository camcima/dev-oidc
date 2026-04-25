import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/loader.js';

describe('loadConfig', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-'));

  const valid = {
    issuer: 'http://localhost:8095',
    signingKey: { kid: 'k1' },
    clients: [
      {
        clientId: 'my-app',
        redirectUris: ['http://localhost:5173/auth/callback'],
        audience: 'my-api',
      },
    ],
    profiles: [{ id: 'alice', displayName: 'Alice', email: 'alice@example.com' }],
  };

  it('loads a valid config file with defaults merged', async () => {
    const file = path.join(tmpDir, 'valid.json');
    writeFileSync(file, JSON.stringify(valid));

    const config = await loadConfig(file);
    expect(config.issuer).toBe('http://localhost:8095');
    expect(config.port).toBe(8095);
    expect(config.host).toBe('127.0.0.1');
    expect(config.subjectClaim).toBe('sub');
    expect(config.tokenTtlSeconds).toBe(900);
    expect(config.branding.title).toBe('Dev OIDC Login');
  });

  it('throws with a clear message when the file does not exist', async () => {
    await expect(loadConfig(path.join(tmpDir, 'does-not-exist.json'))).rejects.toThrow(
      /config file not found/i,
    );
  });

  it('throws with a clear message when the file is not valid JSON', async () => {
    const file = path.join(tmpDir, 'bad.json');
    writeFileSync(file, 'not json at all {');
    await expect(loadConfig(file)).rejects.toThrow(/invalid json/i);
  });

  it('throws a validation error when the config fails the schema', async () => {
    const file = path.join(tmpDir, 'invalid.json');
    writeFileSync(file, JSON.stringify({ issuer: 'not-a-url' }));
    await expect(loadConfig(file)).rejects.toThrow();
  });
});
