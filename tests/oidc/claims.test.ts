import { describe, expect, it } from 'vitest';
import { assembleClaims } from '@/oidc/claims.js';
import type { Profile } from '@/config/schema.js';

const profile: Profile = {
  id: 'alice-123',
  displayName: 'Alice Dev',
  email: 'alice@example.com',
  avatar: 'https://example.com/a.png',
  emailVerified: true,
  givenName: 'Alice',
  familyName: 'Dev',
  locale: 'en',
  hostedDomain: 'example.com',
  claims: { department: 'Eng', platformRole: 'admin' },
};

describe('assembleClaims', () => {
  it('always emits sub; adds the subjectClaim alias only when not "sub"', () => {
    expect(
      assembleClaims({ profile, subjectClaim: 'sub', scope: 'openid', destination: 'id_token' })
        .sub,
    ).toBe('alice-123');
    expect(
      assembleClaims({ profile, subjectClaim: 'sub', scope: 'openid', destination: 'id_token' })
        .oid,
    ).toBeUndefined();
    const oid = assembleClaims({
      profile,
      subjectClaim: 'oid',
      scope: 'openid',
      destination: 'id_token',
    });
    expect(oid.sub).toBe('alice-123');
    expect(oid.oid).toBe('alice-123');
  });

  it('gates profile-scope claims (name/given_name/family_name/picture/locale)', () => {
    const without = assembleClaims({
      profile,
      subjectClaim: 'sub',
      scope: 'openid',
      destination: 'id_token',
    });
    expect(without.name).toBeUndefined();
    expect(without.given_name).toBeUndefined();
    expect(without.picture).toBeUndefined();
    const withProfile = assembleClaims({
      profile,
      subjectClaim: 'sub',
      scope: 'openid profile',
      destination: 'id_token',
    });
    expect(withProfile.name).toBe('Alice Dev');
    expect(withProfile.given_name).toBe('Alice');
    expect(withProfile.family_name).toBe('Dev');
    expect(withProfile.picture).toBe('https://example.com/a.png');
    expect(withProfile.locale).toBe('en');
  });

  it('gates email-scope claims (email/email_verified) and defaults email_verified to true', () => {
    const withoutEmail = assembleClaims({
      profile,
      subjectClaim: 'sub',
      scope: 'openid',
      destination: 'id_token',
    });
    expect(withoutEmail.email).toBeUndefined();
    expect(withoutEmail.email_verified).toBeUndefined();
    const withEmail = assembleClaims({
      profile,
      subjectClaim: 'sub',
      scope: 'openid email',
      destination: 'id_token',
    });
    expect(withEmail.email).toBe('alice@example.com');
    expect(withEmail.email_verified).toBe(true);

    const unset: Profile = { ...profile, emailVerified: undefined };
    const claims = assembleClaims({
      profile: unset,
      subjectClaim: 'sub',
      scope: 'openid email',
      destination: 'id_token',
    });
    expect(claims.email_verified).toBe(true);
  });

  it('emits hd whenever hostedDomain is set, regardless of scope', () => {
    const claims = assembleClaims({
      profile,
      subjectClaim: 'sub',
      scope: 'openid',
      destination: 'id_token',
    });
    expect(claims.hd).toBe('example.com');
  });

  it('access_token carries sub + custom claims only (no identity claims)', () => {
    const at = assembleClaims({
      profile,
      subjectClaim: 'sub',
      scope: 'openid profile email',
      destination: 'access_token',
    });
    expect(at.sub).toBe('alice-123');
    expect(at.department).toBe('Eng');
    expect(at.platformRole).toBe('admin');
    expect(at.name).toBeUndefined();
    expect(at.email).toBeUndefined();
    expect(at.picture).toBeUndefined();
    expect(at.hd).toBeUndefined();
  });

  it('includes custom claims in id_token and userinfo too', () => {
    for (const destination of ['id_token', 'userinfo'] as const) {
      const claims = assembleClaims({
        profile,
        subjectClaim: 'sub',
        scope: 'openid profile',
        destination,
      });
      expect(claims.department).toBe('Eng');
    }
  });

  it('protects managed claim names from being overridden by profile.claims', () => {
    const hostile: Profile = {
      ...profile,
      claims: {
        sub: 'evil',
        name: 'Evil',
        email: 'evil@x.com',
        picture: 'evil',
        azp: 'evil',
        department: 'Eng',
      },
    };
    const claims = assembleClaims({
      profile: hostile,
      subjectClaim: 'sub',
      scope: 'openid profile email',
      destination: 'id_token',
    });
    expect(claims.sub).toBe('alice-123');
    expect(claims.name).toBe('Alice Dev');
    expect(claims.email).toBe('alice@example.com');
    expect(claims.picture).toBe('https://example.com/a.png');
    expect(claims.azp).toBeUndefined(); // azp is managed/added by token.ts, never from custom claims
    expect(claims.department).toBe('Eng');
  });
});
