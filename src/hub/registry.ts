import { EventEmitter } from 'node:events';
import path from 'node:path';
import { loadConfig } from '@/config/loader.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { watchConfig, type ConfigWatcher } from '@/config/watcher.js';
import { createCodeStore } from '@/oidc/codes.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { buildJwks } from '@/oidc/jwks.js';
import type { HubTenantEntry } from '@/hub/schema.js';
import type { ActiveTenantState, ErrorTenantState, TenantState } from '@/hub/tenant-state.js';
import { computeIssuer } from '@/hub/issuer.js';

export interface TenantRegistryEvents {
  on(event: 'added', listener: (payload: { slug: string }) => void): this;
  on(event: 'removed', listener: (payload: { slug: string }) => void): this;
  on(event: 'statusChanged', listener: (payload: { slug: string; status: string }) => void): this;
  on(event: 'profilesChanged', listener: (payload: { slug: string }) => void): this;
  emit(event: string, payload: { slug: string; status?: string }): boolean;
}

export interface TenantRegistry {
  list(): readonly TenantState[];
  get(slug: string): TenantState | undefined;
  add(entry: HubTenantEntry): Promise<void>;
  remove(slug: string): Promise<void>;
  reconcile(entries: readonly HubTenantEntry[]): Promise<void>;
  events: TenantRegistryEvents;
  closeAll(): Promise<void>;
}

export interface CreateTenantRegistryOptions {
  publicUrl: string;
}

export function createTenantRegistry(options: CreateTenantRegistryOptions): TenantRegistry {
  const tenants = new Map<string, TenantState>();
  const events = new EventEmitter() as unknown as TenantRegistryEvents;

  async function activate(entry: HubTenantEntry): Promise<TenantState> {
    const configDir = path.dirname(entry.configPath);
    let config;
    try {
      config = await loadConfig(entry.configPath);
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err);
      const errorState: ErrorTenantState = {
        slug: entry.slug,
        configPath: entry.configPath,
        status: 'error',
        lastError,
      };
      return errorState;
    }

    let keyMaterial;
    try {
      keyMaterial = await createKeyMaterial(config.signingKey, { configDir });
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err);
      return {
        slug: entry.slug,
        configPath: entry.configPath,
        status: 'error',
        lastError,
      };
    }

    const runtime = createRuntimeConfig(config);
    const codes = createCodeStore({
      ttlMs: 60_000,
      refreshTtlMs: config.refreshTokenTtlSeconds * 1_000,
    });
    const pending = createPendingAuthStore({ ttlMs: 10 * 60_000 });
    const jwks = buildJwks(keyMaterial);
    const issuer = computeIssuer({ publicUrl: options.publicUrl, slug: entry.slug });

    let watcher: ConfigWatcher | null = null;
    try {
      watcher = await watchConfig(entry.configPath, {
        onReload: (newConfig) => {
          runtime.set(newConfig);
          events.emit('profilesChanged', { slug: entry.slug });
        },
        onError: () => {
          // Keep last good config; logged elsewhere.
        },
      });
    } catch {
      // Watcher failure is not fatal; log handled at server level.
    }

    runtime.onChange(() => events.emit('profilesChanged', { slug: entry.slug }));

    const active: ActiveTenantState = {
      slug: entry.slug,
      configPath: entry.configPath,
      status: 'active',
      config,
      runtime,
      keyMaterial,
      jwks,
      codes,
      pending,
      watcher,
      issuer,
    };
    return active;
  }

  async function deactivate(state: TenantState): Promise<void> {
    if (state.status === 'active' && state.watcher) {
      await state.watcher.close();
    }
  }

  return {
    list: () => [...tenants.values()],
    get: (slug) => tenants.get(slug),
    events,
    async add(entry) {
      if (!entry.enabled) return;
      const existing = tenants.get(entry.slug);
      if (existing) await deactivate(existing);
      const state = await activate(entry);
      tenants.set(entry.slug, state);
      events.emit('added', { slug: entry.slug });
      events.emit('statusChanged', { slug: entry.slug, status: state.status });
    },
    async remove(slug) {
      const existing = tenants.get(slug);
      if (!existing) return;
      await deactivate(existing);
      tenants.delete(slug);
      events.emit('removed', { slug });
    },
    async reconcile(entries) {
      const incomingEnabled = entries.filter((e) => e.enabled);
      const incomingSlugs = new Set(incomingEnabled.map((e) => e.slug));

      // Remove tenants no longer in the list (or now disabled).
      for (const slug of [...tenants.keys()]) {
        if (!incomingSlugs.has(slug)) {
          await this.remove(slug);
        }
      }

      // Add or refresh remaining entries.
      for (const entry of incomingEnabled) {
        const existing = tenants.get(entry.slug);
        if (!existing || existing.configPath !== entry.configPath) {
          await this.add(entry);
        }
      }
    },
    async closeAll() {
      for (const state of tenants.values()) {
        await deactivate(state);
      }
      tenants.clear();
    },
  };
}
