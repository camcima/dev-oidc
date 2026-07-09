import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '@/config/schema.js';

describe('ConfigSchema', () => {
  const minimalValid = {
    signingKey: { kid: 'k1' },
    clients: [
      {
        clientId: 'my-app',
        redirectUris: ['http://localhost:5173/auth/callback'],
        audience: 'my-api',
      },
    ],
    profiles: [{ id: 'alice', displayName: 'Alice', email: 'alice@example.com' }],
  };

  it('accepts a minimal config without issuer/port/host', () => {
    const result = ConfigSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
  });

  it('rejects when issuer is provided (moved to hub config / legacy CLI)', () => {
    const result = ConfigSchema.safeParse({
      ...minimalValid,
      issuer: 'http://localhost:8095',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/issuer no longer belongs in project config/);
    }
  });

  it('rejects when port is provided', () => {
    const result = ConfigSchema.safeParse({ ...minimalValid, port: 8095 });
    expect(result.success).toBe(false);
  });

  it('rejects when host is provided', () => {
    const result = ConfigSchema.safeParse({ ...minimalValid, host: '127.0.0.1' });
    expect(result.success).toBe(false);
  });

  it('rejects when clients array is empty', () => {
    const result = ConfigSchema.safeParse({ ...minimalValid, clients: [] });
    expect(result.success).toBe(false);
  });

  it('rejects when a client has no redirect URIs', () => {
    const result = ConfigSchema.safeParse({
      ...minimalValid,
      clients: [{ ...minimalValid.clients[0], redirectUris: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects when a profile has no id', () => {
    const result = ConfigSchema.safeParse({
      ...minimalValid,
      profiles: [{ displayName: 'X', email: 'x@example.com' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts arbitrary custom claims on a profile', () => {
    const result = ConfigSchema.safeParse({
      ...minimalValid,
      profiles: [
        {
          ...minimalValid.profiles[0],
          claims: { platformRole: 'admin', groups: ['a', 'b'] },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults subjectClaim to "sub"', () => {
    const result = ConfigSchema.safeParse(minimalValid);
    if (!result.success) throw result.error;
    expect(result.data.subjectClaim).toBe('sub');
  });

  it('rejects when signingKey.alg is not supported', () => {
    const result = ConfigSchema.safeParse({
      ...minimalValid,
      signingKey: { kid: 'k1', alg: 'HS256' },
    });
    expect(result.success).toBe(false);
  });

  it('fully defaults branding when omitted', () => {
    const result = ConfigSchema.safeParse(minimalValid);
    if (!result.success) throw result.error;
    expect(result.data.branding.title).toBe('Dev OIDC Login');
    expect(result.data.branding.accentColor).toBe('#1f6feb');
    expect(result.data.branding.logoUrl).toBeNull();
  });

  it('merges branding defaults when only some fields are given', () => {
    const result = ConfigSchema.safeParse({
      ...minimalValid,
      branding: { accentColor: '#123456' },
    });
    if (!result.success) throw result.error;
    expect(result.data.branding.title).toBe('Dev OIDC Login');
    expect(result.data.branding.accentColor).toBe('#123456');
    expect(result.data.branding.logoUrl).toBeNull();
  });

  it('rejects signingKey.source "file:" with no path', () => {
    const result = ConfigSchema.safeParse({
      ...minimalValid,
      signingKey: { kid: 'k1', source: 'file:' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts signingKey.source "file:/path/to/key.pem"', () => {
    const result = ConfigSchema.safeParse({
      ...minimalValid,
      signingKey: { kid: 'k1', source: 'file:/path/to/key.pem' },
    });
    expect(result.success).toBe(true);
  });
});

function baseConfig(profileExtra: Record<string, unknown>) {
  return {
    signingKey: { kid: 'k1' },
    clients: [{ clientId: 'app', redirectUris: ['http://localhost:3000/cb'], audience: 'api' }],
    profiles: [{ id: 'alice', displayName: 'Alice', email: 'alice@example.com', ...profileExtra }],
  };
}

describe('ProfileSchema Google fields', () => {
  it('accepts the new optional identity fields', () => {
    const parsed = ConfigSchema.parse(
      baseConfig({
        givenName: 'Alice',
        familyName: 'Dev',
        locale: 'en',
        hostedDomain: 'example.com',
        emailVerified: false,
        avatar: 'https://example.com/a.png',
      }),
    );
    const p = parsed.profiles[0]!;
    expect(p.givenName).toBe('Alice');
    expect(p.familyName).toBe('Dev');
    expect(p.locale).toBe('en');
    expect(p.hostedDomain).toBe('example.com');
    expect(p.emailVerified).toBe(false);
    expect(p.avatar).toBe('https://example.com/a.png');
  });

  it('leaves new fields undefined when omitted (no required defaults)', () => {
    const parsed = ConfigSchema.parse(baseConfig({}));
    const p = parsed.profiles[0]!;
    expect(p.givenName).toBeUndefined();
    expect(p.emailVerified).toBeUndefined();
    expect(p.avatar).toBeNull(); // avatar keeps its existing default(null)
  });
});

describe('Project ConfigSchema rejects misplaced TLS', () => {
  it('rejects a top-level tls field with the tailored message', () => {
    const result = ConfigSchema.safeParse({
      signingKey: { kid: 'k1' },
      clients: [
        {
          clientId: 'app',
          redirectUris: ['http://localhost:5173/auth/callback'],
          audience: 'api',
        },
      ],
      tls: { hostnames: ['localhost'] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          /tls no longer belongs in project config; set hub\.server\.tls/.test(i.message),
        ),
      ).toBe(true);
    }
  });
});

describe('ConfigSchema identity uniqueness', () => {
  const client = (over: Record<string, unknown> = {}) => ({
    clientId: 'app',
    redirectUris: ['http://localhost:3000/cb'],
    audience: 'api',
    ...over,
  });
  const base = {
    signingKey: { kid: 'k1' },
    clients: [client()],
    profiles: [{ id: 'alice', displayName: 'Alice', email: 'alice@example.com' }],
  };

  it('rejects duplicate clientId values', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      clients: [client(), client({ redirectUris: ['http://localhost:4000/cb'] })],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate clientId "app"/.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejects duplicate profile ids', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      profiles: [
        { id: 'alice', displayName: 'Alice', email: 'alice@example.com' },
        { id: 'alice', displayName: 'Alice 2', email: 'alice2@example.com' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate profile id "alice"/.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejects duplicate entries within redirectUris', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      clients: [client({ redirectUris: ['http://localhost:3000/cb', 'http://localhost:3000/cb'] })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate entries within postLogoutRedirectUris', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      clients: [
        client({
          postLogoutRedirectUris: ['http://localhost:3000/', 'http://localhost:3000/'],
        }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts distinct clients, profiles, and URIs', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      clients: [client(), client({ clientId: 'app2' })],
      profiles: [
        { id: 'alice', displayName: 'Alice', email: 'alice@example.com' },
        { id: 'bob', displayName: 'Bob', email: 'bob@example.com' },
      ],
    });
    expect(result.success).toBe(true);
  });
});
