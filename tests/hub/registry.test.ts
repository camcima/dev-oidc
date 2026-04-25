import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTenantRegistry } from '@/hub/registry.js';

function tmpProjectConfig(overrides: Partial<{ kid: string; clients: unknown }> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-proj-'));
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: overrides.kid ?? 'k1', alg: 'RS256', source: 'generate' },
      clients: overrides.clients ?? [
        {
          clientId: 'my-app',
          redirectUris: ['http://localhost:5173/cb'],
          audience: 'my-api',
        },
      ],
      profiles: [],
    }),
  );
  return file;
}

describe('TenantRegistry', () => {
  it('starts empty', () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    expect(reg.list()).toEqual([]);
    expect(reg.get('app')).toBeUndefined();
  });

  it('activates a valid tenant on add', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const cfgPath = tmpProjectConfig();

    await reg.add({ slug: 'app', configPath: cfgPath, enabled: true });

    const tenant = reg.get('app');
    expect(tenant?.status).toBe('active');
    expect(tenant?.slug).toBe('app');
    if (tenant?.status === 'active') {
      expect(tenant.issuer).toBe('http://localhost:8095/app');
      expect(tenant.config.clients[0]!.clientId).toBe('my-app');
    }
  });

  it('places a tenant in error state when its config is invalid JSON', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const cfgPath = path.join(dir, 'bad.json');
    writeFileSync(cfgPath, 'not valid json');

    await reg.add({ slug: 'broken', configPath: cfgPath, enabled: true });

    const tenant = reg.get('broken');
    expect(tenant?.status).toBe('error');
    if (tenant?.status === 'error') {
      expect(tenant.lastError).toMatch(/invalid JSON|JSON/);
    }
  });

  it('places a tenant in error state when its config fails Zod validation', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-bad-'));
    const cfgPath = path.join(dir, 'bad.json');
    writeFileSync(cfgPath, JSON.stringify({ signingKey: { kid: 'k' }, clients: [] }));

    await reg.add({ slug: 'broken', configPath: cfgPath, enabled: true });

    const tenant = reg.get('broken');
    expect(tenant?.status).toBe('error');
  });

  it('removes a tenant', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    await reg.add({ slug: 'app', configPath: tmpProjectConfig(), enabled: true });
    await reg.remove('app');
    expect(reg.get('app')).toBeUndefined();
  });

  it('add is idempotent: existing slug is replaced', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const first = tmpProjectConfig({ kid: 'first' });
    const second = tmpProjectConfig({ kid: 'second' });

    await reg.add({ slug: 'app', configPath: first, enabled: true });
    await reg.add({ slug: 'app', configPath: second, enabled: true });

    const tenant = reg.get('app');
    if (tenant?.status === 'active') {
      expect(tenant.keyMaterial.kid).toBe('second');
    } else {
      throw new Error('expected active');
    }
  });

  it('skips disabled tenants on add (does not activate, does not store)', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    await reg.add({ slug: 'app', configPath: tmpProjectConfig(), enabled: false });
    expect(reg.get('app')).toBeUndefined();
  });
});

