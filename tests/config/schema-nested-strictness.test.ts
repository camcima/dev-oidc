import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '@/config/schema.js';

// Unknown keys were rejected only at the top level. Nested objects used plain
// z.object(), which strips unknown keys, so `allowedScope` (singular) parsed
// cleanly and the client silently fell back to unrestricted scopes.

function base(): Record<string, unknown> {
  return {
    signingKey: { kid: 'k1' },
    clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'api' }],
    branding: { title: 'T' },
    profiles: [{ id: 'alice', displayName: 'A', email: 'a@x.com', claims: { role: 'admin' } }],
  };
}

function issuePaths(input: unknown): string[] {
  const result = ConfigSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return result.error.issues.flatMap((i) => {
    const keys = 'keys' in i && Array.isArray(i.keys) ? (i.keys as string[]) : [''];
    return keys.map((k) => [...i.path, k].filter((p) => p !== '').join('.'));
  });
}

describe('project config rejects unknown keys in nested objects', () => {
  it('names a misspelled client policy field', () => {
    const cfg = base();
    (cfg.clients as Array<Record<string, unknown>>)[0]!.allowedScope = ['email'];
    expect(issuePaths(cfg)).toContain('clients.0.allowedScope');
  });

  it('names a misspelled clientSecret', () => {
    const cfg = base();
    (cfg.clients as Array<Record<string, unknown>>)[0]!.clientSecert = 'x';
    expect(issuePaths(cfg)).toContain('clients.0.clientSecert');
  });

  it('names an unknown signingKey field', () => {
    const cfg = { ...base(), signingKey: { kid: 'k1', algorithm: 'ES256' } };
    expect(issuePaths(cfg)).toContain('signingKey.algorithm');
  });

  it('names an unknown profile field', () => {
    const cfg = base();
    (cfg.profiles as Array<Record<string, unknown>>)[0]!.emailVerifed = false;
    expect(issuePaths(cfg)).toContain('profiles.0.emailVerifed');
  });

  it('names an unknown branding field', () => {
    const cfg = { ...base(), branding: { title: 'T', accentColour: '#fff' } };
    expect(issuePaths(cfg)).toContain('branding.accentColour');
  });

  it('still accepts arbitrary custom claim names', () => {
    const cfg = base();
    (cfg.profiles as Array<Record<string, unknown>>)[0]!.claims = {
      role: 'admin',
      'https://example.com/tenant': 't1',
      groups: ['a', 'b'],
    };
    expect(ConfigSchema.safeParse(cfg).success).toBe(true);
  });
});
