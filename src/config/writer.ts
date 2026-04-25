import { rename, writeFile } from 'node:fs/promises';
import type { Config } from '@/config/schema.js';

export async function writeConfigFile(filePath: string, config: Config): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const body = JSON.stringify(config, null, 2) + '\n';
  await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, filePath);
}
