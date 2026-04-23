import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKeyMaterial } from '@/oidc/keys.js';

describe('createKeyMaterial (generate)', () => {
  it('generates an RS256 keypair when source is "generate"', async () => {
    const km = await createKeyMaterial({ kid: 'k1', alg: 'RS256', source: 'generate' });

    expect(km.kid).toBe('k1');
    expect(km.alg).toBe('RS256');
    expect(km.publicJwk.kid).toBe('k1');
    expect(km.publicJwk.alg).toBe('RS256');
    expect(km.publicJwk.use).toBe('sig');
    expect(km.publicJwk.kty).toBe('RSA');
  });

  it('produces a public JWK without private material', async () => {
    const km = await createKeyMaterial({ kid: 'k1', alg: 'RS256', source: 'generate' });

    expect(km.publicJwk.d).toBeUndefined();
    expect(km.publicJwk.p).toBeUndefined();
    expect(km.publicJwk.q).toBeUndefined();
  });
});

describe('createKeyMaterial (file-backed)', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-keys-'));

  it('generates and persists the key on first call when the file does not exist', async () => {
    const file = path.join(tmpDir, 'new-key.json');
    expect(existsSync(file)).toBe(false);

    const km = await createKeyMaterial({ kid: 'persist-1', alg: 'RS256', source: `file:${file}` });

    expect(km.kid).toBe('persist-1');
    expect(km.publicJwk.kid).toBe('persist-1');
    expect(existsSync(file)).toBe(true);

    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    expect(persisted.kid).toBe('persist-1');
    expect(persisted.privateJwk).toBeDefined();
    expect(persisted.publicJwk).toBeDefined();
    expect(persisted.privateJwk.d).toBeDefined();
    expect(persisted.publicJwk.d).toBeUndefined();
  });

  it('writes the file with restrictive 0600 permissions (owner read/write only)', async () => {
    const file = path.join(tmpDir, 'perms.json');
    await createKeyMaterial({ kid: 'perms-kid', alg: 'RS256', source: `file:${file}` });

    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reuses the persisted key across restarts (same public key on second call)', async () => {
    const file = path.join(tmpDir, 'reuse.json');

    const first = await createKeyMaterial({
      kid: 'reuse-kid',
      alg: 'RS256',
      source: `file:${file}`,
    });
    const second = await createKeyMaterial({
      kid: 'reuse-kid',
      alg: 'RS256',
      source: `file:${file}`,
    });

    expect(second.publicJwk.n).toBe(first.publicJwk.n);
    expect(second.publicJwk.e).toBe(first.publicJwk.e);
    expect(second.publicJwk.kid).toBe('reuse-kid');
  });

  it('creates parent directories if they do not exist', async () => {
    const file = path.join(tmpDir, 'nested', 'dirs', 'key.json');
    await createKeyMaterial({ kid: 'nested-kid', alg: 'RS256', source: `file:${file}` });
    expect(existsSync(file)).toBe(true);
  });

  it('throws when the persisted file has a different kid than configured', async () => {
    const file = path.join(tmpDir, 'kid-mismatch.json');
    await createKeyMaterial({ kid: 'original-kid', alg: 'RS256', source: `file:${file}` });

    await expect(
      createKeyMaterial({ kid: 'different-kid', alg: 'RS256', source: `file:${file}` }),
    ).rejects.toThrow(/has kid "original-kid", but config expects "different-kid"/);
  });
});
