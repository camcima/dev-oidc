import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRegister } from '@/cli/hub-commands.js';

function newHub(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cli-'));
  return path.join(dir, 'hub.json');
}

function newProject(slugDir = 'my-app'): string {
  const dir = mkdtempSync(path.join(tmpdir(), `dev-oidc-${slugDir}-`));
  // Force the basename to match `slugDir`
  const projectDir = path.join(dir, slugDir);
  // Simplest: write the config directly under `dir`, slug is derived from dir basename
  const cfg = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [
        { clientId: 'my-app', redirectUris: ['http://localhost:5173/cb'], audience: 'my-api' },
      ],
      profiles: [],
    }),
  );
  void projectDir;
  return cfg;
}

describe('register', () => {
  it('appends an entry to hub.json with the explicit slug', async () => {
    const hub = newHub();
    const cfg = newProject();
    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'custom' });

    expect(result.exitCode).toBe(0);
    const persisted = JSON.parse(readFileSync(hub, 'utf8'));
    expect(persisted.tenants).toHaveLength(1);
    expect(persisted.tenants[0].slug).toBe('custom');
    expect(persisted.tenants[0].configPath).toBe(path.resolve(cfg));
  });

  it('derives slug from directory name when --slug is omitted', async () => {
    const hub = newHub();
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-derived-'));
    const projectRoot = path.join(dir, 'my-derived-app');
    mkdirSync(projectRoot);
    const cfg = path.join(projectRoot, 'dev-oidc.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        signingKey: { kid: 'k1' },
        clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
        profiles: [],
      }),
    );

    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg });
    expect(result.exitCode).toBe(0);
    const persisted = JSON.parse(readFileSync(hub, 'utf8'));
    expect(persisted.tenants[0].slug).toBe('my-derived-app');
  });

  it('rejects when slug is already registered', async () => {
    const hub = newHub();
    const cfg = newProject();
    await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });
    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/already registered/);
  });

  it('rejects when project config is invalid', async () => {
    const hub = newHub();
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const cfg = path.join(dir, 'dev-oidc.config.json');
    writeFileSync(cfg, 'not json');

    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/invalid|JSON|validation/i);
  });

  it('rejects a reserved slug', async () => {
    const hub = newHub();
    const cfg = newProject();
    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'admin' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/reserved/i);
  });

  it('rejects when the explicit --slug fails SLUG_REGEX', async () => {
    const hub = newHub();
    const cfg = newProject();
    const result = await runRegister({
      hubConfigPath: hub,
      configPathArg: cfg,
      slug: 'BadSlug-with-uppercase',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/does not match/i);
  });

  it('rejects when no --slug given and the directory yields an empty derivation', async () => {
    // A directory whose basename has no alphanumeric characters reduces
    // to an empty slug after the strip-and-trim pipeline. The CLI must
    // surface that as a clear error rather than register an empty string.
    const hub = newHub();
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-emptyslug-'));
    const projectRoot = path.join(dir, '!!!');
    mkdirSync(projectRoot);
    const cfg = path.join(projectRoot, 'dev-oidc.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        signingKey: { kid: 'k1' },
        clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
        profiles: [],
      }),
    );

    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/could not derive slug/i);
  });

  it('rejects a non-.json file path when it is not a directory', async () => {
    const hub = newHub();
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-noext-'));
    const file = path.join(dir, 'config.yaml');
    writeFileSync(file, '');
    const result = await runRegister({ hubConfigPath: hub, configPathArg: file, slug: 'app' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/must end in .json/i);
  });

  it('returns exitCode=2 when the hub config file is malformed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-cli-bad-'));
    const hub = path.join(dir, 'hub.json');
    writeFileSync(hub, '{not valid json');
    const cfg = newProject();
    const result = await runRegister({ hubConfigPath: hub, configPathArg: cfg, slug: 'app' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/failed to update hub config/i);
  });

  it('accepts a project directory and resolves dev-oidc.config.json inside', async () => {
    const hub = newHub();
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-dirarg-'));
    const projectRoot = path.join(dir, 'pkg-from-dir');
    mkdirSync(projectRoot);
    const cfgPath = path.join(projectRoot, 'dev-oidc.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        signingKey: { kid: 'k1' },
        clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
        profiles: [],
      }),
    );

    // Pass the directory, not the file
    const result = await runRegister({ hubConfigPath: hub, configPathArg: projectRoot });
    expect(result.exitCode).toBe(0);
    const persisted = JSON.parse(readFileSync(hub, 'utf8'));
    expect(persisted.tenants[0].configPath).toBe(cfgPath);
    expect(persisted.tenants[0].slug).toBe('pkg-from-dir');
  });
});
