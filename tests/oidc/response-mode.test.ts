import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  deliverAuthorizationResponse,
  parseResponseMode,
  type ResponseMode,
} from '@/oidc/response-mode.js';

const REDIRECT = 'http://localhost:5173/cb?x=1';

function appFor(params: Record<string, string>, mode: ResponseMode): FastifyInstance {
  const app = Fastify();
  app.get('/', (_req, reply) => deliverAuthorizationResponse(reply, REDIRECT, params, mode));
  return app;
}

describe('parseResponseMode', () => {
  it('defaults an absent or empty value to query', () => {
    expect(parseResponseMode(undefined)).toBe('query');
    expect(parseResponseMode('')).toBe('query');
  });

  it('accepts query, fragment and form_post', () => {
    expect(parseResponseMode('query')).toBe('query');
    expect(parseResponseMode('fragment')).toBe('fragment');
    expect(parseResponseMode('form_post')).toBe('form_post');
  });

  it('rejects anything else', () => {
    expect(parseResponseMode('bogus')).toBeNull();
    expect(parseResponseMode('query.jwt')).toBeNull();
    expect(parseResponseMode('FRAGMENT')).toBeNull();
  });
});

describe('deliverAuthorizationResponse', () => {
  it('query: appends to the redirect query and keeps existing parameters', async () => {
    const app = appFor({ code: 'c 1', state: 's1' }, 'query');
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/cb?x=1&code=c+1&state=s1');
    await app.close();
  });

  it('fragment: leaves the query untouched and puts the parameters in the fragment', async () => {
    const app = appFor({ code: 'c 1', state: 's1' }, 'fragment');
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/cb?x=1#code=c+1&state=s1');
    await app.close();
  });

  it('form_post: answers an auto-submitting form with no-store headers', async () => {
    const app = appFor({ code: 'abc', state: 's1' }, 'form_post');
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
    expect(res.headers.location).toBeUndefined();
    expect(res.payload).toContain('<form method="post" action="http://localhost:5173/cb?x=1">');
    expect(res.payload).toContain('<input type="hidden" name="code" value="abc">');
    expect(res.payload).toContain('<input type="hidden" name="state" value="s1">');
    expect(res.payload).toContain('document.forms[0].submit()');
    expect(res.payload).toMatch(/<noscript>[\s\S]*<button type="submit">[\s\S]*<\/noscript>/);
    await app.close();
  });

  it('form_post: HTML-escapes every attribute value', async () => {
    const hostile = `"><script>alert(1)</script>'&`;
    const app = appFor({ code: 'abc', state: hostile }, 'form_post');
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.payload).not.toContain('<script>alert(1)</script>');
    expect(res.payload).toContain(
      'name="state" value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&#39;&amp;"',
    );
    await app.close();
  });
});
