import { readdirSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createKeyMaterial } from '@/oidc/keys.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// Isolated in its own file: the module mock below applies file-wide and would
// break the happy-path persistence tests in keys.test.ts.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      if (String(newPath).endsWith('boom.json')) {
        throw new Error('simulated rename failure');
      }
      return actual.rename(oldPath, newPath);
    }),
  };
});

describe('saveKeyToFile error path', () => {
  it('propagates the error and removes the temp file when rename fails', async () => {
    const dir = makeTmpDir('dev-oidc-keys-rename-fail-');
    const filePath = path.join(dir, 'boom.json');

    await expect(
      createKeyMaterial(
        { kid: 'k1', alg: 'RS256', source: `file:${filePath}` },
        { configDir: dir },
      ),
    ).rejects.toThrow('simulated rename failure');

    // The temp file written before the failed rename must have been cleaned up.
    expect(readdirSync(dir)).toEqual([]);
  });
});
