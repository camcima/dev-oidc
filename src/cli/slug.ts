import path from 'node:path';

const HYPHEN_TRIM = /^-+|-+$/g;

export function deriveSlugFromPath(configPath: string): string | null {
  const parent = path.basename(path.dirname(path.resolve(configPath)));
  let slug = parent
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(HYPHEN_TRIM, '');
  if (slug.length > 64) slug = slug.slice(0, 64).replace(HYPHEN_TRIM, '');
  return slug.length > 0 ? slug : null;
}
