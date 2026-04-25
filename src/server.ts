import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { createEventsEmitter, registerEventsRoute, type EventsEmitter } from '@/admin/events.js';
import { renderAdminPage } from '@/admin/page.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig, type RuntimeConfig } from '@/config/runtime.js';
import { watchConfig, type ConfigWatcher } from '@/config/watcher.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { registerAuthorize } from '@/oidc/authorize.js';
import { registerComplete } from '@/oidc/complete.js';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';
import { buildJwks } from '@/oidc/jwks.js';
import { createKeyMaterial, type KeyMaterial } from '@/oidc/keys.js';
import { createCodeStore, type CodeStore } from '@/oidc/codes.js';
import { createPendingAuthStore, type PendingAuthStore } from '@/oidc/pending.js';
import { registerToken } from '@/oidc/token.js';
import { registerLogout } from '@/oidc/logout.js';
import { renderIndexPage } from '@/index/page.js';

export interface CreateServerOptions {
  config: Config;
  configFilePath?: string;
  logger?: DevOidcLogger;
}

export interface DevOidcServer {
  app: FastifyInstance;
  runtime: RuntimeConfig;
  keyMaterial: KeyMaterial;
  codes: CodeStore;
  pending: PendingAuthStore;
  close: () => Promise<void>;
}

export async function createDevOidcServer(options: CreateServerOptions): Promise<DevOidcServer> {
  const logger = options.logger ?? createLogger();
  const runtime = createRuntimeConfig(options.config);
  const eventsEmitter: EventsEmitter = createEventsEmitter();
  runtime.onChange(() => eventsEmitter.emit({ type: 'config-changed' }));
  const keyMaterial = await createKeyMaterial(options.config.signingKey);
  const jwksDocument = buildJwks(keyMaterial);
  const codes = createCodeStore({
    ttlMs: 60_000,
    refreshTtlMs: options.config.refreshTokenTtlSeconds * 1_000,
  });
  const pending = createPendingAuthStore({ ttlMs: 10 * 60_000 });

  const app = Fastify({ loggerInstance: logger });

  // Permissive CORS: dev-oidc is a development tool; any localhost origin
  // (Console dev servers, test harnesses, etc.) needs to fetch the discovery
  // doc + JWKS + token endpoints from JavaScript. `origin: true` reflects
  // whatever Origin the browser sent — acceptable for a dev-only service.
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
      issuer: cfg.issuer,
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
      .send(renderIndexPage({ config: runtime.get(), adminEnabled }));
  });

  registerAuthorize(app, {
    getTenant: () => {
      const config = runtime.get();
      return {
        slug: '(legacy)',
        configPath: options.configFilePath ?? '/dev/null',
        status: 'active' as const,
        issuer: config.issuer,
        config,
        runtime,
        keyMaterial,
        jwks: jwksDocument,
        codes,
        pending,
        watcher: null,
      };
    },
  });
  registerComplete(app, {
    getTenant: () => {
      const config = runtime.get();
      return {
        slug: '(legacy)',
        configPath: options.configFilePath ?? '/dev/null',
        status: 'active' as const,
        issuer: config.issuer,
        config,
        runtime,
        keyMaterial,
        jwks: jwksDocument,
        codes,
        pending,
        watcher: null,
      };
    },
  });
  registerToken(app, {
    getTenant: () => {
      const config = runtime.get();
      return {
        slug: '(legacy)',
        configPath: options.configFilePath ?? '/dev/null',
        status: 'active' as const,
        issuer: config.issuer,
        config,
        runtime,
        keyMaterial,
        jwks: jwksDocument,
        codes,
        pending,
        watcher: null,
      };
    },
  });
  registerLogout(app, {
    getTenant: () => {
      const config = runtime.get();
      return {
        slug: '(legacy)',
        configPath: options.configFilePath ?? '/dev/null',
        status: 'active' as const,
        issuer: config.issuer,
        config,
        runtime,
        keyMaterial,
        jwks: jwksDocument,
        codes,
        pending,
        watcher: null,
      };
    },
  });

  if (options.configFilePath) {
    registerProfilesRoutes(app, { runtime, configFilePath: options.configFilePath });
    registerEventsRoute(app, { emitter: eventsEmitter });
    app.get('/admin', async (_request, reply) => {
      return reply.code(200).type('text/html; charset=utf-8').send(renderAdminPage(runtime.get()));
    });
  }

  let watcher: ConfigWatcher | null = null;
  if (options.configFilePath) {
    watcher = await watchConfig(options.configFilePath, {
      onReload: (config) => {
        runtime.set(config);
        logger.info({ issuer: config.issuer }, 'config reloaded');
      },
      onError: (err) => logger.warn({ err }, 'config reload failed; keeping previous config'),
    });
  }

  return {
    app,
    runtime,
    keyMaterial,
    codes,
    pending,
    close: async () => {
      if (watcher) await watcher.close();
      await app.close();
    },
  };
}
