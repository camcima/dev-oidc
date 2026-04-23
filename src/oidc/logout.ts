import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RuntimeConfig } from '@/config/runtime.js';

export interface LogoutDeps {
  runtime: RuntimeConfig;
}

interface LogoutQuery {
  post_logout_redirect_uri?: string;
}

export function registerLogout(app: FastifyInstance, deps: LogoutDeps): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const query = request.query as LogoutQuery;
    const requested = query.post_logout_redirect_uri;
    const config = deps.runtime.get();

    if (!requested) {
      return reply.code(302).header('location', '/').send();
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

  app.get('/logout', handler);
  app.post('/logout', handler);
}
