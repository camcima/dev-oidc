import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTenantRegistry } from '@/hub/registry.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

function writeConfig(file: string, clientId: string): void {
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
      clients: [{ clientId, redirectUris: ['http://localhost/cb'], audience: 'a' }],
      profiles: [],
    }),
  );
}

describe('registry lifecycle events', () => {
  it('emits added only for a genuinely new slug', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = makeTmpDir('dev-oidc-status-');
    const first = path.join(dir, 'a.json');
    const second = path.join(dir, 'b.json');
    writeConfig(first, 'app-a');
    writeConfig(second, 'app-b');

    const added: string[] = [];
    const statuses: string[] = [];
    reg.events.on('added', ({ slug }) => added.push(slug));
    reg.events.on('statusChanged', ({ slug, status }) => statuses.push(`${slug}:${status}`));

    await reg.add({ slug: 'app', configPath: first, enabled: true });
    expect(added).toEqual(['app']);

    // Re-pointing an existing slug is a replacement, not a fresh mount.
    await reg.add({ slug: 'app', configPath: second, enabled: true });
    expect(added).toEqual(['app']);

    // ...but it must still announce itself, or the dashboard never refreshes.
    expect(statuses).toEqual(['app:active', 'app:active']);

    await reg.closeAll();
  });

  it('reports a status change when a tenant fails to activate', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = makeTmpDir('dev-oidc-status-err-');
    const broken = path.join(dir, 'broken.json');
    writeFileSync(broken, 'not json');

    const statuses: string[] = [];
    reg.events.on('statusChanged', ({ slug, status }) => statuses.push(`${slug}:${status}`));

    await reg.add({ slug: 'app', configPath: broken, enabled: true });
    expect(statuses).toEqual(['app:error']);

    await reg.closeAll();
  });
});
