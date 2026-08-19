import type { FastifyInstance, FastifyRequest } from 'fastify';
import { stripTrailingSlash } from '@/hub/issuer.js';
import { configuredOrigins } from '@/server/cors.js';
import { buildTenantDiscovery, createBaseApp } from '@/server/base.js';
import path from 'node:path';
import { createEventsEmitter, registerEventsRoute, type EventsEmitter } from '@/admin/events.js';
import { renderAdminPage } from '@/admin/page.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { watchConfig, type ConfigWatcher } from '@/config/watcher.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { registerAuthorize } from '@/oidc/authorize.js';
import { registerComplete } from '@/oidc/complete.js';
import { buildJwks } from '@/oidc/jwks.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { createCodeStore, DEFAULT_CODE_TTL_MS } from '@/oidc/codes.js';
import { createPendingAuthStore, DEFAULT_PENDING_TTL_MS } from '@/oidc/pending.js';
import { registerToken } from '@/oidc/token.js';
import { registerLogout } from '@/oidc/logout.js';
import { registerUserInfo } from '@/oidc/userinfo.js';
import { renderIndexPage } from '@/index/page.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

export interface CreateServerOptions {
  config: Config;
  configFilePath?: string;
  /**
   * Issuer URL advertised in the discovery document and embedded as `iss`
   * in JWTs. When omitted, derived from `publicUrl` (preferred) or
   * `http://${listenHost}:${listenPort}`. Pass an explicit value for
   * production-like setups where the URL the relying party uses to fetch
   * discovery differs from the listen address.
   */
  issuer?: string;
  /**
   * Listen host & port. Used to build the admin Host-header allowlist (CSRF
   * + DNS rebinding defense) and as the fallback for the issuer. The CLI
   * passes the same values it uses for `app.listen`. Defaults are
   * `127.0.0.1` and `8095` so test callers that use `app.inject` without
   * binding don't need to pass these.
   */
  listenHost?: string;
  listenPort?: number;
  publicUrl?: string;
  logger?: DevOidcLogger;
  /**
   * When set, dev-oidc serves HTTPS (and same-port HTTP→HTTPS 308 redirect)
   * using the provided cert/key. Loaded by `loadTlsMaterial` upstream.
   */
  tls?: { cert: Buffer; key: Buffer };
}

function deriveIssuer(options: CreateServerOptions): string {
  if (options.issuer) return stripTrailingSlash(options.issuer);
  if (options.publicUrl) return stripTrailingSlash(options.publicUrl);
  const host = options.listenHost ?? '127.0.0.1';
  const port = options.listenPort ?? 8095;
  const scheme = options.tls ? 'https' : 'http';
  return `${scheme}://${host}:${port.toString()}`;
}

export interface DevOidcServer {
  app: FastifyInstance;
  tenant: ActiveTenantState;
  close: () => Promise<void>;
}

export async function createDevOidcServer(options: CreateServerOptions): Promise<DevOidcServer> {
  const logger = options.logger ?? createLogger();
  const runtime = createRuntimeConfig(options.config);
  const eventsEmitter: EventsEmitter = createEventsEmitter();
  runtime.onChange(() => eventsEmitter.emit({ type: 'config-changed', slug: '(legacy)' }));

  const configDir = options.configFilePath
    ? path.dirname(path.resolve(options.configFilePath))
    : process.cwd();
  const keyMaterial = await createKeyMaterial(options.config.signingKey, { configDir });
  const jwksDocument = buildJwks(keyMaterial);

  const codes = createCodeStore({
    ttlMs: DEFAULT_CODE_TTL_MS,
    refreshTtlMs: () => runtime.get().refreshTokenTtlSeconds * 1_000,
  });
  const pending = createPendingAuthStore({ ttlMs: DEFAULT_PENDING_TTL_MS });

  let watcher: ConfigWatcher | null = null;
  if (options.configFilePath) {
    watcher = await watchConfig(options.configFilePath, {
      onReload: (config) => {
        runtime.set(config);
        logger.info({ slug: '(legacy)' }, 'config reloaded');
      },
      onError: (err) => logger.warn({ err }, 'config reload failed; keeping previous config'),
    });
  }

  const tenant: ActiveTenantState = {
    slug: '(legacy)',
    configPath: options.configFilePath ?? '',
    status: 'active',
    runtime,
    keyMaterial,
    jwks: jwksDocument,
    codes,
    pending,
    watcher,
    issuer: deriveIssuer(options),
  };

  const getTenant = (_req: FastifyRequest): ActiveTenantState => tenant;

  const listenHost = options.listenHost ?? '127.0.0.1';
  const listenPort = options.listenPort ?? 8095;
  const app = await createBaseApp({
    logger,
    listenHost,
    listenPort,
    publicUrl: options.publicUrl,
    tls: options.tls,
    corsOrigins: () => configuredOrigins([runtime.get()], options.publicUrl ?? tenant.issuer),
  });

  app.get('/.well-known/openid-configuration', async () => buildTenantDiscovery(tenant));

  app.get('/.well-known/jwks.json', async () => jwksDocument);

  app.get('/', async (_request, reply) => {
    const adminEnabled = Boolean(options.configFilePath);
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(renderIndexPage({ tenant, adminEnabled }));
  });

  registerAuthorize(app, { getTenant });
  registerComplete(app, { getTenant });
  registerToken(app, { getTenant });
  registerLogout(app, { getTenant });
  registerUserInfo(app, { getTenant });

  if (options.configFilePath) {
    registerProfilesRoutes(app, { getTenant });
    registerEventsRoute(app, { emitter: eventsEmitter });
    app.get('/admin', async (_request, reply) => {
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(renderAdminPage({ config: runtime.get(), slug: '(legacy)' }));
    });
  }

  return {
    app,
    tenant,
    close: async () => {
      if (watcher) await watcher.close();
      await app.close();
    },
  };
}
