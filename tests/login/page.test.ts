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
      adminUrl: '/admin',
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
      adminUrl: '/admin',
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
      adminUrl: '/admin',
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
      adminUrl: '/admin',
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
      adminUrl: '/admin',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('includes a link to the admin UI', () => {
    const html = renderLoginPage({
      pendingAuthId: 'abc123',
      profiles,
      branding,
      actionUrl: '/authorize/complete',
      adminUrl: '/admin',
    });
    expect(html).toMatch(/<a[^>]+class="admin-link"[^>]+href="\/admin"/);
    expect(html).toContain('Manage profiles');
  });

  it('renders the branding logo with alt text when logoUrl is set', () => {
    const html = renderLoginPage({
      pendingAuthId: 'p1',
      profiles: [],
      branding: {
        title: 'Acme Login',
        accentColor: '#000',
        logoUrl: 'https://cdn.example/logo.png',
      },
      actionUrl: '/authorize/complete',
      adminUrl: '/admin',
    });
    expect(html).toContain('src="https://cdn.example/logo.png"');
    expect(html).toContain('alt="Acme Login logo"');
  });

  it('omits the logo element when logoUrl is null', () => {
    const html = renderLoginPage({
      pendingAuthId: 'p1',
      profiles: [],
      branding: { title: 'T', accentColor: '#000', logoUrl: null },
      actionUrl: '/authorize/complete',
      adminUrl: '/admin',
    });
    expect(html).not.toContain('<img');
  });

  it('links "Manage profiles" to the provided adminUrl', () => {
    const html = renderLoginPage({
      pendingAuthId: 'p1',
      profiles: [],
      branding: { title: 'T', accentColor: '#000', logoUrl: null },
      actionUrl: '/acme/authorize/complete',
      adminUrl: '/admin/acme',
    });
    expect(html).toContain('href="/admin/acme"');
  });
});

describe('renderLoginPage profile description', () => {
  const render = (ps: Parameters<typeof renderLoginPage>[0]['profiles']): string =>
    renderLoginPage({
      pendingAuthId: 'abc123',
      profiles: ps,
      branding,
      actionUrl: '/authorize/complete',
      adminUrl: '/admin',
    });

  // Byte-for-byte what v0.8.0 rendered for these two profiles. A profile
  // without a description must keep producing exactly this markup.
  const V080_GRID =
    '<div class="grid"><form class="tile" method="post" action="/authorize/complete">\n' +
    '      <input type="hidden" name="pendingAuthId" value="abc123" />\n' +
    '      <input type="hidden" name="profileId" value="alice" />\n' +
    '      <button type="submit" class="tile">\n' +
    '        <div class="name">Alice</div>\n' +
    '        <div class="email">alice@example.com</div>\n' +
    '      </button>\n' +
    '    </form><form class="tile" method="post" action="/authorize/complete">\n' +
    '      <input type="hidden" name="pendingAuthId" value="abc123" />\n' +
    '      <input type="hidden" name="profileId" value="bob" />\n' +
    '      <button type="submit" class="tile">\n' +
    '        <div class="name">Bob</div>\n' +
    '        <div class="email">bob@example.com</div>\n' +
    '      </button>\n' +
    '    </form></div>';

  it('renders cards without a description exactly as v0.8.0 did', () => {
    expect(render(profiles)).toContain(V080_GRID);
  });

  it('shows the description under the email, styled like the email line', () => {
    const html = render([{ ...profiles[0]!, description: 'Portal admin' }]);
    expect(html).toContain(
      '        <div class="email">alice@example.com</div>\n' +
        '        <div class="description">Portal admin</div>\n' +
        '      </button>',
    );
    expect(html).toMatch(/\.tile \.description \{[^}]*color: #667085;[^}]*font-size: 0\.875rem;/);
  });

  it('only adds the description line to the cards that have one', () => {
    const html = render([{ ...profiles[0]!, description: 'Portal admin' }, profiles[1]!]);
    expect(html.match(/class="description"/g)).toHaveLength(1);
    expect(html).toContain(
      '        <div class="name">Bob</div>\n' +
        '        <div class="email">bob@example.com</div>\n' +
        '      </button>',
    );
  });

  it('escapes HTML and quotes in the description', () => {
    const html = render([
      { ...profiles[0]!, description: `<script>alert("x")</script> O'Brian's team` },
    ]);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain(
      '<div class="description">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; O&#39;Brian&#39;s team</div>',
    );
  });
});
