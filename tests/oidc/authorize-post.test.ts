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

  it('honours response_mode=fragment for a form-encoded error', async () => {
    const server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/authorize',
        headers: FORM,
        payload: form({ response_type: 'token', response_mode: 'fragment' }),
      });
      expect(res.statusCode).toBe(302);
      const loc = new URL(res.headers.location as string);
      expect(loc.search).toBe('');
      const fragment = new URLSearchParams(loc.hash.slice(1));
      expect(fragment.get('error')).toBe('unsupported_response_type');
      expect(fragment.get('state')).toBe('s1');
    } finally {
      await server.close();
    }
  });

  it('honours response_mode=form_post for a form-encoded error', async () => {
    const server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/authorize',
        headers: FORM,
        payload: form({ prompt: 'none', response_mode: 'form_post' }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.payload).toContain(`<form method="post" action="${REDIRECT}">`);
      expect(res.payload).toContain('<input type="hidden" name="error" value="login_required">');
      expect(res.payload).toContain('<input type="hidden" name="state" value="s1">');
    } finally {
      await server.close();
    }
  });

  it('answers an unknown response_mode with invalid_request in the query', async () => {
    const server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/authorize',
        headers: FORM,
        payload: form({ response_mode: 'bogus' }),
      });
      expect(res.statusCode).toBe(302);
      const loc = new URL(res.headers.location as string);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('error_description')).toContain('response_mode');
    } finally {
      await server.close();
    }
  });

  it('answers a repeated response_mode with invalid_request', async () => {
    const server = await createDevOidcServer({ config, issuer: 'http://localhost:8095' });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/authorize',
        headers: FORM,
        payload: `${form()}&response_mode=query&response_mode=fragment`,
      });
      expect(res.statusCode).toBe(302);
      const loc = new URL(res.headers.location as string);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('error_description')).toContain('response_mode');
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
