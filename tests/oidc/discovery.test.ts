import { describe, expect, it } from 'vitest';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';

describe('buildDiscoveryDocument', () => {
  it('returns a conformant doc with all required endpoints', () => {
    const doc = buildDiscoveryDocument({ issuer: 'http://localhost:8095' });
    expect(doc.issuer).toBe('http://localhost:8095');
    expect(doc.authorization_endpoint).toBe('http://localhost:8095/authorize');
    expect(doc.token_endpoint).toBe('http://localhost:8095/token');
    expect(doc.end_session_endpoint).toBe('http://localhost:8095/logout');
    expect(doc.jwks_uri).toBe('http://localhost:8095/.well-known/jwks.json');
    expect(doc.response_types_supported).toContain('code');
    expect(doc.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    );
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256']);
  });

  it('strips trailing slashes from issuer', () => {
    const doc = buildDiscoveryDocument({ issuer: 'http://localhost:8095/' });
    expect(doc.issuer).toBe('http://localhost:8095');
  });
});
