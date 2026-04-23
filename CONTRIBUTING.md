# Contributing

Thanks for considering contributing to dev-oidc.

## Setup

```bash
git clone <this-repo-url>
cd dev-oidc
npm install
```

## Running checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

The pre-commit hook (lefthook) runs lint, format:check, and typecheck automatically. Please don't bypass it (`--no-verify`) — if a check fails, fix the root cause.

## Commit style

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Examples:

- `feat(admin): add bulk-delete endpoint`
- `fix(oidc): reject mismatched redirect_uri earlier`
- `docs: document admin UI`

## Coding style

- TypeScript strict mode. Explicit types on every exported symbol and every variable in `src/`.
- ESM only (`"type": "module"`).
- Prettier: `semi: true, trailingComma: all, singleQuote: true, printWidth: 100, tabWidth: 2`. Run `npm run format` if in doubt.
- Tests: Vitest with TDD preferred. Each public function should have unit tests; integration tests live under `tests/integration/`.

## Pull requests

- Keep PRs focused. If you're changing multiple unrelated things, split into separate PRs.
- Include tests for new behavior.
- Update `CHANGELOG.md` under `## Unreleased` with a one-line summary.
- Don't bump the version in PRs — release tagging happens in the release workflow.

## Local development with Docker

```bash
docker build -t dev-oidc:local .
docker run --rm -p 8080:8080 -v "$(pwd)/examples:/config:ro" dev-oidc:local
```

## Questions

Open a GitHub issue with the "question" label.
