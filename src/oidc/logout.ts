import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { renderLogoutPage } from '@/oidc/logout-page.js';

export interface LogoutDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

interface LogoutQuery {
  post_logout_redirect_uri?: string;
}

export function registerLogout(app: FastifyInstance, deps: LogoutDeps): void {
  const prefix = deps.pathPrefix ?? '';
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const tenant = deps.getTenant(request);
    const query = request.query as LogoutQuery;
    const requested = query.post_logout_redirect_uri;
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

    return reply.code(302).header('location', allowedUri).send();
  };

  app.get(`${prefix}/logout`, handler);
  app.post(`${prefix}/logout`, handler);
}
