# Publishing dev-oidc

This document is the user-facing checklist for publishing dev-oidc to npm and GHCR.

## Prerequisites (one-time)

1. **Create a GitHub repository** under your user or organization. Suggested: `OWNER/dev-oidc`.
2. **Configure secrets** in the GitHub repository's Settings → Secrets and variables → Actions:
   - `NPM_TOKEN` — an npm access token with publish permissions for the chosen package name.
   - `GITHUB_TOKEN` is provided automatically; no action needed for GHCR.
3. **Decide on the final package name**. If `dev-oidc` is taken on npm, choose an alternative (e.g., `@your-scope/dev-oidc`, `local-oidc`, `oidc-devkit`). Update `package.json` `name`, and the CI/release workflow's image reference accordingly.

## First-time publish

1. Replace placeholder URLs in `README.md`, `SECURITY.md`, `package.json` (repository/bugs/homepage) with your real repo URL.
2. Push the repo to GitHub:
   ```bash
   cd /home/camcima/repos/camcima/dev-oidc
   git remote add origin git@github.com:OWNER/dev-oidc.git
   git push -u origin main
   ```
3. Verify CI is green on the default branch.
4. Cut a release:
   ```bash
   git tag v0.1.0-alpha.1
   git push --tags
   ```
5. The `release.yml` workflow will:
   - Build + test.
   - `npm publish` with the token.
   - Build + push the Docker image to `ghcr.io/OWNER/dev-oidc:<tag>`.

## Subsequent releases

1. Update `CHANGELOG.md` under `## Unreleased`, then move those entries under a new `## X.Y.Z - YYYY-MM-DD` heading.
2. Bump `version` in `package.json`.
3. Commit: `chore(release): vX.Y.Z`.
4. Tag + push: `git tag vX.Y.Z && git push --tags`.

## Known limitations of the automation

- The release workflow does not auto-generate release notes from the changelog — edit the GitHub release body manually if desired.
- GHCR images are scoped to the user/org that owns the GitHub repo. If you want a different OCI registry, adjust `release.yml`.
- The `NPM_TOKEN` must have publish scope on the chosen package name. If publishing under a scope, the scope must be configured on the token.
