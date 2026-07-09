import { describe, expect, it } from 'vitest';
import { httpUrl } from '@/shared/url-schema.js';

describe('httpUrl', () => {
  it('accepts plain http/https URLs, including query strings by default', () => {
    for (const value of [
      'http://localhost:3000/cb',
      'https://example.com/auth/callback?provider=dev',
    ]) {
      expect(httpUrl().safeParse(value).success).toBe(true);
    }
  });

  it('rejects non-http(s) schemes', () => {
    for (const value of ['javascript:alert(1)', 'ftp://example.com/x', 'file:///etc/passwd']) {
      expect(httpUrl().safeParse(value).success).toBe(false);
    }
  });

  it('rejects embedded credentials', () => {
    expect(httpUrl().safeParse('https://user:pass@example.com/cb').success).toBe(false);
  });

  it('rejects fragments', () => {
    expect(httpUrl().safeParse('https://example.com/cb#frag').success).toBe(false);
  });

  it('rejects strings that are not absolute URLs', () => {
    for (const value of ['', '/relative/path', 'not a url']) {
      expect(httpUrl().safeParse(value).success).toBe(false);
    }
  });

  it('rejects query strings when allowQuery is false', () => {
    expect(httpUrl({ allowQuery: false }).safeParse('https://example.com/?x=1').success).toBe(
      false,
    );
    expect(httpUrl({ allowQuery: false }).safeParse('https://example.com/base').success).toBe(true);
  });
});