describe('TenantRegistry.reconcile', () => {
  it('retries an error tenant on the next reconcile after the config is fixed', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const dir = mkdtempSync(path.join(tmpdir(), 'dev-oidc-fix-'));
    const cfgPath = path.join(dir, 'dev-oidc.config.json');
    // Initially invalid
    writeFileSync(cfgPath, 'not valid json');

    await reg.reconcile([{ slug: 'app', configPath: cfgPath, enabled: true }]);
    expect(reg.get('app')?.status).toBe('error');

    // User fixes the config on disk
    writeFileSync(
      cfgPath,
      JSON.stringify({
        signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
        clients: [{ clientId: 'app', redirectUris: ['http://localhost/cb'], audience: 'a' }],
        profiles: [],
      }),
    );

    // Same hub.json contents — only the project config changed. Reconcile
    // should still retry the error tenant.
    await reg.reconcile([{ slug: 'app', configPath: cfgPath, enabled: true }]);
    expect(reg.get('app')?.status).toBe('active');
  });

  it('adds new entries, removes missing entries, replaces changed configPath', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const cfgA = tmpProjectConfig({ kid: 'a' });
    const cfgB = tmpProjectConfig({ kid: 'b' });
    const cfgC = tmpProjectConfig({ kid: 'c' });

    await reg.reconcile([
      { slug: 'a', configPath: cfgA, enabled: true },
      { slug: 'b', configPath: cfgB, enabled: true },
    ]);
    expect(reg.list()).toHaveLength(2);

    // Remove b, keep a, add c
    await reg.reconcile([
      { slug: 'a', configPath: cfgA, enabled: true },
      { slug: 'c', configPath: cfgC, enabled: true },
    ]);
    expect(reg.get('a')?.status).toBe('active');
    expect(reg.get('b')).toBeUndefined();
    expect(reg.get('c')?.status).toBe('active');
  });
});

describe('TenantRegistry isolation under concurrent add/remove', () => {
  it('serializes concurrent add() calls for the same slug', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const first = tmpProjectConfig({ kid: 'first' });
    const second = tmpProjectConfig({ kid: 'second' });

    // Fire both adds without awaiting between — only the per-slug mutex
    // prevents a partial state where neither lands.
    await Promise.all([
      reg.add({ slug: 'app', configPath: first, enabled: true }),
      reg.add({ slug: 'app', configPath: second, enabled: true }),
    ]);

    const tenant = reg.get('app');
    if (tenant?.status !== 'active') throw new Error('expected active');
    // The second add wins (last-writer-wins serialized through the mutex).
    expect(tenant.keyMaterial.kid).toBe('second');
    // No tenants should be left in a half-activated state.
    expect(reg.list()).toHaveLength(1);
  });

  it('a request resolved to the previous tenant continues to use that state after a swap', async () => {
    // The new add() must produce a fully-activated state and only then swap
    // it into the map; the old reference handed out before the swap remains
    // valid (its watcher closes asynchronously, but the captured stores and
    // key material continue to function for the duration of the in-flight
    // request). This test asserts the captured reference does not get
    // mutated in place during the swap.
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const first = tmpProjectConfig({ kid: 'first' });
    const second = tmpProjectConfig({ kid: 'second' });

    await reg.add({ slug: 'app', configPath: first, enabled: true });
    const captured = reg.get('app');
    if (captured?.status !== 'active') throw new Error('expected active');
    const capturedKid = captured.keyMaterial.kid;

    await reg.add({ slug: 'app', configPath: second, enabled: true });

    // The captured reference's keyMaterial is still the original — the new
    // state is a different object that the map now points to.
    expect(captured.keyMaterial.kid).toBe(capturedKid);
    expect(capturedKid).toBe('first');
    const fresh = reg.get('app');
    if (fresh?.status !== 'active') throw new Error('expected active');
    expect(fresh.keyMaterial.kid).toBe('second');
    expect(fresh).not.toBe(captured);
  });
});

describe('TenantRegistry events', () => {
  it('emits added on activation', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const events: string[] = [];
    reg.events.on('added', ({ slug }) => events.push(`added:${slug}`));

    await reg.add({ slug: 'app', configPath: tmpProjectConfig(), enabled: true });
    expect(events).toContain('added:app');
  });

  it('emits removed on remove', async () => {
    const reg = createTenantRegistry({ publicUrl: 'http://localhost:8095' });
    const events: string[] = [];
    reg.events.on('removed', ({ slug }) => events.push(`removed:${slug}`));

    await reg.add({ slug: 'app', configPath: tmpProjectConfig(), enabled: true });
    await reg.remove('app');
    expect(events).toContain('removed:app');
  });
});
