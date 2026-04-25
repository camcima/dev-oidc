import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HubConfigSchema, type HubConfig } from '@/hub/schema.js';

export function defaultHubConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'dev-oidc', 'hub.json');
  return path.join(homedir(), '.config', 'dev-oidc', 'hub.json');
}

const BOOTSTRAP: HubConfig = {
  version: '1',
  server: { port: 8095, host: '127.0.0.1' },
  tenants: [],
};

export async function loadHubConfig(filePath: string): Promise<HubConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      await saveHubConfig(filePath, BOOTSTRAP);
      return BOOTSTRAP;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`dev-oidc: invalid JSON in hub config ${filePath}: ${message}`);
  }

  const result = HubConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`dev-oidc: hub config validation failed:\n${result.error.message}`);
  }
  return result.data;
}

export async function saveHubConfig(filePath: string, config: HubConfig): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, filePath);
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

/**
 * Acquire an exclusive lock on hub.json for the duration of `fn`, then
 * release it. Used to serialize concurrent `dev-oidc register`/`unregister`
 * invocations so a load-modify-save sequence cannot interleave with
 * another writer.
 *
 * Lock implementation: best-effort via `O_CREAT|O_EXCL` lockfile (`hub.json.lock`).
 * Stale locks (mtime older than 30s) are reclaimed automatically — this is
 * a single-user developer tool, not a distributed system.
 */
export async function mutateHubConfig(
  filePath: string,
  fn: (current: HubConfig) => HubConfig | Promise<HubConfig>,
): Promise<HubConfig> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const start = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        const current = await loadHubConfig(filePath);
        const next = await fn(current);
        await saveHubConfig(filePath, next);
        return next;
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // Lock disappeared between EEXIST and stat — retry immediately.
        continue;
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(
          `dev-oidc: timed out waiting for ${lockPath}; another process may be editing the hub config. ` +
            `If you're sure no other process is running, delete the lock file manually.`,
        );
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}
