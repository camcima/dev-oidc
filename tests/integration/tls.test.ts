import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';

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

describe('TLS integration (real socket)', () => {
  let server: DevOidcServer;
  let port: number;

  beforeAll(async () => {
    server = await createDevOidcServer({
      config: minimalConfig,
      tls: {
        cert: readFileSync(path.join(fixtureDir, 'cert.pem')),
        key: readFileSync(path.join(fixtureDir, 'key.pem')),
      },
      listenHost: '127.0.0.1',
      listenPort: 0,
    });
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = server.app.server.address() as AddressInfo;
    port = addr.port;
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves discovery doc over HTTPS with https:// in iss', async () => {
    const body = await fetchHttps(
      `https://127.0.0.1:${String(port)}/.well-known/openid-configuration`,
    );
    const json = JSON.parse(body) as { issuer: string };
    expect(json.issuer).toMatch(/^https:\/\//);
  });

  it('returns 301 to https:// for plain-HTTP requests on the same port', async () => {
    const { statusCode, headers } = await fetchHttpHeadersOnly(
      `http://127.0.0.1:${String(port)}/.well-known/openid-configuration`,
    );
    expect(statusCode).toBe(301);
    expect(headers.location).toMatch(/^https:\/\/.*\/\.well-known\/openid-configuration$/);
  });
});

function fetchHttps(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      // The fixture is self-signed and the mkcert root CA lives on the host,
      // not in the test sandbox. Trust the leaf directly for this test.
      { rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve(body);
        });
      },
    );
    req.on('error', reject);
  });
}

function fetchHttpHeadersOnly(
  url: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      resolve({ statusCode: res.statusCode ?? 0, headers: res.headers });
      res.resume();
    });
    req.on('error', reject);
  });
}
