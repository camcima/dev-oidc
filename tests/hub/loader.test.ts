import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultHubConfigPath, loadHubConfig, saveHubConfig } from '@/hub/loader.js';

describe('defaultHubConfigPath', () => {
  it('honors XDG_CONFIG_HOME when set', () => {
    const orig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/custom/xdg';
    try {
      expect(defaultHubConfigPath()).toBe('/custom/xdg/dev-oidc/hub.json');
    } finally {
      if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = orig;
    }
  });

  it('falls back to ~/.config/dev-oidc/hub.json', () => {
    const orig = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(defaultHubConfigPath()).toMatch(/\/\.config\/dev-oidc\/hub\.json$/);
    } finally {
      if (orig !== undefined) process.env.XDG_CONFIG_HOME = orig;
    }
  });
});

describe('loadHubConfig', () => {
  it('auto-creates an empty hub config when the file does not exist', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    expect(existsSync(filePath)).toBe(false);

    const config = await loadHubConfig(filePath);

    expect(existsSync(filePath)).toBe(true);
    expect(config.version).toBe('1');
    expect(config.tenants).toEqual([]);
    expect(config.server.port).toBe(8095);
    expect(config.server.host).toBe('127.0.0.1');
  });

  it('writes the bootstrap with mode 0600', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');

    await loadHubConfig(filePath);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reads an existing valid hub config', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: '1',
        server: { port: 9090, host: '0.0.0.0' },
        tenants: [{ slug: 'app', configPath: '/tmp/c.json', enabled: true }],
      }),
    );

    const config = await loadHubConfig(filePath);
    expect(config.server.port).toBe(9090);
    expect(config.tenants).toHaveLength(1);
    expect(config.tenants[0]!.slug).toBe('app');
  });

  it('throws when an existing file is invalid JSON', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(filePath, 'not json');

    await expect(loadHubConfig(filePath)).rejects.toThrow(/invalid JSON/);
  });

  it('throws when an existing file fails Zod validation', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: '2', // bad version
        server: { port: 8095, host: '127.0.0.1' },
        tenants: [],
      }),
    );

    await expect(loadHubConfig(filePath)).rejects.toThrow(/validation/);
  });
});

describe('saveHubConfig', () => {
  it('atomic-writes the hub config (tmp + rename)', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dev-oidc-hub-'));
    const filePath = path.join(tmp, 'hub.json');
    await loadHubConfig(filePath); // create initial

    const updated = {
      version: '1' as const,
      server: { port: 9000, host: '127.0.0.1' },
      tenants: [],
    };
    await saveHubConfig(filePath, updated);
    const reread = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(reread.server.port).toBe(9000);
  });
});
