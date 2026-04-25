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
});
