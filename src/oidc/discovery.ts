export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string;
  claims_supported: readonly string[];
  response_types_supported: readonly string[];
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
}

export function buildDiscoveryDocument(input: DiscoveryInput): DiscoveryDocument {
  const issuer = input.issuer.replace(/\/+$/, '');
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    end_session_endpoint: `${issuer}/logout`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    userinfo_endpoint: `${issuer}/userinfo`,
    claims_supported: [
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
    ],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: [input.signingAlg],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: input.authMethods,
  };
}
