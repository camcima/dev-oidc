import Fastify, { type FastifyInstance } from 'fastify';
import type { RequestListener, Server as HttpServer } from 'node:http';
import type { TLSSocket } from 'node:tls';
import httpolyglot from '@httptoolkit/httpolyglot';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { buildAdminAllowedHosts, registerAdminGuard } from '@/admin/guard.js';
import { pickRedirectHost } from '@/hub/issuer.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import type { DevOidcLogger } from '@/logger.js';
import { buildDiscoveryDocument, type DiscoveryDocument } from '@/oidc/discovery.js';
import { createCorsOriginDelegate } from '@/server/cors.js';
import type { TlsMaterial } from '@/server/tls-loader.js';

export interface BaseAppOptions {
  logger: DevOidcLogger;
  /** Listen address, used for the admin Host allowlist and TLS redirects. */
  listenHost: string;
  listenPort: number;
  /** The explicitly configured public URL, when there is one. */
  publicUrl?: string | undefined;
  tls?: TlsMaterial | undefined;
  /** Consulted per request so hot-reloaded config takes effect immediately. */
  corsOrigins: () => Set<string>;
}

/**
 * Builds the Fastify instance shared by both run modes: TLS multiplexing, the
 * HTTP→HTTPS redirect, the admin guard, CORS and form-body parsing.
 *
 * Legacy and hub mode previously carried byte-identical copies of all of this,
 * including the explanatory comments. Keeping one copy is what stops the two
 * modes drifting apart as either grows.
 */
export async function createBaseApp(options: BaseAppOptions): Promise<FastifyInstance> {
  const { tls } = options;

  // httpolyglot.createServer returns a net.Server that proxies HTTP/HTTPS/HTTP2
  // requests through the same handler. Fastify's serverFactory expects an
  // http.Server-shaped value; the multiplexer is structurally compatible at
  // runtime (it forwards request/response events), so we narrow with a cast and
  // pin Fastify's RawServer generic to http.Server to match.
  const app = Fastify<HttpServer>({
    loggerInstance: options.logger,
    ...(tls && {
      serverFactory: (handler: RequestListener): HttpServer =>
        httpolyglot.createServer(
          { tls: { cert: tls.cert, key: tls.key } },
          handler,
        ) as unknown as HttpServer,
    }),
  });

  if (tls) {
    app.addHook('onRequest', async (req, reply) => {
      const socket = req.socket as TLSSocket;
      if (!socket.encrypted) {
        // Don't echo arbitrary Host headers — `pickRedirectHost` validates
        // against an allowlist (publicUrl host, listen host:port) before
        // accepting `req.host`, falling back to a value dev-oidc owns.
        const host = pickRedirectHost({
          requestHost: req.host,
          publicUrl: options.publicUrl,
          listenHost: options.listenHost,
          listenPort: options.listenPort,
        });
        const target = `https://${host}${req.url}`;
        // 308 rather than 301: 301 lets clients rewrite POST to GET, which
        // silently turned a misconfigured POST /token into a GET.
        await reply.code(308).header('Location', target).send();
      }
    });
  }

  registerAdminGuard(app, {
    allowedHosts: buildAdminAllowedHosts({
      listenHost: options.listenHost,
      listenPort: options.listenPort,
      publicUrl: options.publicUrl,
    }),
  });

  await app.register(cors, {
    origin: createCorsOriginDelegate(options.corsOrigins),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(formbody);

  return app;
}

/**
 * The discovery document for one tenant. `token_endpoint_auth_methods_supported`
 * depends on whether any client actually holds a secret, so it is derived from
 * the live config rather than fixed at startup.
 */
export function buildTenantDiscovery(tenant: ActiveTenantState): DiscoveryDocument {
  const config = tenant.runtime.get();
  const hasSecretClient = config.clients.some((c) => c.clientSecret !== undefined);
  const authMethods: ('none' | 'client_secret_post' | 'client_secret_basic')[] = hasSecretClient
    ? ['none', 'client_secret_post', 'client_secret_basic']
    : ['none'];
  return buildDiscoveryDocument({
    issuer: tenant.issuer,
    signingAlg: tenant.keyMaterial.alg,
    authMethods,
    subjectClaim: config.subjectClaim,
  });
}
