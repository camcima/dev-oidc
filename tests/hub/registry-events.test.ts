import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTenantRegistry } from '@/hub/registry.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

function writeConfig(file: string, profiles: { id: string; name: string }[]): void {
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
      clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
      profiles: profiles.map((p) => ({
        id: p.id,
        displayName: p.name,
        email: `${p.id}@example.com`,
      })),
    }),
  );
}

describe('tenant config reload emits exactly one profilesChanged', () => {
  it('does not double-fire when a watched config changes on disk', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = makeTmpDir('dev-oidc-emit-');
    const cfgPath = path.join(dir, 'dev-oidc.config.json');
    writeConfig(cfgPath, [{ id: 'alice', name: 'Alice' }]);

    await reg.add({ slug: 'app', configPath: cfgPath, enabled: true });

    // Count only what the on-disk edit produces, not the activation itself.
    const events: string[] = [];
    reg.events.on('profilesChanged', ({ slug }) => events.push(slug));

    writeConfig(cfgPath, [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(events).toEqual(['app']);
    await reg.closeAll();
  });

  it('stays silent when the rewrite leaves the config content identical', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = makeTmpDir('dev-oidc-emit-same-');
    const cfgPath = path.join(dir, 'dev-oidc.config.json');
    writeConfig(cfgPath, [{ id: 'alice', name: 'Alice' }]);

    await reg.add({ slug: 'app', configPath: cfgPath, enabled: true });

    const events: string[] = [];
    reg.events.on('profilesChanged', ({ slug }) => events.push(slug));

    // Touch the file with byte-identical content: runtime.set() is a no-op,
    // so no consumer should be told anything changed.
    writeConfig(cfgPath, [{ id: 'alice', name: 'Alice' }]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(events).toEqual([]);
    await reg.closeAll();
  });
});
