import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultHubConfigPath,
  loadHubConfig,
  mutateHubConfig,
  saveHubConfig,
} from '@/hub/loader.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

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
    const tmp = makeTmpDir('dev-oidc-hub-');
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
    const tmp = makeTmpDir('dev-oidc-hub-');
    const filePath = path.join(tmp, 'hub.json');

    await loadHubConfig(filePath);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reads an existing valid hub config', async () => {
    const tmp = makeTmpDir('dev-oidc-hub-');
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
    const tmp = makeTmpDir('dev-oidc-hub-');
    const filePath = path.join(tmp, 'hub.json');
    writeFileSync(filePath, 'not json');

    await expect(loadHubConfig(filePath)).rejects.toThrow(/invalid JSON/);
  });

  it('throws when an existing file fails Zod validation', async () => {
    const tmp = makeTmpDir('dev-oidc-hub-');
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
    const tmp = makeTmpDir('dev-oidc-hub-');
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

describe('mutateHubConfig', () => {
  it('applies the mutator and persists the result under the lock', async () => {
    const tmp = makeTmpDir('dev-oidc-mutate-');
    const filePath = path.join(tmp, 'hub.json');
    const next = await mutateHubConfig(filePath, (current) => ({
      ...current,
      tenants: [{ slug: 'a', configPath: '/abs/path/dev-oidc.config.json', enabled: true }],
    }));
    expect(next.tenants).toHaveLength(1);
    const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(persisted.tenants[0].slug).toBe('a');
  });

  it('serializes concurrent mutations against the same file', async () => {
    const tmp = makeTmpDir('dev-oidc-concur-');
    const filePath = path.join(tmp, 'hub.json');
    // Race two register-equivalent edits. Without serialization, one
    // would overwrite the other's tenant; with the lockfile both land.
    await Promise.all([
      mutateHubConfig(filePath, (cur) => ({
        ...cur,
        tenants: [
          ...cur.tenants,
          { slug: 'a', configPath: '/abs/a/dev-oidc.config.json', enabled: true },
        ],
      })),
      mutateHubConfig(filePath, (cur) => ({
        ...cur,
        tenants: [
          ...cur.tenants,
          { slug: 'b', configPath: '/abs/b/dev-oidc.config.json', enabled: true },
        ],
      })),
    ]);
    const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
    const slugs = persisted.tenants.map((t: { slug: string }) => t.slug).sort();
    expect(slugs).toEqual(['a', 'b']);
  });

  it('reclaims a stale lockfile (mtime older than the stale threshold)', async () => {
    const tmp = makeTmpDir('dev-oidc-stale-');
    const filePath = path.join(tmp, 'hub.json');
    const lockPath = `${filePath}.lock`;

    // Plant a stale lock: create the lockfile, then push its mtime back
    // by 60 seconds (well past the 30-second stale threshold).
    closeSync(openSync(lockPath, 'wx', 0o600));
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    // mutateHubConfig should reclaim the stale lock and proceed.
    const next = await mutateHubConfig(filePath, (cur) => ({
      ...cur,
      tenants: [
        ...cur.tenants,
        { slug: 'reclaimed', configPath: '/abs/r/dev-oidc.config.json', enabled: true },
      ],
    }));
    expect(next.tenants[0]!.slug).toBe('reclaimed');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('propagates mutator errors so the caller can map them to user-facing exit codes', async () => {
    const tmp = makeTmpDir('dev-oidc-err-');
    const filePath = path.join(tmp, 'hub.json');
    await expect(
      mutateHubConfig(filePath, () => {
        throw new Error('__sentinel__');
      }),
    ).rejects.toThrow('__sentinel__');
    // The lock must be released even after the mutator throws.
    expect(existsSync(`${filePath}.lock`)).toBe(false);
  });
});
