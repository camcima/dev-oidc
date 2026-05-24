import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '@/config/schema.js';

describe('examples/google.config.json', () => {
  it('loads and validates against the config schema', async () => {
    const path = fileURLToPath(new URL('../../examples/google.config.json', import.meta.url));
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const parsed = ConfigSchema.parse(raw);
    expect(parsed.profiles.length).toBeGreaterThanOrEqual(2);
    expect(parsed.profiles[0]!.hostedDomain).toBeDefined();
    expect(parsed.subjectClaim).toBe('sub');
  });
});
