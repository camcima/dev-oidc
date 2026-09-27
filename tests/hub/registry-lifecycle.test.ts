import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTenantRegistry } from '@/hub/registry.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// Activation awaits config loading, key generation and watcher startup. A
// newer reconcile (or shutdown) that ran meanwhile saw no tenant to remove,
// and the older activation then mounted a tenant the newer state had dropped.

function projectConfig(): string {
  const dir = makeTmpDir('dev-oidc-lifecycle-');
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
    }),
  );
  return file;
}

describe('TenantRegistry lifecycle ordering', () => {
  it('a later reconcile wins over an earlier one still activating', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const entry = { slug: 'app', configPath: projectConfig(), enabled: true };
    const adding = reg.reconcile([entry]);
    await reg.reconcile([]);
    await adding;
    expect(reg.list()).toEqual([]);
    await reg.closeAll();
  });

  it('a later disable wins over an earlier enable still activating', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const entry = { slug: 'app', configPath: projectConfig(), enabled: true };
    const adding = reg.reconcile([entry]);
    await reg.reconcile([{ ...entry, enabled: false }]);
    await adding;
    expect(reg.get('app')).toBeUndefined();
    await reg.closeAll();
  });

  it('closeAll leaves nothing mounted when an activation is pending', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const entry = { slug: 'app', configPath: projectConfig(), enabled: true };
    const adding = reg.reconcile([entry]);
    await reg.closeAll();
    await adding;
    expect(reg.list()).toEqual([]);
  });

  it('ignores reconcile after closeAll', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    await reg.closeAll();
    await reg.reconcile([{ slug: 'app', configPath: projectConfig(), enabled: true }]);
    expect(reg.list()).toEqual([]);
  });

  it('a failed reconcile does not block the next one', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const bad = reg.reconcile(null as unknown as []);
    await expect(bad).rejects.toThrow();
    await reg.reconcile([{ slug: 'app', configPath: projectConfig(), enabled: true }]);
    expect(reg.get('app')?.status).toBe('active');
    await reg.closeAll();
  });
});
