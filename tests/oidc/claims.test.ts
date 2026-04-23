import { describe, expect, it } from 'vitest';
import { buildClaims } from '@/oidc/claims.js';

const profile = {
  id: 'alice-123',
  displayName: 'Alice',
  email: 'alice@example.com',
  avatar: null,
  claims: { department: 'Eng', platformRole: 'admin' },
};

describe('buildClaims', () => {
  it('uses "sub" by default', () => {
    const claims = buildClaims({ profile, subjectClaim: 'sub' });
    expect(claims.sub).toBe('alice-123');
    expect(claims.oid).toBeUndefined();
  });

  it('honors custom subjectClaim like "oid" (Entra-compat)', () => {
    const claims = buildClaims({ profile, subjectClaim: 'oid' });
    expect(claims.oid).toBe('alice-123');
    expect(claims.sub).toBe('alice-123');
  });

  it('emits email and name', () => {
    const claims = buildClaims({ profile, subjectClaim: 'sub' });
    expect(claims.email).toBe('alice@example.com');
    expect(claims.name).toBe('Alice');
  });

  it('merges arbitrary custom claims', () => {
    const claims = buildClaims({ profile, subjectClaim: 'sub' });
    expect(claims.department).toBe('Eng');
    expect(claims.platformRole).toBe('admin');
  });

  it('reserved claim names in profile.claims cannot overwrite sub/name/email', () => {
    const hostile = {
      ...profile,
      claims: { sub: 'evil', name: 'Evil', email: 'evil@example.com', department: 'Eng' },
    };
    const claims = buildClaims({ profile: hostile, subjectClaim: 'sub' });
    expect(claims.sub).toBe('alice-123');
    expect(claims.name).toBe('Alice');
    expect(claims.email).toBe('alice@example.com');
    expect(claims.department).toBe('Eng');
  });
});
