import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '@/config/schema.js';

describe('ConfigSchema', () => {
  const minimalValid = {
    issuer: 'http://localhost:8080',
    signingKey: { kid: 'k1' },
    clients: [
      {
        clientId: 'my-app',
        redirectUris: ['http://localhost:5173/auth/callback'],
        audience: 'my-api',
      },
    ],
    profiles: [
      {
        id: 'alice',
        displayName: 'Alice',
        email: 'alice@example.com',
      },
    ],
  };

  it('accepts a minimal valid config', () => {
    const result = ConfigSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
  });

  it('rejects when issuer is missing', () => {
    const { issuer, ...rest } = minimalValid;
    void issuer;
    const result = ConfigSchema.safeParse(rest);
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

  it('defaults port to 8080', () => {
    const result = ConfigSchema.safeParse(minimalValid);
    if (!result.success) throw result.error;
    expect(result.data.port).toBe(8080);
  });

  it('defaults host to 127.0.0.1', () => {
    const result = ConfigSchema.safeParse(minimalValid);
    if (!result.success) throw result.error;
    expect(result.data.host).toBe('127.0.0.1');
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
