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

describe('admin profile description field', () => {
  function withDescription(description: string): Config {
    const c = config();
    return { ...c, profiles: [{ ...c.profiles[0]!, description }] };
  }

  it('offers a Description input on both the edit and add forms', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toContain('<label for="description-alice">Description</label>');
    expect(html).toContain('<label for="description-new">Description</label>');
    expect(html.split('name="description"').length - 1).toBe(2);
  });

  it('caps the input at the schema length limit', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toMatch(/name="description"[^>]*maxlength="200"/);
  });

  it('explains that the description is shown on the login page only', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toMatch(
      /aria-describedby="description-hint-alice"[\s\S]*id="description-hint-alice"[^>]*>Shown on the login page only; never sent in tokens\.</,
    );
    expect(html).toContain('id="description-hint-new"');
  });

  it('pre-populates the edit input with the stored description', () => {
    const html = renderAdminPage({ config: withDescription('Portal admin'), slug: '(legacy)' });
    expect(html).toMatch(/id="description-alice"[^>]*value="Portal admin"/);
  });

  it('leaves the input empty when the profile has no description', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toMatch(/id="description-alice"[^>]*value=""/);
  });

  it('escapes HTML and quotes in the description', () => {
    const hostile = `<script>alert("x")</script> O'Brian`;
    const html = renderAdminPage({ config: withDescription(hostile), slug: '(legacy)' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('value="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; O&#39;Brian"');
  });

  it('submits a blank description as null so the API removes it', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toMatch(/const optional = \[[^\]]*'description'[^\]]*\]/);
  });

  it('adds no description key to the raw-config dump of a config without one', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    const dump = html.slice(html.indexOf('<div class="json">'));
    expect(dump).not.toContain('"description"');
  });
});
