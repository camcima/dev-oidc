import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultCertCacheDir, defaultTlsHostnames } from '@/shared/paths.js';

const originalXdg = process.env.XDG_CACHE_HOME;

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdg;
});

describe('defaultCertCacheDir', () => {
  it('honours XDG_CACHE_HOME when set', () => {
    process.env.XDG_CACHE_HOME = '/custom/cache';
    expect(defaultCertCacheDir()).toBe(path.join('/custom/cache', 'dev-oidc', 'certs'));
  });

  it('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
    delete process.env.XDG_CACHE_HOME;
    expect(defaultCertCacheDir()).toBe(path.join(os.homedir(), '.cache', 'dev-oidc', 'certs'));
  });

  it('ignores a blank XDG_CACHE_HOME', () => {
    process.env.XDG_CACHE_HOME = '   ';
    expect(defaultCertCacheDir()).toBe(path.join(os.homedir(), '.cache', 'dev-oidc', 'certs'));
  });
});

describe('defaultTlsHostnames', () => {
  it('always includes the listen host and localhost', () => {
    expect(defaultTlsHostnames('127.0.0.1')).toEqual(['127.0.0.1', 'localhost']);
  });

  it('adds the publicUrl hostname as a SAN', () => {
    expect(defaultTlsHostnames('127.0.0.1', 'https://idp.example.test:8443')).toEqual([
      '127.0.0.1',
      'localhost',
      'idp.example.test',
    ]);
  });

  it('does not duplicate a hostname it already has', () => {
    expect(defaultTlsHostnames('localhost', 'http://localhost:8095')).toEqual(['localhost']);
  });

  it('ignores an unparseable publicUrl rather than throwing', () => {
    expect(defaultTlsHostnames('127.0.0.1', 'not a url')).toEqual(['127.0.0.1', 'localhost']);
  });
});
