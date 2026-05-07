import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { watchHubConfig } from '@/hub/watcher.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('watchHubConfig', () => {
  it('triggers onReload when the file changes', async () => {
    const tmp = makeTmpDir('dev-oidc-hubw-');
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(
      filePath,
      JSON.stringify({ version: '1', server: { port: 8095, host: '127.0.0.1' }, tenants: [] }),
    );

    const reloads: number[] = [];
    const watcher = await watchHubConfig(filePath, {
      debounceMs: 50,
      onReload: (cfg) => reloads.push(cfg.tenants.length),
      onError: () => {},
    });

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          version: '1',
          server: { port: 8095, host: '127.0.0.1' },
          tenants: [{ slug: 'app', configPath: '/tmp/c.json', enabled: true }],
        }),
      );
      await sleep(300);
      expect(reloads.at(-1)).toBe(1);
    } finally {
      await watcher.close();
    }
  });

  it('reports error on invalid JSON without crashing', async () => {
    const tmp = makeTmpDir('dev-oidc-hubw-');
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(
      filePath,
      JSON.stringify({ version: '1', server: { port: 8095, host: '127.0.0.1' }, tenants: [] }),
    );

    const errors: Error[] = [];
    const watcher = await watchHubConfig(filePath, {
      debounceMs: 50,
      onReload: () => {},
      onError: (err) => errors.push(err),
    });

    try {
      await writeFile(filePath, 'not json');
      await sleep(300);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await watcher.close();
    }
  });
});
