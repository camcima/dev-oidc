import { describe, expect, it } from 'vitest';
import { renderIndexPage } from '@/index/page.js';
import type { Config } from '@/config/schema.js';

function config(): Config {
  return {
    issuer: 'http://localhost:8095',
    port: 8095,
    host: '127.0.0.1',
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients: [],
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'Dev OIDC', accentColor: '#1f6feb', logoUrl: null },
    profiles: [],
  };
}

describe('renderIndexPage', () => {
  it('returns a full HTML document', () => {
    const html = renderIndexPage({ config: config(), adminEnabled: false });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>');
  });

  it('lists discovery and JWKS endpoints', () => {
    const html = renderIndexPage({ config: config(), adminEnabled: false });
    expect(html).toContain('/.well-known/openid-configuration');
    expect(html).toContain('/.well-known/jwks.json');
  });

  it('shows the issuer from config', () => {
    const html = renderIndexPage({ config: config(), adminEnabled: false });
    expect(html).toContain('http://localhost:8095');
  });

  it('includes a link to /admin only when adminEnabled is true', () => {
    expect(renderIndexPage({ config: config(), adminEnabled: false })).not.toMatch(
      /href="\/admin"/,
    );
    expect(renderIndexPage({ config: config(), adminEnabled: true })).toMatch(/href="\/admin"/);
  });

  it('escapes the issuer when interpolated into HTML', () => {
    const cfg = config();
    cfg.issuer = 'http://<evil>';
    const html = renderIndexPage({ config: cfg, adminEnabled: false });
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
  });
});
