import { describe, expect, it } from 'vitest';
import { renderAdminPage } from '@/admin/page.js';
import type { Config } from '@/config/schema.js';

function config(): Config {
  return {
    issuer: 'http://localhost:8080',
    port: 8080,
    host: '127.0.0.1',
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [
      {
        clientId: 'my-app',
        redirectUris: ['http://localhost:5173/cb'],
        postLogoutRedirectUris: [],
        audience: 'my-api',
      },
    ],
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'Dev OIDC Login', accentColor: '#1f6feb', logoUrl: null },
    profiles: [
      { id: 'alice', displayName: 'Alice', email: 'a@x.com', avatar: null, claims: {} },
      {
        id: 'bob',
        displayName: 'Bob',
        email: 'b@x.com',
        avatar: null,
        claims: { role: 'admin' },
      },
    ],
  };
}

describe('renderAdminPage', () => {
  it('renders a full HTML doc with the profiles table', () => {
    const html = renderAdminPage(config());
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Admin');
    expect(html).toContain('alice');
    expect(html).toContain('bob');
    expect(html).toContain('a@x.com');
    expect(html).toContain('b@x.com');
  });

  it('embeds a raw-config JSON view', () => {
    const html = renderAdminPage(config());
    expect(html).toContain('"issuer": "http://localhost:8080"');
  });

  it('escapes HTML-special characters in profile fields', () => {
    const cfg = config();
    cfg.profiles[0]!.displayName = '<script>alert(1)</script>';
    const html = renderAdminPage(cfg);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('includes an inline script that subscribes to /admin/events', () => {
    const html = renderAdminPage(config());
    expect(html).toContain('/admin/events');
    expect(html).toContain('EventSource');
  });
});
