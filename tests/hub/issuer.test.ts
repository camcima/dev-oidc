import { describe, expect, it } from 'vitest';
import {
  computeIssuer,
  deriveDefaultPublicUrl,
  isBindAllHost,
  requirePublicUrlOrSafeHost,
} from '@/hub/issuer.js';

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

describe('isBindAllHost', () => {
  it.each(['0.0.0.0', '::', '0::', '[::]', '[::0]', '0:0:0:0:0:0:0:0'])('flags %s', (host) => {
    expect(isBindAllHost(host)).toBe(true);
  });

  it.each(['127.0.0.1', 'localhost', '::1', '192.168.1.10'])('does not flag %s', (host) => {
    expect(isBindAllHost(host)).toBe(false);
  });
});

describe('requirePublicUrlOrSafeHost', () => {
  it('throws when binding bind-all without an explicit publicUrl', () => {
    expect(() => requirePublicUrlOrSafeHost({ host: '0.0.0.0' })).toThrow(/refusing to start/i);
    expect(() => requirePublicUrlOrSafeHost({ host: '::' })).toThrow(/refusing to start/i);
  });

  it('passes when binding bind-all but publicUrl is configured', () => {
    expect(() =>
      requirePublicUrlOrSafeHost({ host: '0.0.0.0', publicUrl: 'http://idp.dev:8095' }),
    ).not.toThrow();
  });

  it('passes for loopback hosts even without publicUrl', () => {
    expect(() => requirePublicUrlOrSafeHost({ host: '127.0.0.1' })).not.toThrow();
    expect(() => requirePublicUrlOrSafeHost({ host: 'localhost' })).not.toThrow();
  });
});
