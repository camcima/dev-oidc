import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import path from 'node:path';
import type { RequestListener, Server as HttpServer } from 'node:http';
import type { TLSSocket } from 'node:tls';
import httpolyglot from '@httptoolkit/httpolyglot';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { createEventsEmitter, registerEventsRoute, type EventsEmitter } from '@/admin/events.js';
import { buildAdminAllowedHosts, registerAdminGuard } from '@/admin/guard.js';
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
import { stripTrailingSlash } from '@/hub/issuer.js';
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
   * When set, dev-oidc serves HTTPS (and same-port HTTP→HTTPS 301 redirect)
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
    issuer: deriveIssuer(options),
  };

  const getTenant = (_req: FastifyRequest): ActiveTenantState => tenant;

  const tlsMaterial = options.tls;
  // httpolyglot.createServer returns a net.Server that proxies HTTP/HTTPS/HTTP2
  // requests through the same handler. Fastify's serverFactory expects an
  // http.Server-shaped value; the multiplexer is structurally compatible at
  // runtime (it forwards request/response events), so we narrow with a cast and
  // pin Fastify's RawServer generic to http.Server to match.
  const app = Fastify<HttpServer>({
    loggerInstance: logger,
    ...(tlsMaterial && {
      serverFactory: (handler: RequestListener): HttpServer =>
        httpolyglot.createServer(
          { tls: { cert: tlsMaterial.cert, key: tlsMaterial.key } },
          handler,
        ) as unknown as HttpServer,
    }),
  });

  if (tlsMaterial) {
    app.addHook('onRequest', async (req, reply) => {
      const socket = req.socket as TLSSocket;
      if (!socket.encrypted) {
        const target = `https://${req.hostname}${req.url}`;
        await reply.code(301).header('Location', target).send();
      }
    });
  }

  registerAdminGuard(app, {
    allowedHosts: buildAdminAllowedHosts({
      listenHost: options.listenHost ?? '127.0.0.1',
      listenPort: options.listenPort ?? 8095,
      publicUrl: options.publicUrl,
    }),
  });
  await app.register(cors, {
    origin: true,
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
