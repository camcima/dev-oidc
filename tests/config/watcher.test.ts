import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { watchConfig } from '@/config/watcher.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// A reload goes through chokidar's change event, a 50ms awaitWriteFinish
// stability wait and the 50ms debounce. Under full-suite load that chain can
// take well over the 250ms these tests used to sleep, so wait for the outcome
// itself, with a ceiling generous enough for a busy machine.
const WAIT = { timeout: 5_000, interval: 20 };

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
  const tmpDir = makeTmpDir('dev-oidc-watch-');

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

    await vi.waitFor(() => expect(events).toContain('k2'), WAIT);
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

    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1), WAIT);
    expect(reloads).toHaveLength(0);
    await watcher.close();
  });
});
