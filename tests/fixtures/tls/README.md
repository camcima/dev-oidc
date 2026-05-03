# TLS Fixtures

These cert/key files are committed for the integration test at `tests/integration/tls.test.ts`. They cover SANs `dev-oidc.localhost`, `localhost`, and `127.0.0.1` only — they never appear outside `tests/`. They are self-signed (no real CA chain); the integration test uses `rejectUnauthorized: false` to accept them.

## Regenerating (after expiry)

The cert is valid for 825 days. If the integration test starts failing with a "cert expired" error, regenerate:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout tests/fixtures/tls/key.pem \
  -out tests/fixtures/tls/cert.pem \
  -subj "/CN=dev-oidc.localhost" \
  -addext "subjectAltName=DNS:dev-oidc.localhost,DNS:localhost,IP:127.0.0.1"
git add tests/fixtures/tls/cert.pem tests/fixtures/tls/key.pem
git commit -m "test(fixtures/tls): regenerate expired fixture cert"
```
