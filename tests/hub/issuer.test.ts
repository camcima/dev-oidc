import { describe, expect, it } from 'vitest';
import { computeIssuer, deriveDefaultPublicUrl } from '@/hub/issuer.js';

describe('computeIssuer', () => {
  it('joins publicUrl and slug with a single slash', () => {
    expect(computeIssuer({ publicUrl: 'http://localhost:8095', slug: 'app' })).toBe(
      'http://localhost:8095/app',
    );
  });

  it('strips a trailing slash on publicUrl', () => {
    expect(computeIssuer({ publicUrl: 'http://localhost:8095/', slug: 'app' })).toBe(
      'http://localhost:8095/app',
    );
  });

  it('strips multiple trailing slashes', () => {
    expect(computeIssuer({ publicUrl: 'http://localhost:8095///', slug: 'app' })).toBe(
      'http://localhost:8095/app',
    );
  });

  it('preserves a path component on publicUrl', () => {
    expect(computeIssuer({ publicUrl: 'https://idp.example.com/oidc', slug: 'app' })).toBe(
      'https://idp.example.com/oidc/app',
    );
  });
});

describe('deriveDefaultPublicUrl', () => {
  it('returns http://host:port', () => {
    expect(deriveDefaultPublicUrl({ host: '127.0.0.1', port: 8095 })).toBe('http://127.0.0.1:8095');
  });
});
