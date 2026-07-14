import type { Profile } from '@/config/schema.js';

export type ClaimDestination = 'id_token' | 'userinfo' | 'access_token';

export interface AssembleClaimsInput {
  profile: Profile;
  subjectClaim: string;
  scope: string;
  destination: ClaimDestination;
}

export type JwtClaims = Record<string, unknown>;

// Names dev-oidc manages itself; profile.claims and subjectClaim may never
// set these ("sub" is the one subjectClaim exception).
export const RESERVED_CLAIM_NAMES: readonly string[] = [
  'sub',
  'name',
  'given_name',
  'family_name',
  'picture',
  'locale',
  'email',
  'email_verified',
  'hd',
  'iat',
  'exp',
  'iss',
  'aud',
  'nonce',
  'azp',
  'at_hash',
  'auth_time',
  'scope',
];

const STANDARD_CLAIMS_BY_SCOPE: Record<string, readonly string[]> = {
  profile: ['name', 'given_name', 'family_name', 'picture', 'locale'],
  email: ['email', 'email_verified'],
};

// Map a profile to its standard OIDC claim values. Only present values are
// emitted; `email_verified` defaults to true (Google always sends it).
function projectProfile(profile: Profile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: profile.displayName,
    email: profile.email,
    email_verified: profile.emailVerified ?? true,
  };
  if (profile.givenName !== undefined) out.given_name = profile.givenName;
  if (profile.familyName !== undefined) out.family_name = profile.familyName;
  if (profile.avatar !== null && profile.avatar !== undefined) out.picture = profile.avatar;
  if (profile.locale !== undefined) out.locale = profile.locale;
  return out;
}

export function assembleClaims({
  profile,
  subjectClaim,
  scope,
  destination,
}: AssembleClaimsInput): JwtClaims {
  const claims: JwtClaims = {};

  // Custom claims first (filtered), so managed claims always win.
  for (const [key, value] of Object.entries(profile.claims)) {
    if (!RESERVED_CLAIM_NAMES.includes(key) && key !== subjectClaim) {
      claims[key] = value;
    }
  }

  // sub (+ alias) for every destination.
  claims.sub = profile.id;
  if (subjectClaim !== 'sub') {
    claims[subjectClaim] = profile.id;
  }

  if (destination === 'access_token') {
    return claims; // lean: sub + alias + custom claims only
  }

  // id_token / userinfo: scope-gated standard identity claims.
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  const projected = projectProfile(profile);
  for (const [scopeName, claimNames] of Object.entries(STANDARD_CLAIMS_BY_SCOPE)) {
    if (!granted.has(scopeName)) continue;
    for (const claimName of claimNames) {
      if (projected[claimName] !== undefined) {
        claims[claimName] = projected[claimName];
      }
    }
  }

  // hd is ungated: Google emits it unconditionally when the account has one.
  if (profile.hostedDomain !== undefined) {
    claims.hd = profile.hostedDomain;
  }

  return claims;
}
