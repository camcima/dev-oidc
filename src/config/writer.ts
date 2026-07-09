import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import type { Config } from '@/config/schema.js';

export async function writeConfigFile(filePath: string, config: Config): Promise<void> {
  // Unique suffix so concurrent writers never share a temp file.
  const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  const body = JSON.stringify(config, null, 2) + '\n';
  try {
    await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}
