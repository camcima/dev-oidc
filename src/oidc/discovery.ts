export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string;
  claims_supported: readonly string[];
  response_types_supported: readonly string[];
  response_modes_supported: readonly string[];
  grant_types_supported: readonly string[];
  subject_types_supported: readonly string[];
  code_challenge_methods_supported: readonly string[];
  id_token_signing_alg_values_supported: readonly string[];
  scopes_supported: readonly string[];
  token_endpoint_auth_methods_supported: readonly string[];
}

export interface DiscoveryInput {
  issuer: string;
  signingAlg: 'RS256' | 'ES256';
  authMethods: readonly ('none' | 'client_secret_post' | 'client_secret_basic')[];
  // The configured subject claim. When not "sub" (e.g. "oid" for Entra), it is
  // emitted as a subject-identifier alias and advertised in claims_supported.
  subjectClaim?: string;
}

export function buildDiscoveryDocument(input: DiscoveryInput): DiscoveryDocument {
  const issuer = input.issuer.replace(/\/+$/, '');
  const claimsSupported = [
    'sub',
    'name',
    'given_name',
    'family_name',
    'picture',
    'locale',
    'email',
    'email_verified',
    'hd',
    'aud',
    'iss',
    'iat',
    'exp',
    'nonce',
    'azp',
    'at_hash',
    'auth_time',
    'scope',
  ];
  const subjectClaim = input.subjectClaim ?? 'sub';
  if (subjectClaim !== 'sub' && !claimsSupported.includes(subjectClaim)) {
    claimsSupported.push(subjectClaim);
  }
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    end_session_endpoint: `${issuer}/logout`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    userinfo_endpoint: `${issuer}/userinfo`,
    claims_supported: claimsSupported,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    subject_types_supported: ['public'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: [input.signingAlg],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: input.authMethods,
  };
}
