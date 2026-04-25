# Security Policy

## Supported versions

dev-oidc is a **development tool**. It is not suitable for production use. Tokens are signed by keys generated at startup and do not persist across restarts. No client authentication.

Nevertheless, if you find a security issue that could affect development workflows (e.g., a way to inject executable code via a malformed config file), please report it privately.

## Reporting a vulnerability

Please report security issues via **private disclosure**:

1. Open a [security advisory](https://github.com/camcima/dev-oidc/security/advisories/new) on GitHub.
2. Or email the maintainers (see `MAINTAINERS` in the repo, if present).

Do **not** open a public issue for security matters.

We aim to:

- Acknowledge reports within 5 business days.
- Publish a fix within 90 days of the report, or explain why longer is needed.
- Credit reporters in the changelog unless they prefer anonymity.
