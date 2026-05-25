#!/usr/bin/env node
// Release preflight: fail fast when the GitHub Release step cannot succeed.
//
// .release-it.json sets `github.release: true`, but release-it does NOT fail
// when its token env var is absent — it warns and falls back to a "web"
// release. In --ci mode that fallback only marks a generated web-form URL as
// released; it never calls the API, so npm publish + tag push still happen and
// the maintainer is left with no GitHub Release. This guard turns that silent
// fallback into a hard stop before any publish/tag/push work begins.
//
// release-it reads the token from `github.tokenRef` (default GITHUB_TOKEN), so
// that is exactly the variable we require here. Dry runs skip before:init
// hooks, so `npm run release:dry` is unaffected.

const TOKEN_REF = 'GITHUB_TOKEN';
const token = process.env[TOKEN_REF];

if (typeof token === 'string' && token.trim().length > 0) {
  process.exit(0);
}

console.error(
  [
    `release preflight: ${TOKEN_REF} is not set.`,
    '',
    '.release-it.json has github.release enabled, but without a token release-it',
    'silently falls back to a no-op web release and the GitHub Release is never',
    'created. Export a token before releasing, e.g.:',
    '',
    '  export GITHUB_TOKEN=$(gh auth token)',
    '',
    'Then re-run the release. (Dry runs do not require a token.)',
  ].join('\n'),
);
process.exit(1);
