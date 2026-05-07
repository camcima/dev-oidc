import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRegister, runUnregister } from '@/cli/hub-commands.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

describe('unregister', () => {
  it('removes the slug entry', async () => {
    const dir = makeTmpDir('dev-oidc-cli-');
    const hub = path.join(dir, 'hub.json');
    const proj = makeTmpDir('dev-oidc-proj-');
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
    const dir = makeTmpDir('dev-oidc-cli-');
    const hub = path.join(dir, 'hub.json');
    const result = await runUnregister({ hubConfigPath: hub, slug: 'no-such' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown slug/i);
  });

  it('rejects malformed slug shape with exitCode=1', async () => {
    const dir = makeTmpDir('dev-oidc-cli-');
    const hub = path.join(dir, 'hub.json');
    const result = await runUnregister({ hubConfigPath: hub, slug: '../foo' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/invalid slug shape/i);
    // The malformed input must NOT be echoed back unsanitized.
    expect(result.stderr).not.toContain('../foo');
  });

  it('returns exitCode=2 when the hub config file is malformed', async () => {
    const dir = makeTmpDir('dev-oidc-cli-bad-');
    const hub = path.join(dir, 'hub.json');
    writeFileSync(hub, '{not valid json');
    const result = await runUnregister({ hubConfigPath: hub, slug: 'app' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/failed to update hub config/i);
  });
});
