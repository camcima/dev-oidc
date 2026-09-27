import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminAllowedHosts, registerAdminGuard } from '@/admin/guard.js';

describe('buildAdminAllowedHosts', () => {
  it('includes the configured listen host:port and bare host', () => {
    const allowed = buildAdminAllowedHosts({ listenHost: '127.0.0.1', listenPort: 8095 });
    expect(allowed.has('127.0.0.1:8095')).toBe(true);
    expect(allowed.has('127.0.0.1')).toBe(true);
  });

  it('adds loopback aliases when binding loopback', () => {
    const allowed = buildAdminAllowedHosts({ listenHost: '127.0.0.1', listenPort: 8095 });
    expect(allowed.has('localhost:8095')).toBe(true);
    expect(allowed.has('localhost')).toBe(true);
    expect(allowed.has('[::1]:8095')).toBe(true);
  });

  it('adds loopback aliases when binding bind-all', () => {
    const allowed = buildAdminAllowedHosts({ listenHost: '0.0.0.0', listenPort: 8095 });
    expect(allowed.has('localhost:8095')).toBe(true);
    expect(allowed.has('127.0.0.1:8095')).toBe(true);
    // does not add the bind-all host itself
    expect(allowed.has('0.0.0.0:8095')).toBe(false);
  });

  it('honors a configured publicUrl host', () => {
    const allowed = buildAdminAllowedHosts({
      listenHost: '127.0.0.1',
      listenPort: 8095,
      publicUrl: 'https://idp.example.com',
    });
    expect(allowed.has('idp.example.com')).toBe(true);
  });
});

describe('admin guard', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
    registerAdminGuard(app, {
      allowedHosts: buildAdminAllowedHosts({ listenHost: '127.0.0.1', listenPort: 8095 }),
    });
    app.get('/admin/api/test', async () => ({ ok: true }));
    app.get('/some-tenant/.well-known/jwks.json', async () => ({ keys: [] }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows admin requests with same-origin Host', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/test',
      headers: { host: 'localhost:8095' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows the default fastify-inject Host (localhost:80) via :80 normalization', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/test' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects admin requests with a foreign Host (DNS rebinding defense)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/test',
      headers: { host: 'evil.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects admin requests with cross-site Sec-Fetch-Site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/test',
      headers: { host: 'localhost:8095', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects admin requests with foreign Origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/test',
      headers: { host: 'localhost:8095', origin: 'https://evil.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts admin requests with same-origin Origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/test',
      headers: { host: 'localhost:8095', origin: 'http://localhost:8095' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not block non-admin (OIDC) routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/some-tenant/.well-known/jwks.json',
      headers: { host: 'evil.com', origin: 'https://evil.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not match sibling paths beginning with the literal "admin"', async () => {
    // `/administer` and `/admin-foo` should NOT trigger the guard. We
    // register a probe route and verify it serves with a foreign Host —
    // the guard would have rejected if it had matched.
    app.get('/administer', async () => ({ ok: true }));
    app.get('/admin-foo', async () => ({ ok: true }));
    for (const url of ['/administer', '/admin-foo']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { host: 'evil.com', origin: 'https://evil.com' },
      });
      expect(res.statusCode, url).toBe(200);
    }
  });

  // Fastify's router decodes percent-escapes before matching, so a guard that
  // compared the raw URL let `/%61dmin/...` reach admin handlers unchecked.
  it.each([
    '/%61dmin/api/test',
    '/adm%69n/api/test',
    '/%61%64%6d%69%6e/api/test',
    '/admin/%61pi/test',
    '/%41dmin/api/test',
  ])('rejects a foreign Host on the percent-encoded admin path %s', async (url) => {
    app.post('/admin/api/test', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { host: 'evil.test', origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).not.toBe(200);
  });

  it('rejects cross-site Fetch Metadata on an encoded admin path with an allowed Host', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/%61dmin/api/test',
      headers: { host: 'localhost:8095', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('still matches /admin with a query string', async () => {
    app.get('/admin', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/admin?foo=bar',
      headers: { host: 'evil.com' },
    });
    expect(res.statusCode).toBe(403);
  });
});
