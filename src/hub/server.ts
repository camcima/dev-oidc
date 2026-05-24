import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import path from 'node:path';
import os from 'node:os';
import type { RequestListener, Server as HttpServer } from 'node:http';
import type { TLSSocket } from 'node:tls';
import httpolyglot from '@httptoolkit/httpolyglot';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { expandTildePath } from '@/cli/legacy.js';
import { loadHubConfig } from '@/hub/loader.js';
import { watchHubConfig, type HubConfigWatcher } from '@/hub/watcher.js';
import { loadTlsMaterial, type TlsMaterial } from '@/server/tls-loader.js';
import { createTenantRegistry, type TenantRegistry } from '@/hub/registry.js';
import {
  deriveDefaultPublicUrl,
  pickRedirectHost,
  requirePublicUrlOrSafeHost,
} from '@/hub/issuer.js';
import { isReservedSlug, SLUG_REGEX, type HubConfig } from '@/hub/schema.js';
import type { ActiveTenantState, ErrorTenantState, TenantState } from '@/hub/tenant-state.js';
import { registerAuthorize } from '@/oidc/authorize.js';
import { registerComplete } from '@/oidc/complete.js';
import { registerToken } from '@/oidc/token.js';
import { registerLogout } from '@/oidc/logout.js';
import { registerUserInfo } from '@/oidc/userinfo.js';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';
import { renderHubDashboard, type DashboardTenant } from '@/admin/dashboard.js';
import { renderAdminPage } from '@/admin/page.js';
import { registerProfilesRoutes } from '@/admin/profiles-routes.js';
import { createEventsEmitter, registerEventsRoute } from '@/admin/events.js';
import { buildAdminAllowedHosts, registerAdminGuard } from '@/admin/guard.js';
import { html, type Html, renderToString } from '@/shared/html.js';

export interface CreateHubServerOptions {
  hubConfigPath: string;
  logger?: DevOidcLogger;
}

export interface HubServer {
  app: FastifyInstance;
  registry: TenantRegistry;
  hubConfig: HubConfig;
  close: () => Promise<void>;
}

function resolveTenant(
  registry: TenantRegistry,
  slug: string,
):
  | { kind: 'ok'; tenant: ActiveTenantState }
  | { kind: 'not-found' }
  | { kind: 'error'; tenant: ErrorTenantState } {
  if (!SLUG_REGEX.test(slug)) return { kind: 'not-found' };
  if (isReservedSlug(slug)) return { kind: 'not-found' };
  const tenant = registry.get(slug);
  if (!tenant) return { kind: 'not-found' };
  if (tenant.status === 'error') return { kind: 'error', tenant };
  return { kind: 'ok', tenant };
}

function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const root = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), '.cache');
  return path.join(root, 'dev-oidc', 'certs');
}

function defaultHostnames(host: string, publicUrl?: string): string[] {
  const set = new Set<string>([host, 'localhost']);
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.hostname) set.add(u.hostname);
    } catch {
      // ignore
    }
  }
  return [...set];
}

function toDashboardTenant(t: TenantState): DashboardTenant {
  if (t.status === 'active') {
    return {
      slug: t.slug,
      status: 'active',
      issuer: t.issuer,
      configPath: t.configPath,
      profileCount: t.runtime.get().profiles.length,
      lastError: null,
    };
  }
  return {
    slug: t.slug,
    status: 'error',
    issuer: null,
    configPath: t.configPath,
    profileCount: null,
    lastError: t.lastError,
  };
}

