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
import { createLogger, type DevOidcLogger } from '@/logger.js';

export type TenantRegistryEventMap = {
  added: { slug: string };
  removed: { slug: string };
  statusChanged: { slug: string; status: 'active' | 'error' };
  profilesChanged: { slug: string };
};

export type TenantRegistryEventName = keyof TenantRegistryEventMap;

export interface TenantRegistryEvents {
  on<E extends TenantRegistryEventName>(
    event: E,
    listener: (payload: TenantRegistryEventMap[E]) => void,
  ): this;
  off<E extends TenantRegistryEventName>(
    event: E,
    listener: (payload: TenantRegistryEventMap[E]) => void,
  ): this;
  emit<E extends TenantRegistryEventName>(event: E, payload: TenantRegistryEventMap[E]): boolean;
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
  logger?: DevOidcLogger;
}

export function createTenantRegistry(options: CreateTenantRegistryOptions): TenantRegistry {
  const tenants = new Map<string, TenantState>();
  // Construction note: Node's EventEmitter is structurally compatible with
  // the typed `TenantRegistryEvents` interface — same on/off/emit shape,
  // just looser parameter types. We narrow at the boundary so callers see
  // a fully typed surface.
  const events: TenantRegistryEvents = new EventEmitter();
  const logger = options.logger ?? createLogger();

  // Per-slug mutex: serializes add/remove for the same slug so concurrent
  // reconcile invocations or competing CLI mutations cannot interleave the
  // load → activate → swap → deactivate sequence.
  const slugLocks = new Map<string, Promise<unknown>>();

  function withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = slugLocks.get(slug) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    slugLocks.set(
      slug,
      result.catch(() => undefined),
    );
    return result;
  }

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
        onError: (err) => {
          logger.warn(
            { slug: entry.slug, configPath: entry.configPath, err },
            'tenant config reload failed; keeping last known good',
          );
        },
      });
    } catch (err) {
      logger.warn(
        { slug: entry.slug, configPath: entry.configPath, err },
        'failed to start tenant config watcher; tenant active but will not hot-reload',
      );
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
      return withSlugLock(entry.slug, async () => {
        // Activate-then-swap: build the new state fully before touching the
        // map, then swap atomically (a single synchronous .set), then close
        // out the previous state. Requests in flight against the old state
        // continue against their captured reference — its watcher and
        // stores remain valid until deactivate() runs. New requests
        // resolve to the new state from the swap onward.
        const state = await activate(entry);
        const previous = tenants.get(entry.slug);
        tenants.set(entry.slug, state);
        if (previous) {
          await deactivate(previous);
        }
        events.emit('added', { slug: entry.slug });
        events.emit('statusChanged', { slug: entry.slug, status: state.status });
      });
    },
    async remove(slug) {
      return withSlugLock(slug, async () => {
        const existing = tenants.get(slug);
        if (!existing) return;
        // Remove from the map before awaiting deactivate so new requests
        // don't resolve to a tenant whose watcher is mid-close.
        tenants.delete(slug);
        await deactivate(existing);
        events.emit('removed', { slug });
      });
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
