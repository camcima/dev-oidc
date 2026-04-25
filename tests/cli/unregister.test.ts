import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRegister, runUnregister } from '@/cli/hub-commands.js';

describe('unregister', () => {
  it('removes the slug entry', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cli-'));
    const hub = path.join(dir, 'hub.json');
    const proj = mkdtempSync(path.join(tmpdir(), 'dev-oidc-proj-'));
    const cfg = path.join(proj, 'dev-oidc.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        signingKey: { kid: 'k1' },
        clients: [{ clientId: 'a', redirectUris: ['http://localhost/cb'], audience: 'x' }],
        profiles: [],
      }),
    );
    await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });

    const result = await runUnregister({ hubConfigPath: hub, slug: 'app' });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(hub, 'utf8')).tenants).toEqual([]);
  });

  it('exits 1 when slug is unknown', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cli-'));
    const hub = path.join(dir, 'hub.json');
    const result = await runUnregister({ hubConfigPath: hub, slug: 'no-such' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown slug/i);
  });
});
