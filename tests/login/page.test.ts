import { describe, expect, it } from 'vitest';
import { renderLoginPage } from '@/login/page.js';

const branding = { title: 'Test Login', accentColor: '#ff0000', logoUrl: null };

const profiles = [
  { id: 'alice', displayName: 'Alice', email: 'alice@example.com', avatar: null, claims: {} },
  {
    id: 'bob',
    displayName: 'Bob',
    email: 'bob@example.com',
    avatar: null,
    claims: { role: 'admin' },
  },
];

describe('renderLoginPage', () => {
  it('renders a full HTML doc with the title', () => {
    const html = renderLoginPage({
      pendingAuthId: 'abc123',
      profiles,
      branding,
      actionUrl: '/authorize/complete',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Test Login</title>');
  });

  it('renders one tile per profile with name + email', () => {
    const html = renderLoginPage({
      pendingAuthId: 'abc123',
      profiles,
      branding,
      actionUrl: '/authorize/complete',
    });
    expect(html).toContain('Alice');
    expect(html).toContain('alice@example.com');
    expect(html).toContain('Bob');
    expect(html).toContain('bob@example.com');
  });

  it('embeds pendingAuthId + profileId as hidden inputs', () => {
    const html = renderLoginPage({
      pendingAuthId: 'abc123',
      profiles,
      branding,
      actionUrl: '/authorize/complete',
    });
    expect(html).toMatch(/name="pendingAuthId"[^>]*value="abc123"/);
    expect(html).toMatch(/name="profileId"[^>]*value="alice"/);
    expect(html).toMatch(/name="profileId"[^>]*value="bob"/);
  });

  it('submits to the configured action URL', () => {
    const html = renderLoginPage({
      pendingAuthId: 'abc123',
      profiles,
      branding,
      actionUrl: '/authorize/complete',
    });
    expect(html).toMatch(/action="\/authorize\/complete"/);
  });

  it('escapes HTML-special characters in profile fields', () => {
    const hostile = [
      {
        id: 'x',
        displayName: '<script>alert(1)</script>',
        email: 'x@example.com',
        avatar: null,
        claims: {},
      },
    ];
    const html = renderLoginPage({
      pendingAuthId: 'abc123',
      profiles: hostile,
      branding,
      actionUrl: '/authorize/complete',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
