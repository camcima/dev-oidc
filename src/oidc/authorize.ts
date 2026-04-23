import type { FastifyInstance } from 'fastify';
import type { RuntimeConfig } from '@/config/runtime.js';
import type { PendingAuthStore } from '@/oidc/pending.js';
import { renderLoginPage } from '@/login/page.js';

export interface AuthorizeDeps {
  runtime: RuntimeConfig;
  pending: PendingAuthStore;
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
  app.get('/authorize', async (request, reply) => {
    const query = request.query as AuthorizeQuery;
    const config = deps.runtime.get();

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

    const pendingAuthId = deps.pending.create({
      clientId: client.clientId,
      redirectUri: query.redirect_uri,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: 'S256',
      nonce: query.nonce ?? '',
      state: query.state ?? '',
      scope: query.scope ?? 'openid',
    });

    const html = renderLoginPage({
      pendingAuthId,
      profiles: config.profiles,
      branding: config.branding,
      actionUrl: '/authorize/complete',
    });

    return reply.code(200).type('text/html; charset=utf-8').send(html);
  });
}
