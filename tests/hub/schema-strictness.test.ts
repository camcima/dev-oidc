import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HubConfigSchema } from '@/hub/schema.js';
import { loadHubConfig, mutateHubConfig } from '@/hub/loader.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

describe('hub config rejects typos instead of silently dropping them', () => {
  it('rejects an unknown top-level key', () => {
    const result = HubConfigSchema.safeParse({
      version: '1',
      server: { port: 8095, host: '127.0.0.1' },
      tenants: [],
      tenatns: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a misspelled server key rather than ignoring it', () => {
    const result = HubConfigSchema.safeParse({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', pubicUrl: 'http://localhost:8095' },
      tenants: [],
    });
    expect(result.success).toBe(false);
  });

  it('still accepts "//" comment keys, which the shipped example relies on', () => {
    const result = HubConfigSchema.safeParse({
      version: '1',
      '//': 'a note about this file',
      server: { port: 8095, host: '127.0.0.1', '//tls': 'uncomment to enable' },
      tenants: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('hub config comments survive a register/unregister round trip', () => {
  it('preserves "//" keys when the CLI rewrites the file', async () => {
    const dir = makeTmpDir('dev-oidc-hubcomment-');
    const file = path.join(dir, 'hub.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          version: '1',
          '//': 'top level note',
          server: { port: 8095, host: '127.0.0.1', '//tls': 'uncomment to enable' },
          tenants: [],
        },
        null,
        2,
      ),
    );

    await mutateHubConfig(file, (hub) => ({
      ...hub,
      tenants: [{ slug: 'app', configPath: '/tmp/app/dev-oidc.config.json', enabled: true }],
    }));

    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved['//']).toBe('top level note');
    expect((saved.server as Record<string, unknown>)['//tls']).toBe('uncomment to enable');
    expect(await loadHubConfig(file)).toBeDefined();
  });
});
