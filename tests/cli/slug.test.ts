import { describe, expect, it } from 'vitest';
import { deriveSlugFromPath } from '@/cli/slug.js';
import { SLUG_REGEX } from '@/hub/schema.js';

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

  it('any non-null result satisfies SLUG_REGEX', () => {
    // Property check: derived slugs must always be acceptable to the
    // schema validator, otherwise `dev-oidc register` would fail downstream.
    const samples = [
      '/x/-leading/cfg.json',
      '/x/trailing-/cfg.json',
      '/x/--multi--hyphen--/cfg.json',
      '/x/Mixed_Case Project!/cfg.json',
      `/x/${'a-'.repeat(40)}/cfg.json`,
      '/x/ümlaut-app/cfg.json',
    ];
    for (const sample of samples) {
      const slug = deriveSlugFromPath(sample);
      if (slug === null) continue;
      expect(slug, `derived from ${sample}`).toMatch(SLUG_REGEX);
    }
  });
});
