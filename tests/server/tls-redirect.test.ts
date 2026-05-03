import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer } from '@/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.resolve(__dirname, '../fixtures/tls');

const minimalConfig: Config = {
  signingKey: { kid: 'test-key', alg: 'RS256', source: 'generate' },
  clients: [
    {
      clientId: 'test-app',
      redirectUris: ['http://localhost:5173/auth/callback'],
      audience: 'test-api',
      postLogoutRedirectUris: [],
    },
  ],
  subjectClaim: 'sub',
  tokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 28800,
  branding: { title: 'Test', accentColor: '#000', logoUrl: null },
  profiles: [],
};

describe('TLS redirect hook', () => {
  it('returns 301 to https:// when a plain-http request reaches the same-port multiplex', async () => {
    const tls = {
      cert: readFileSync(path.join(fixtureDir, 'cert.pem')),
      key: readFileSync(path.join(fixtureDir, 'key.pem')),
    };
    const { app, close } = await createDevOidcServer({
      config: minimalConfig,
      tls,
      listenHost: '127.0.0.1',
      listenPort: 8095,
    });

    try {
      // app.inject simulates a request directly into the Fastify pipeline.
      // The injected socket has `encrypted` undefined → the redirect hook fires.
      // The encrypted-pass-through case (TLS request) is exercised end-to-end by
      // the real-network integration test in tests/integration/tls.test.ts.
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/openid-configuration',
        headers: { host: 'localhost:8095' },
      });
      expect(response.statusCode).toBe(301);
      expect(response.headers.location).toBe(
        'https://localhost:8095/.well-known/openid-configuration',
      );
    } finally {
      await close();
    }
  });
});
