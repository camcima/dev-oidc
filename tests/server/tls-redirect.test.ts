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
  it('returns 308 to https:// when a plain-http request reaches the same-port multiplex', async () => {
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
        headers: { host: '127.0.0.1:8095' },
      });
      expect(response.statusCode).toBe(308);
      expect(response.headers.location).toBe(
        'https://127.0.0.1:8095/.well-known/openid-configuration',
      );
    } finally {
      await close();
    }
  });

  it('rejects an attacker-controlled Host header and falls back to listen host:port', async () => {
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
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/openid-configuration',
        headers: { host: 'evil.example.com' },
      });
      expect(response.statusCode).toBe(308);
      expect(response.headers.location).toBe(
        'https://127.0.0.1:8095/.well-known/openid-configuration',
      );
    } finally {
      await close();
    }
  });

  it('echoes a Host that matches the configured publicUrl host', async () => {
    const tls = {
      cert: readFileSync(path.join(fixtureDir, 'cert.pem')),
      key: readFileSync(path.join(fixtureDir, 'key.pem')),
    };
    const { app, close } = await createDevOidcServer({
      config: minimalConfig,
      tls,
      listenHost: '127.0.0.1',
      listenPort: 8095,
      publicUrl: 'https://idp.example.test:8095',
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/openid-configuration',
        headers: { host: 'idp.example.test:8095' },
      });
      expect(response.statusCode).toBe(308);
      expect(response.headers.location).toBe(
        'https://idp.example.test:8095/.well-known/openid-configuration',
      );
    } finally {
      await close();
    }
  });
});

describe('TLS redirect preserves the request method', () => {
  it('uses 308 so a POST /token is not rewritten into a GET', async () => {
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
      const response = await app.inject({
        method: 'POST',
        url: '/token',
        headers: { host: '127.0.0.1:8095' },
        payload: 'grant_type=authorization_code',
      });
      // 301/302 let clients downgrade POST to GET; 308 forbids it.
      expect(response.statusCode).toBe(308);
      expect(response.headers.location).toBe('https://127.0.0.1:8095/token');
    } finally {
      await close();
    }
  });
});
