import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { renderLoginPage } from '@/login/page.js';

export interface AuthorizeDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

interface AuthorizeQuery {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

export function registerAuthorize(app: FastifyInstance, deps: AuthorizeDeps): void {
  const prefix = deps.pathPrefix ?? '';
  app.get(`${prefix}/authorize`, async (request, reply) => {
    const tenant = deps.getTenant(request);
    const query = request.query as AuthorizeQuery;
    const config = tenant.runtime.get();

    if (!query.client_id) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'client_id is required' });
    }
    const client = config.clients.find((c) => c.clientId === query.client_id);
    if (!client) {
      return reply
        .code(400)
        .send({ error: 'invalid_client', error_description: 'unknown client_id' });
    }

    if (!query.redirect_uri || !client.redirectUris.includes(query.redirect_uri)) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'redirect_uri does not match a registered value',
      });
    }

    if (query.response_type !== 'code') {
      return reply.code(400).send({ error: 'unsupported_response_type' });
    }

    if (!query.code_challenge) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'code_challenge is required' });
    }
    if (query.code_challenge_method !== 'S256') {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'code_challenge_method must be S256',
      });
    }

    const requestedScope = query.scope ?? 'openid';
    const scopeTokens = requestedScope.split(/\s+/).filter(Boolean);
    if (!scopeTokens.includes('openid')) {
      return reply.code(400).send({
        error: 'invalid_scope',
        error_description: 'scope must contain "openid"',
      });
    }

    const pendingAuthId = tenant.pending.create({
      clientId: client.clientId,
      redirectUri: query.redirect_uri,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: 'S256',
      nonce: query.nonce ?? '',
      state: query.state ?? '',
      scope: requestedScope,
    });

    // Resolve the concrete action URL: if the prefix contains a :slug param,
    // substitute the actual tenant slug so the form posts to the right path.
    const concretePrefix = prefix.replace(':slug', tenant.slug);
    const html = renderLoginPage({
      pendingAuthId,
      profiles: config.profiles,
      branding: config.branding,
      actionUrl: `${concretePrefix}/authorize/complete`,
    });

    return reply.code(200).type('text/html; charset=utf-8').send(html);
  });
}
