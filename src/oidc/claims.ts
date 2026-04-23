import type { Profile } from '@/config/schema.js';

export interface BuildClaimsInput {
  profile: Profile;
  subjectClaim: string;
}

export type JwtClaims = Record<string, unknown>;

const RESERVED: readonly string[] = ['sub', 'name', 'email', 'iat', 'exp', 'iss', 'aud', 'nonce'];

export function buildClaims({ profile, subjectClaim }: BuildClaimsInput): JwtClaims {
  const filteredCustom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile.claims)) {
    if (!RESERVED.includes(key) && key !== subjectClaim) {
      filteredCustom[key] = value;
    }
  }

  const claims: JwtClaims = {
    ...filteredCustom,
    sub: profile.id,
    name: profile.displayName,
    email: profile.email,
  };

  if (subjectClaim !== 'sub') {
    claims[subjectClaim] = profile.id;
  }

  return claims;
}