export async function createHubServer(options: CreateHubServerOptions): Promise<HubServer> {
  const logger = options.logger ?? createLogger();
  const hubConfig = await loadHubConfig(options.hubConfigPath);
  // In hub mode, `hub.json`'s `server.publicUrl` is the only source of truth.
  // We deliberately do NOT consult DEV_OIDC_PUBLIC_URL here:
  //   - The published Docker image sets DEV_OIDC_PUBLIC_URL=http://localhost:8095
  //     so the *legacy* default CMD boots out of the box.
  //   - Reading that env var here would override the scheme-aware default
  //     when `server.tls` is set without `server.publicUrl`, advertising an
  //     `http://` issuer for an HTTPS listener — a regression of CHANGELOG
  //     0.3.1's TLS issuer fix. Hub operators put `server.publicUrl` in
  //     hub.json instead.
  const configPublicUrl = hubConfig.server.publicUrl;
  requirePublicUrlOrSafeHost({
    host: hubConfig.server.host,
    publicUrl: configPublicUrl,
  });
  const tlsEnabled = hubConfig.server.tls !== undefined;
  const publicUrl =
    configPublicUrl ??
    deriveDefaultPublicUrl({
      host: hubConfig.server.host,
      port: hubConfig.server.port,
      tlsEnabled,
    });

  const hubConfigDir = path.dirname(path.resolve(options.hubConfigPath));
  let tlsMaterial: TlsMaterial | undefined;
  if (hubConfig.server.tls !== undefined) {
    const tls = hubConfig.server.tls;
    const resolveHubPath = (raw: string): string => {
      const expanded = expandTildePath(raw);
      return path.isAbsolute(expanded) ? expanded : path.resolve(hubConfigDir, expanded);
    };
    const tlsConfig =
      tls.cert !== undefined && tls.key !== undefined
        ? {
            cert: resolveHubPath(tls.cert),
            key: resolveHubPath(tls.key),
          }
        : { hostnames: tls.hostnames };
    tlsMaterial = await loadTlsMaterial({
      config: tlsConfig,
      cacheDir: defaultCacheDir(),
      defaultHostnames: defaultHostnames(hubConfig.server.host, configPublicUrl),
    });
    logger.info({ caroot: process.env.CAROOT ?? '(default)' }, 'TLS enabled for hub mode');
  }

  const registry = createTenantRegistry({ publicUrl, logger });
  await registry.reconcile(hubConfig.tenants);

  const watcher: HubConfigWatcher = await watchHubConfig(options.hubConfigPath, {
    onReload: (cfg) => {
      // None of the `server.*` keys (host, port, publicUrl, tls) take effect
      // without a process restart. Surface every change so an operator who
      // tweaks them doesn't think hot-reload picked it up.
      if (JSON.stringify(cfg.server) !== JSON.stringify(hubConfig.server)) {
        logger.warn(
          { from: hubConfig.server, to: cfg.server },
          'server config changed; restart required for changes to take effect',
        );
      }
      registry
        .reconcile(cfg.tenants)
        .catch((err: unknown) => logger.warn({ err }, 'reconcile failed'));
    },
    onError: (err) => logger.warn({ err }, 'hub config reload failed'),
  });

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
        // Don't echo arbitrary Host headers — `pickRedirectHost` validates
        // against an allowlist (publicUrl host, listen host:port) before
        // accepting `req.host`, falling back to a value dev-oidc owns.
        const host = pickRedirectHost({
          requestHost: req.host,
          publicUrl: configPublicUrl,
          listenHost: hubConfig.server.host,
          listenPort: hubConfig.server.port,
        });
        const target = `https://${host}${req.url}`;
        await reply.code(301).header('Location', target).send();
      }
    });
  }
  registerAdminGuard(app, {
    allowedHosts: buildAdminAllowedHosts({
      listenHost: hubConfig.server.host,
      listenPort: hubConfig.server.port,
      publicUrl: configPublicUrl,
    }),
  });
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(formbody);

  const getTenant = (req: FastifyRequest): ActiveTenantState => {
    return (req as FastifyRequest & { tenant: ActiveTenantState }).tenant;
  };

  const tenantPreHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const slug = (req.params as { slug?: string }).slug;
    if (!slug) {
      void reply.code(404).send({ error: 'not_found' });
      return;
    }
    const result = resolveTenant(registry, slug);
    if (result.kind === 'not-found') {
      void reply.code(404).send({ error: 'not_found' });
      return;
    }
    if (result.kind === 'error') {
      void reply
        .code(503)
        .send({ error: 'service_unavailable', error_description: result.tenant.lastError });
      return;
    }
    (req as FastifyRequest & { tenant: ActiveTenantState }).tenant = result.tenant;
  };

  // Register all slug-scoped routes inside a Fastify scope so the
  // pre-handler applies only to these routes, not to the root '/'.
  await app.register(
    async (scope) => {
      scope.addHook('preHandler', tenantPreHandler);

      scope.get('/:slug/.well-known/openid-configuration', async (req) => {
        const tenant = getTenant(req);
        const cfg = tenant.runtime.get();
        const hasSecretClient = cfg.clients.some((c) => c.clientSecret !== undefined);
        const authMethods: ('none' | 'client_secret_post' | 'client_secret_basic')[] =
          hasSecretClient ? ['none', 'client_secret_post', 'client_secret_basic'] : ['none'];
        return buildDiscoveryDocument({
          issuer: tenant.issuer,
          signingAlg: tenant.keyMaterial.alg,
          authMethods,
        });
      });

      scope.get('/:slug/.well-known/jwks.json', async (req) => getTenant(req).jwks);

      registerAuthorize(scope, { getTenant, pathPrefix: '/:slug' });
      registerComplete(scope, { getTenant, pathPrefix: '/:slug' });
      registerToken(scope, { getTenant, pathPrefix: '/:slug' });
      registerLogout(scope, { getTenant, pathPrefix: '/:slug' });
      registerUserInfo(scope, { getTenant, pathPrefix: '/:slug' });
    },
    { prefix: '' },
  );

  // Wire registry events → admin SSE emitter. Any of these registry events
  // surfaces to dashboard clients as a single config-changed signal,
  // prompting the dashboard to refetch.
  const eventsEmitter = createEventsEmitter();
  const forwardConfigChange = ({ slug }: { slug: string }): void =>
    eventsEmitter.emit({ type: 'config-changed', slug });
  registry.events.on('profilesChanged', forwardConfigChange);
  registry.events.on('added', forwardConfigChange);
  registry.events.on('removed', forwardConfigChange);

  // Admin dashboard.
  app.get('/admin', async (_req, reply) => {
    const tenants = registry.list().map(toDashboardTenant);
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(renderHubDashboard({ publicUrl, tenants }));
  });

  // Tenant summary JSON endpoint.
  app.get('/admin/api/tenants', async () => registry.list().map(toDashboardTenant));

  // SSE events stream.
  registerEventsRoute(app, { emitter: eventsEmitter });

  // Per-tenant admin page.
  app.get('/admin/:slug', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const tenant = registry.get(slug);
    if (!tenant) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (tenant.status === 'error') {
      const errorPage = renderToString(
        html`<!doctype html>
          <html>
            <body>
              <h1>Tenant "${slug}" error</h1>
              <pre>${tenant.lastError}</pre>
            </body>
          </html>`,
      );
      return reply.code(503).type('text/html; charset=utf-8').send(errorPage);
    }
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(renderAdminPage({ config: tenant.runtime.get(), slug: tenant.slug }));
  });

  // Per-tenant profile CRUD under /admin/api/:slug/...
  await app.register(
    async (scope) => {
      scope.addHook('preHandler', tenantPreHandler);

      registerProfilesRoutes(scope, {
        getTenant,
        pathPrefix: '/admin/api/:slug',
      });
    },
    { prefix: '' },
  );

  // Root landing page enumerating tenants.
  app.get('/', async (_req, reply) => {
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(renderHubLanding({ publicUrl, tenants: registry.list() }));
  });

  return {
    app,
    registry,
    hubConfig,
    close: async () => {
      await watcher.close();
      await registry.closeAll();
      await app.close();
    },
  };
}

function renderHubLanding(input: { publicUrl: string; tenants: readonly TenantState[] }): string {
  const items: Html[] =
    input.tenants.length === 0
      ? [html`<li>(none)</li>`]
      : input.tenants.map(
          (t) =>
            html`<li>
              <code>${t.slug}</code> —
              <a href="/${encodeURIComponent(t.slug)}/.well-known/openid-configuration"
                >discovery</a
              >
              — status: ${t.status}
            </li>`,
        );
  return renderToString(
    html`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>dev-oidc Hub</title>
        </head>
        <body>
          <h1>dev-oidc Hub</h1>
          <p>Public URL: <code>${input.publicUrl}</code></p>
          <h2>Tenants (${input.tenants.length})</h2>
          <ul>
            ${items}
          </ul>
          <p>Run <code>dev-oidc register &lt;path&gt;</code> to mount a project.</p>
        </body>
      </html>`,
  );
}
