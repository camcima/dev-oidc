import { describe, expect, it } from 'vitest';
import { HubConfigSchema, RESERVED_SLUGS, isReservedSlug } from '@/hub/schema.js';

describe('HubConfigSchema', () => {
  const validBase = {
    version: '1' as const,
    server: { port: 8095, host: '127.0.0.1' },
    tenants: [],
  };

  it('accepts an empty hub config', () => {
    const result = HubConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('defaults version to "1" when omitted', () => {
    const result = HubConfigSchema.safeParse({ server: validBase.server, tenants: [] });
    if (!result.success) throw result.error;
    expect(result.data.version).toBe('1');
  });

  it('defaults server.port to 8095 and host to 127.0.0.1', () => {
    const result = HubConfigSchema.safeParse({ version: '1', server: {}, tenants: [] });
    if (!result.success) throw result.error;
    expect(result.data.server.port).toBe(8095);
    expect(result.data.server.host).toBe('127.0.0.1');
  });

  it('rejects an unknown version', () => {
    const result = HubConfigSchema.safeParse({ ...validBase, version: '2' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid tenant entry', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'my-app', configPath: '/tmp/dev-oidc.config.json', enabled: true }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a slug with uppercase letters', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'My-App', configPath: '/tmp/c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slug starting with a hyphen', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: '-app', configPath: '/tmp/c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slug ending with a hyphen', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'app-', configPath: '/tmp/c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slug longer than 64 chars', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'a'.repeat(65), configPath: '/tmp/c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it.each(['admin', 'api', '.well-known', '_internal', '.dotfile'])(
    'rejects reserved slug %s',
    (slug) => {
      const result = HubConfigSchema.safeParse({
        ...validBase,
        tenants: [{ slug, configPath: '/tmp/c.json', enabled: true }],
      });
      expect(result.success).toBe(false);
    },
  );

  it('rejects a relative configPath', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'app', configPath: './c.json', enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it('defaults enabled to true', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [{ slug: 'app', configPath: '/tmp/c.json' }],
    });
    if (!result.success) throw result.error;
    expect(result.data.tenants[0]!.enabled).toBe(true);
  });

  it('rejects duplicate slugs in tenants array', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      tenants: [
        { slug: 'app', configPath: '/tmp/a.json', enabled: true },
        { slug: 'app', configPath: '/tmp/b.json', enabled: true },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('exports isReservedSlug', () => {
    expect(isReservedSlug('admin')).toBe(true);
    expect(isReservedSlug('my-app')).toBe(false);
  });

  it('exports RESERVED_SLUGS', () => {
    expect(RESERVED_SLUGS).toContain('admin');
  });
});

describe('ServerSchema.tls', () => {
  const validBase = {
    version: '1' as const,
    server: { port: 8095, host: '127.0.0.1' },
    tenants: [],
  };

  it('accepts an absent tls block (HTTP mode)', () => {
    const result = HubConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.server.tls).toBeUndefined();
  });

  it('accepts an empty tls object (auto-mkcert with default hostnames)', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      server: { ...validBase.server, tls: {} },
    });
    expect(result.success).toBe(true);
  });

  it('accepts tls.hostnames (auto-mkcert with explicit SANs)', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      server: { ...validBase.server, tls: { hostnames: ['dev-oidc.localhost', 'localhost'] } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts tls.cert + tls.key (BYO mode)', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      server: { ...validBase.server, tls: { cert: '/p/cert.pem', key: '/p/key.pem' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects tls.cert without tls.key', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      server: { ...validBase.server, tls: { cert: '/p/cert.pem' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /both be set or both omitted/.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejects tls.key without tls.cert', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      server: { ...validBase.server, tls: { key: '/p/key.pem' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects tls.hostnames combined with tls.cert+key (mode exclusion)', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      server: {
        ...validBase.server,
        tls: { cert: '/p/cert.pem', key: '/p/key.pem', hostnames: ['localhost'] },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /only valid in auto-mkcert mode/.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects an empty hostnames array', () => {
    const result = HubConfigSchema.safeParse({
      ...validBase,
      server: { ...validBase.server, tls: { hostnames: [''] } },
    });
    expect(result.success).toBe(false);
  });
});

describe('server.publicUrl validation', () => {
  it('rejects a publicUrl with a query string or fragment', () => {
    for (const publicUrl of ['https://oidc.test/?x=1', 'https://oidc.test/#frag']) {
      const result = HubConfigSchema.safeParse({ server: { publicUrl } });
      expect(result.success).toBe(false);
    }
  });

  it('accepts a plain https publicUrl', () => {
    expect(HubConfigSchema.safeParse({ server: { publicUrl: 'https://oidc.test' } }).success).toBe(
      true,
    );
  });
});
