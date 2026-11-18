import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { invalidParamDescription, readParams } from '@/oidc/params.js';
import { deliverAuthorizationResponse } from '@/oidc/response-mode.js';

export interface CompleteDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

export function registerComplete(app: FastifyInstance, deps: CompleteDeps): void {
  const prefix = deps.pathPrefix ?? '';
  app.post(`${prefix}/authorize/complete`, async (request, reply) => {
    const tenant = deps.getTenant(request);
    const read = readParams(request.body, ['pendingAuthId', 'profileId']);
    if (!read.ok) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: invalidParamDescription(read.invalid),
      });
    }
    const body = read.params;
    const config = tenant.runtime.get();

    if (!body.pendingAuthId || !body.profileId) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'missing fields' });
    }

    const pending = tenant.pending.consume(body.pendingAuthId);
    if (!pending) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'pending auth expired or unknown' });
    }

    const profile = config.profiles.find((p) => p.id === body.profileId);
    if (!profile) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'unknown profileId' });
    }

    // Resolve the redirect URI from the config allowlist — not from the pending
    // record — so the value flowing into the Location header always comes from
    // config, never from request-derived data.
    const client = config.clients.find((c) => c.clientId === pending.clientId);
    const allowedUri = client?.redirectUris.find((u) => u === pending.redirectUri);
    if (!allowedUri) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'redirect_uri not allowed' });
    }

    const code = tenant.codes.issue({
      clientId: pending.clientId,
      profileId: profile.id,
      codeChallenge: pending.codeChallenge,
      nonce: pending.nonce,
      redirectUri: allowedUri,
      scope: pending.scope,
      authTime: Math.floor(Date.now() / 1000),
    });

    const params: Record<string, string> = { code };
    if (pending.state) params.state = pending.state;
    // allowedUri is sourced directly from client.redirectUris (config constant),
    // so it alone reaches the Location header or the form_post action.
    return deliverAuthorizationResponse(reply, allowedUri, params, pending.responseMode);
  });
}
