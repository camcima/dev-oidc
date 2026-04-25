import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
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
