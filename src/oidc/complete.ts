import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

export interface CompleteDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

interface CompleteBody {
  pendingAuthId?: string;
  profileId?: string;
}

export function registerComplete(app: FastifyInstance, deps: CompleteDeps): void {
  const prefix = deps.pathPrefix ?? '';
  app.post(`${prefix}/authorize/complete`, async (request, reply) => {
    const tenant = deps.getTenant(request);
    const body = request.body as CompleteBody;
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

    // allowedUri is sourced directly from client.redirectUris (config constant).
    const url = new URL(allowedUri);
    url.searchParams.set('code', code);
    if (pending.state) url.searchParams.set('state', pending.state);

    return reply.code(302).header('location', url.toString()).send();
  });
}
