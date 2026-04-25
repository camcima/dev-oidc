import { describe, expect, it } from 'vitest';
import { deriveSlugFromPath } from '@/cli/slug.js';

describe('deriveSlugFromPath', () => {
  it('lowercases and hyphenates a directory name', () => {
    expect(deriveSlugFromPath('/home/user/My Project/dev-oidc.config.json')).toBe('my-project');
  });

  it('collapses runs of non-alphanumeric chars', () => {
    expect(deriveSlugFromPath('/x/foo___bar.baz/cfg.json')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing hyphens', () => {
    expect(deriveSlugFromPath('/x/-app-/cfg.json')).toBe('app');
  });

  it('returns null for an empty result', () => {
    expect(deriveSlugFromPath('/x/!!!/cfg.json')).toBeNull();
  });

  it('truncates to 64 chars', () => {
    const long = `/x/${'a'.repeat(80)}/cfg.json`;
    const result = deriveSlugFromPath(long);
    expect(result?.length).toBeLessThanOrEqual(64);
  });
});
