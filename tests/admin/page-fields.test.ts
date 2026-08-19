import { describe, expect, it } from 'vitest';
import { renderAdminPage } from '@/admin/page.js';
import type { Config } from '@/config/schema.js';

function config(): Config {
  return {
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
      {
        id: 'alice',
        displayName: 'Alice Developer',
        email: 'alice@example.com',
        avatar: 'https://cdn.example.com/alice.png',
        emailVerified: true,
        givenName: 'Alice',
        familyName: 'Developer',
        locale: 'en',
        hostedDomain: 'example.com',
        claims: { role: 'admin' },
      },
    ],
  };
}

describe('admin edit dialog exposes every editable profile field', () => {
  const OPTIONAL_FIELDS = [
    'givenName',
    'familyName',
    'avatar',
    'locale',
    'hostedDomain',
    'emailVerified',
  ] as const;

  it('renders an input for each optional profile field', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    for (const field of OPTIONAL_FIELDS) {
      expect(html, `missing input for "${field}"`).toContain(`name="${field}"`);
    }
  });

  it('pre-populates the optional inputs with the profile values', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toContain('https://cdn.example.com/alice.png');
    expect(html).toContain('value="Developer"');
    expect(html).toContain('value="example.com"');
    expect(html).toContain('value="en"');
  });

  it('offers the same optional fields on the add-profile form', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    // Two forms (edit + add) must each carry the optional inputs.
    for (const field of OPTIONAL_FIELDS) {
      const occurrences = html.split(`name="${field}"`).length - 1;
      expect(occurrences, `"${field}" should appear on both edit and add forms`).toBeGreaterThan(1);
    }
  });
});

describe('admin page redacts client secrets in its raw-config dump', () => {
  it('never renders a configured clientSecret', () => {
    const withSecret: Config = {
      ...config(),
      clients: [{ ...config().clients[0]!, clientSecret: 'super-secret-value' }],
    };
    const html = renderAdminPage({ config: withSecret, slug: '(legacy)' });
    expect(html).not.toContain('super-secret-value');
    expect(html).toContain('[redacted]');
  });

  it('leaves a public client untouched', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).not.toContain('[redacted]');
  });
});
