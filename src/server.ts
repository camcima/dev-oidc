import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import path from 'node:path';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { createEventsEmitter, registerEventsRoute, type EventsEmitter } from '@/admin/events.js';
import { renderAdminPage } from '@/admin/page.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { watchConfig, type ConfigWatcher } from '@/config/watcher.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { registerAuthorize } from '@/oidc/authorize.js';
import { registerComplete } from '@/oidc/complete.js';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';
import { buildJwks } from '@/oidc/jwks.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { createCodeStore } from '@/oidc/codes.js';
import { createPendingAuthStore } from '@/oidc/pending.js';
import { registerToken } from '@/oidc/token.js';
import { registerLogout } from '@/oidc/logout.js';
import { renderIndexPage } from '@/index/page.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

export interface CreateServerOptions {
  config: Config;
  configFilePath?: string;
  issuer: string; // injected from CLI in legacy mode (Phase 1 introduces flag)
  logger?: DevOidcLogger;
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
    ttlMs: 60_000,
    refreshTtlMs: options.config.refreshTokenTtlSeconds * 1_000,
  });
  const pending = createPendingAuthStore({ ttlMs: 10 * 60_000 });

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
    config: options.config,
    runtime,
    keyMaterial,
    jwks: jwksDocument,
    codes,
    pending,
    watcher,
    issuer: options.issuer,
  };

  const getTenant = (_req: FastifyRequest): ActiveTenantState => tenant;

  const app = Fastify({ loggerInstance: logger });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(formbody);

  app.get('/.well-known/openid-configuration', async () => {
    const cfg = runtime.get();
    const hasSecretClient = cfg.clients.some((c) => c.clientSecret !== undefined);
    const authMethods: ('none' | 'client_secret_post' | 'client_secret_basic')[] = hasSecretClient
      ? ['none', 'client_secret_post', 'client_secret_basic']
      : ['none'];
    return buildDiscoveryDocument({
      issuer: tenant.issuer,
      signingAlg: keyMaterial.alg,
      authMethods,
    });
  });

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
