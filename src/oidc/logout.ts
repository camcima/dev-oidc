import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { renderLogoutPage } from '@/oidc/logout-page.js';

export interface LogoutDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

interface LogoutParams {
  post_logout_redirect_uri?: unknown;
  state?: unknown;
}

function readParam(
  query: LogoutParams,
  body: LogoutParams | undefined,
  name: 'post_logout_redirect_uri' | 'state',
): string | undefined {
  // OIDC RP-Initiated Logout §2 allows the parameters to arrive as query
  // string or, for POST, as form-encoded body fields.
  const fromQuery = query[name];
  if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery;
  const fromBody = body?.[name];
  if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
  return undefined;
}

export function registerLogout(app: FastifyInstance, deps: LogoutDeps): void {
  const prefix = deps.pathPrefix ?? '';
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const tenant = deps.getTenant(request);
    const query = (request.query ?? {}) as LogoutParams;
    const body = request.body as LogoutParams | undefined;
    const requested = readParam(query, body, 'post_logout_redirect_uri');
    const state = readParam(query, body, 'state');
    const config = tenant.runtime.get();

    if (!requested) {
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(renderLogoutPage({ branding: config.branding }));
    }

    const allowedUri = config.clients
      .flatMap((c) => c.postLogoutRedirectUris)
      .find((u) => u === requested);

    if (!allowedUri) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'post_logout_redirect_uri not registered',
      });
    }

    // allowedUri comes from the config allowlist, never from the request.
    // Per OIDC RP-Initiated Logout §3, `state` is echoed back verbatim so the
    // RP's signout callback can correlate the response.
    if (state === undefined) {
      return reply.code(302).header('location', allowedUri).send();
    }
    const url = new URL(allowedUri);
    url.searchParams.set('state', state);
    return reply.code(302).header('location', url.toString()).send();
  };

  app.get(`${prefix}/logout`, handler);
  app.post(`${prefix}/logout`, handler);
}
