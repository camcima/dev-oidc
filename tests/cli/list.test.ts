import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runList } from '@/cli/hub-commands.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

function setupHub(tenants: Array<{ slug: string; configPath: string; enabled: boolean }>): string {
  const dir = makeTmpDir('dev-oidc-list-');
  const hub = path.join(dir, 'hub.json');
  writeFileSync(
    hub,
    JSON.stringify({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
      tenants,
    }),
  );
  return hub;
}

describe('list', () => {
  it('emits a human-friendly table by default', async () => {
    const hub = setupHub([
      { slug: 'a', configPath: '/abs/a.json', enabled: true },
      { slug: 'b', configPath: '/abs/b.json', enabled: false },
    ]);
    const result = await runList({ hubConfigPath: hub });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('a');
    expect(result.stdout).toContain('b');
    expect(result.stdout).toContain('http://localhost:8095/a');
  });

  it('emits raw JSON tenants array with --json', async () => {
    const hub = setupHub([{ slug: 'a', configPath: '/abs/a.json', enabled: true }]);
    const result = await runList({ hubConfigPath: hub, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].slug).toBe('a');
  });

  it('handles empty tenants gracefully', async () => {
    const hub = setupHub([]);
    const result = await runList({ hubConfigPath: hub });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no tenants|^\s*$/i);
  });

  it('returns exitCode=2 when the hub config is malformed', async () => {
    const dir = makeTmpDir('dev-oidc-list-bad-');
    const hub = path.join(dir, 'hub.json');
    writeFileSync(hub, '{not valid json');
    const result = await runList({ hubConfigPath: hub });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/failed to read hub config/i);
  });
});
