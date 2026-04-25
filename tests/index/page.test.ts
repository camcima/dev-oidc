import { describe, expect, it } from 'vitest';
import { renderIndexPage } from '@/index/page.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import type { Config } from '@/config/schema.js';

function config(): Config {
  return {
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [],
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'Dev OIDC', accentColor: '#1f6feb', logoUrl: null },
    profiles: [],
  };
}

function tenant(issuer = 'http://localhost:8095'): ActiveTenantState {
  const cfg = config();
  return {
    slug: '(legacy)',
    configPath: '',
    status: 'active',
    config: cfg,
    issuer,
    runtime: null as never,
    keyMaterial: null as never,
    jwks: null as never,
    codes: null as never,
    pending: null as never,
    watcher: null,
  };
}

describe('renderIndexPage', () => {
  it('returns a full HTML document', () => {
    const html = renderIndexPage({ tenant: tenant(), adminEnabled: false });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>');
  });

  it('lists discovery and JWKS endpoints', () => {
    const html = renderIndexPage({ tenant: tenant(), adminEnabled: false });
    expect(html).toContain('/.well-known/openid-configuration');
    expect(html).toContain('/.well-known/jwks.json');
  });

  it('shows the issuer from config', () => {
    const html = renderIndexPage({ tenant: tenant(), adminEnabled: false });
    expect(html).toContain('http://localhost:8095');
  });

  it('includes a link to /admin only when adminEnabled is true', () => {
    expect(renderIndexPage({ tenant: tenant(), adminEnabled: false })).not.toMatch(
      /href="\/admin"/,
    );
    expect(renderIndexPage({ tenant: tenant(), adminEnabled: true })).toMatch(/href="\/admin"/);
  });

  it('escapes the issuer when interpolated into HTML', () => {
    const html = renderIndexPage({
      tenant: tenant('http://<evil>'),
      adminEnabled: false,
    });
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
  });
});
