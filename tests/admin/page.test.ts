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
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Admin');
    expect(html).toContain('alice');
    expect(html).toContain('bob');
    expect(html).toContain('a@x.com');
    expect(html).toContain('b@x.com');
  });

  it('embeds a raw-config JSON view', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toContain('"signingKey"');
    expect(html).toContain('"clients"');
  });

  it('escapes HTML-special characters in profile fields', () => {
    const cfg = config();
    cfg.profiles[0]!.displayName = '<script>alert(1)</script>';
    const html = renderAdminPage({ config: cfg, slug: '(legacy)' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('includes an inline script that subscribes to /admin/events', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toContain('/admin/events');
    expect(html).toContain('EventSource');
  });

  it('renders Edit and Delete buttons side-by-side in a flex container (no details/summary)', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    // Actions cell uses a flex container, NOT a native disclosure widget.
    expect(html).toContain('class="actions"');
    expect(html).not.toMatch(/<details\b/);
    expect(html).not.toMatch(/<summary\b/);
  });

  it('renders a modal <dialog> per profile keyed by id', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toMatch(/<dialog id="edit-dialog-alice"/);
    expect(html).toMatch(/<dialog id="edit-dialog-bob"/);
    // Edit button triggers the dialog via data attribute.
    expect(html).toMatch(/data-edit-dialog="alice"/);
    expect(html).toMatch(/data-edit-dialog="bob"/);
  });

  it('each edit dialog includes a Cancel button that closes the dialog', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toContain('data-dialog-close');
    expect(html).toContain('Cancel');
  });

  it('Add profile lives in its own modal, opened by a button next to the Profiles heading', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    // Header-row button opens the add dialog — not an inline form at the bottom.
    expect(html).toContain('data-open-dialog="add-dialog"');
    expect(html).toMatch(/<dialog id="add-dialog"/);
    // The old inline "Add profile" section is gone — only the dialog header
    // uses that phrase now.
    expect(html).not.toMatch(/<h2>Add profile<\/h2>/);
  });

  it('every profile form (edit and add) has a Cancel button; all forms are inside a dialog', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    // 2 edit dialogs + 1 add dialog = 3 forms, each with Cancel.
    const cancelCount = (html.match(/>Cancel</g) ?? []).length;
    expect(cancelCount).toBe(3);
  });

  it('uses legacy /admin/api/profiles URLs when slug is "(legacy)"', () => {
    const html = renderAdminPage({ config: config(), slug: '(legacy)' });
    expect(html).toContain('data-api="/admin/api/profiles"');
    expect(html).toContain('data-api="/admin/api/profiles/alice"');
  });

  it('uses slug-scoped /admin/api/:slug/profiles URLs when slug is not "(legacy)"', () => {
    const html = renderAdminPage({ config: config(), slug: 'myapp' });
    expect(html).toContain('data-api="/admin/api/myapp/profiles"');
    expect(html).toContain('data-api="/admin/api/myapp/profiles/alice"');
    expect(html).not.toContain('data-api="/admin/api/profiles"');
  });
});
