import { describe, expect, it } from 'vitest';
import {
  computeIssuer,
  deriveDefaultPublicUrl,
  formatHostPort,
  isBindAllHost,
  pickRedirectHost,
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
  it('returns http://host:port when tls is not enabled', () => {
    expect(deriveDefaultPublicUrl({ host: '127.0.0.1', port: 8095 })).toBe('http://127.0.0.1:8095');
  });

  it('returns http://host:port when tlsEnabled is explicitly false', () => {
    expect(deriveDefaultPublicUrl({ host: '127.0.0.1', port: 8095, tlsEnabled: false })).toBe(
      'http://127.0.0.1:8095',
    );
  });

  it('returns https://host:port when tlsEnabled is true', () => {
    expect(deriveDefaultPublicUrl({ host: '127.0.0.1', port: 8095, tlsEnabled: true })).toBe(
      'https://127.0.0.1:8095',
    );
  });

  it('brackets an IPv6 loopback host', () => {
    expect(deriveDefaultPublicUrl({ host: '::1', port: 8095 })).toBe('http://[::1]:8095');
  });
});

describe('formatHostPort', () => {
  it('joins an IPv4/hostname host with its port directly', () => {
    expect(formatHostPort('127.0.0.1', 8095)).toBe('127.0.0.1:8095');
    expect(formatHostPort('localhost', 8095)).toBe('localhost:8095');
  });

  it('wraps a bare IPv6 host in brackets', () => {
    expect(formatHostPort('::1', 8095)).toBe('[::1]:8095');
    expect(formatHostPort('fe80::1', 3000)).toBe('[fe80::1]:3000');
  });

  it('does not double-bracket an already-bracketed IPv6 host', () => {
    expect(formatHostPort('[::1]', 8095)).toBe('[::1]:8095');
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

describe('pickRedirectHost', () => {
  it('echoes the request Host when it matches the listen host:port', () => {
    expect(
      pickRedirectHost({
        requestHost: '127.0.0.1:8095',
        publicUrl: undefined,
        listenHost: '127.0.0.1',
        listenPort: 8095,
      }),
    ).toBe('127.0.0.1:8095');
  });

  it('echoes the request Host when it matches the publicUrl host', () => {
    expect(
      pickRedirectHost({
        requestHost: 'idp.example.test:8095',
        publicUrl: 'https://idp.example.test:8095',
        listenHost: '0.0.0.0',
        listenPort: 8095,
      }),
    ).toBe('idp.example.test:8095');
  });

  it('rejects an attacker-controlled Host header and falls back to publicUrl host', () => {
    expect(
      pickRedirectHost({
        requestHost: 'evil.example.com',
        publicUrl: 'https://idp.example.test:8095',
        listenHost: '127.0.0.1',
        listenPort: 8095,
      }),
    ).toBe('idp.example.test:8095');
  });

  it('falls back to listenHost:listenPort when no publicUrl and Host is not allowlisted', () => {
    expect(
      pickRedirectHost({
        requestHost: 'evil.example.com',
        publicUrl: undefined,
        listenHost: '127.0.0.1',
        listenPort: 8095,
      }),
    ).toBe('127.0.0.1:8095');
  });

  it('substitutes 127.0.0.1 when bound to 0.0.0.0 with no publicUrl', () => {
    expect(
      pickRedirectHost({
        requestHost: 'evil.example.com',
        publicUrl: undefined,
        listenHost: '0.0.0.0',
        listenPort: 8095,
      }),
    ).toBe('127.0.0.1:8095');
  });

  it('handles an undefined Host header by falling back', () => {
    expect(
      pickRedirectHost({
        requestHost: undefined,
        publicUrl: 'https://idp.example.test:8095',
        listenHost: '127.0.0.1',
        listenPort: 8095,
      }),
    ).toBe('idp.example.test:8095');
  });

  it('ignores an unparseable publicUrl gracefully', () => {
    expect(
      pickRedirectHost({
        requestHost: 'evil.example.com',
        publicUrl: 'not a url',
        listenHost: '127.0.0.1',
        listenPort: 8095,
      }),
    ).toBe('127.0.0.1:8095');
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
