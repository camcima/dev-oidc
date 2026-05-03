import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandTildePath } from '@/cli/legacy.js';

describe('expandTildePath', () => {
  it('expands a leading ~/ to the user home directory', () => {
    expect(expandTildePath('~/certs/cert.pem')).toBe(path.join(os.homedir(), 'certs/cert.pem'));
  });

  it('expands a bare ~ to the user home directory', () => {
    expect(expandTildePath('~')).toBe(os.homedir());
  });

  it('leaves an absolute path untouched', () => {
    expect(expandTildePath('/etc/ssl/cert.pem')).toBe('/etc/ssl/cert.pem');
  });

  it('leaves a CWD-relative path untouched', () => {
    expect(expandTildePath('./certs/cert.pem')).toBe('./certs/cert.pem');
    expect(expandTildePath('certs/cert.pem')).toBe('certs/cert.pem');
  });

  it('does not expand a tilde that appears later in the path (no shell semantics)', () => {
    // Shell expands `~user/foo` and `foo/~/bar` differently than `~/foo`. Our
    // implementation only handles the `~/` prefix — embedded tildes are
    // treated as literal characters.
    expect(expandTildePath('foo/~/bar')).toBe('foo/~/bar');
    expect(expandTildePath('~user/foo')).toBe('~user/foo');
  });
});
