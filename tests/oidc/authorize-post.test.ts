import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/schema.js';
import { createHubServer } from '@/hub/server.js';
import { createDevOidcServer } from '@/server.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

// OIDC Core §3.1.2.1: the authorization endpoint MUST support GET and POST.
// POST carries the same parameters form-encoded in the body.

const REDIRECT = 'http://localhost:5173/cb';
const config: Config = {
  signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
  clients: [
    {
      clientId: 'app',
      redirectUris: [REDIRECT],
      postLogoutRedirectUris: [],
      audience: 'api',
      requirePkce: false,
    },
  ],
  subjectClaim: 'sub',
  tokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 28800,
  branding: { title: 'T', accentColor: '#000', logoUrl: null },
  profiles: [{ id: 'alice', displayName: 'A', email: 'a@x.com', avatar: null, claims: {} }],
};

function form(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    client_id: 'app',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid',
    state: 's1',
    ...overrides,
  }).toString();
}
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('POST /authorize', () => {
  it('renders the login page for a valid form-encoded request', async () => {
    const server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/authorize',
        headers: FORM,
        payload: form(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('name="pendingAuthId"');
    } finally {
      await server.close();
    }
  });

  it('redirects errors the same way GET does', async () => {
    const server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/authorize',
        headers: FORM,
        payload: form({ response_type: 'token' }),
      });
      expect(res.statusCode).toBe(302);
      const loc = new URL(res.headers.location as string);
      expect(loc.searchParams.get('error')).toBe('unsupported_response_type');
      expect(loc.searchParams.get('state')).toBe('s1');
    } finally {
      await server.close();
    }
  });

  it('works under a hub tenant prefix', async () => {
    const dir = makeTmpDir('dev-oidc-authz-post-');
    const cfg = path.join(dir, 'dev-oidc.config.json');
    writeFileSync(cfg, JSON.stringify(config));
    const hub = path.join(dir, 'hub.json');
    writeFileSync(
      hub,
      JSON.stringify({
        version: '1',
        server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
        tenants: [{ slug: 'app', configPath: cfg, enabled: true }],
      }),
    );
    const server = await createHubServer({ hubConfigPath: hub });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/app/authorize',
        headers: FORM,
        payload: form(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('action="/app/authorize/complete"');
    } finally {
      await server.close();
    }
  });
});
