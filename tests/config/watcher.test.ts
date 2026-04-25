import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { watchConfig } from '@/config/watcher.js';

function writeValidConfig(file: string, kid: string): void {
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid },
      clients: [
        {
          clientId: 'my-app',
          redirectUris: ['http://localhost:5173/auth/callback'],
          audience: 'my-api',
        },
      ],
      profiles: [],
    }),
  );
}

describe('watchConfig', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-watch-'));

  it('emits a reload event when the file changes (debounced)', async () => {
    const file = path.join(tmpDir, 'config.json');
    writeValidConfig(file, 'k1');

    const events: string[] = [];
    const watcher = await watchConfig(file, {
      onReload: (config) => events.push(config.signingKey.kid),
      onError: () => {},
      debounceMs: 50,
    });

    writeValidConfig(file, 'k2');

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(events).toContain('k2');
    await watcher.close();
  });

  it('emits an error when the reloaded file is invalid; keeps last-good in memory', async () => {
    const file = path.join(tmpDir, 'config-err.json');
    writeValidConfig(file, 'k1');

    const errors: Error[] = [];
    const reloads: string[] = [];
    const watcher = await watchConfig(file, {
      onReload: (config) => reloads.push(config.signingKey.kid),
      onError: (err) => errors.push(err),
      debounceMs: 50,
    });

    writeFileSync(file, 'not json');
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(reloads).toHaveLength(0);
    await watcher.close();
  });
});
