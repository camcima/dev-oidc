import { describe, expect, it } from 'vitest';
import { renderHubDashboard } from '@/admin/dashboard.js';

describe('renderHubDashboard', () => {
  it('renders the public URL and tenant rows', () => {
    const html = renderHubDashboard({
      publicUrl: 'http://localhost:8095',
      tenants: [
        {
          slug: 'app',
          status: 'active',
          issuer: 'http://localhost:8095/app',
          configPath: '/abs/app/dev-oidc.config.json',
          profileCount: 3,
          lastError: null,
        },
        {
          slug: 'broken',
          status: 'error',
          issuer: null,
          configPath: '/abs/broken.json',
          profileCount: null,
          lastError: 'JSON parse error',
        },
      ],
    });
    expect(html).toContain('http://localhost:8095');
    expect(html).toContain('app');
    expect(html).toContain('Active');
    expect(html).toContain('Error');
    expect(html).toContain('JSON parse error');
  });

  it('renders empty state when no tenants', () => {
    const html = renderHubDashboard({ publicUrl: 'http://localhost:8095', tenants: [] });
    expect(html).toMatch(/No tenants registered/i);
    expect(html).toContain('dev-oidc register');
  });

  it('escapes user-supplied content', () => {
    const html = renderHubDashboard({
      publicUrl: 'http://localhost:8095',
      tenants: [
        {
          slug: 'app',
          status: 'error',
          issuer: null,
          configPath: '/abs/x.json',
          profileCount: null,
          lastError: '<script>alert(1)</script>',
        },
      ],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
