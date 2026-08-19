import { describe, expect, it } from 'vitest';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';

describe('buildDiscoveryDocument', () => {
  it('returns a conformant doc with all required endpoints', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none'],
    });
    expect(doc.issuer).toBe('http://localhost:8095');
    expect(doc.authorization_endpoint).toBe('http://localhost:8095/authorize');
    expect(doc.token_endpoint).toBe('http://localhost:8095/token');
    expect(doc.end_session_endpoint).toBe('http://localhost:8095/logout');
    expect(doc.jwks_uri).toBe('http://localhost:8095/.well-known/jwks.json');
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('reflects ES256 when configured', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'ES256',
      authMethods: ['none'],
    });
    expect(doc.id_token_signing_alg_values_supported).toEqual(['ES256']);
  });

  it('reflects client-secret auth methods', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none', 'client_secret_post', 'client_secret_basic'],
    });
    expect(doc.token_endpoint_auth_methods_supported).toContain('client_secret_basic');
  });

  it('strips trailing slashes from issuer', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095/',
      signingAlg: 'RS256',
      authMethods: ['none'],
    });
    expect(doc.issuer).toBe('http://localhost:8095');
  });

  it('advertises userinfo_endpoint and claims_supported', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none'],
    });
    expect(doc.userinfo_endpoint).toBe('http://localhost:8095/userinfo');
    expect(doc.claims_supported).toContain('sub');
    expect(doc.claims_supported).toContain('email_verified');
    expect(doc.claims_supported).toContain('at_hash');
    expect(doc.claims_supported).toContain('hd');
  });

  it('advertises the subject alias in claims_supported when subjectClaim != "sub"', () => {
    const oid = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none'],
      subjectClaim: 'oid',
    });
    expect(oid.claims_supported).toContain('oid');

    const dflt = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none'],
      subjectClaim: 'sub',
    });
    // "sub" is already present exactly once; no duplicate alias appended.
    expect(dflt.claims_supported.filter((c) => c === 'sub')).toHaveLength(1);
  });
});

describe('discovery advertises the full grant and response-mode surface', () => {
  it('lists client_credentials among the supported grant types', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none'],
    });
    expect(doc.grant_types_supported).toContain('client_credentials');
  });

  it('advertises response_modes_supported so clients need not guess', () => {
    const doc = buildDiscoveryDocument({
      issuer: 'http://localhost:8095',
      signingAlg: 'RS256',
      authMethods: ['none'],
    });
    expect(doc.response_modes_supported).toEqual(['query']);
  });
});
