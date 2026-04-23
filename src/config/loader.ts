import { readFile } from 'node:fs/promises';
import { ConfigSchema, type Config } from '@/config/schema.js';

export async function loadConfig(filePath: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      throw new Error(`dev-oidc: config file not found at ${filePath}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`dev-oidc: invalid JSON in ${filePath}: ${message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`dev-oidc: config validation failed:\n${result.error.message}`);
  }

  return result.data;
}
