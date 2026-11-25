import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '@/config/schema.js';

describe('examples/config.json', () => {
  it('loads and validates, showing one profile description', async () => {
    const path = fileURLToPath(new URL('../../examples/config.json', import.meta.url));
    const parsed = ConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    expect(parsed.profiles.filter((p) => p.description !== undefined)).toHaveLength(1);
  });
});
