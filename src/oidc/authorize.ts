import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Client } from '@/config/schema.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { renderLoginPage } from '@/login/page.js';
import { invalidParamDescription, readParams } from '@/oidc/params.js';

export interface AuthorizeDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
  /** Maps a tenant slug to its admin page URL. Defaults to the legacy '/admin'. */
  adminPath?: (slug: string) => string;
}

const AUTHORIZE_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'nonce',
  'prompt',
  'code_challenge',
  'code_challenge_method',
] as const;

/**
 * Delivers an authorization error the way RFC 6749 §4.1.2.1 requires: by
 * redirecting to the client's registered redirect_uri with `error` (plus
 * `state`) rather than answering JSON. Returning JSON meant the relying
 * party's own error-callback path was never exercised against dev-oidc, and
 * a browser user saw a raw error object instead of their app's error page.
 *
 * `redirectUri` is always the value matched against client.redirectUris, so
 * nothing request-controlled reaches the Location header.
 */
function errorRedirect(
  reply: FastifyReply,
  redirectUri: string,
  error: string,
  description: string | undefined,
  state: string | undefined,
): FastifyReply {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description !== undefined) url.searchParams.set('error_description', description);
  if (state !== undefined && state !== '') url.searchParams.set('state', state);
  return reply.code(302).header('location', url.toString()).send();
}

/**
 * Public clients must use PKCE; confidential clients (those holding a
 * clientSecret) may skip it, matching how Entra and Auth0 behave. An explicit
 * `requirePkce` on the client overrides both defaults.
 */
function pkceRequired(client: Client): boolean {
  return client.requirePkce ?? client.clientSecret === undefined;
}

export function registerAuthorize(app: FastifyInstance, deps: AuthorizeDeps): void {
  const prefix = deps.pathPrefix ?? '';
  // OIDC Core §3.1.2.1: the same request may arrive as a GET query string or
  // a form-encoded POST body.
  const handle = async (
    request: FastifyRequest,
    reply: FastifyReply,
    source: unknown,
  ): Promise<FastifyReply> => {
    const tenant = deps.getTenant(request);
    const config = tenant.runtime.get();

    // Until client_id and redirect_uri are both validated there is nowhere
    // safe to send the user, so these two stay direct 400s per the RFC.
    const target = readParams(source, ['client_id', 'redirect_uri']);
    if (!target.ok) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: invalidParamDescription(target.invalid),
      });
    }
    const { client_id: clientId, redirect_uri: requestedRedirect } = target.params;
    if (!clientId) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'client_id is required' });
    }
    const client = config.clients.find((c) => c.clientId === clientId);
    if (!client) {
      return reply
        .code(400)
        .send({ error: 'invalid_client', error_description: 'unknown client_id' });
    }

    if (!requestedRedirect || !client.redirectUris.includes(requestedRedirect)) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'redirect_uri does not match a registered value',
      });
    }

    // Resolve from the config allowlist rather than reusing the request value,
    // so only config-sourced data reaches the Location header.
    const redirectUri = client.redirectUris.find((u) => u === requestedRedirect)!;
    // A repeated state cannot be echoed faithfully, so it is dropped from the
    // error redirect rather than guessed at.
    const stateRead = readParams(source, ['state']);
    const state = stateRead.ok ? stateRead.params.state : undefined;
    const fail = (error: string, description?: string): FastifyReply =>
      errorRedirect(reply, redirectUri, error, description, state);

    const all = readParams(source, AUTHORIZE_PARAMS);
    if (!all.ok) {
      return fail('invalid_request', invalidParamDescription(all.invalid));
    }
    const query = all.params;

    if (!query.response_type) {
      return fail('invalid_request', 'response_type is required');
    }
    if (query.response_type !== 'code') {
      return fail('unsupported_response_type', 'only the authorization code flow is supported');
    }

    if (query.code_challenge) {
      if (query.code_challenge_method !== 'S256') {
        return fail('invalid_request', 'code_challenge_method must be S256');
      }
    } else if (pkceRequired(client)) {
      return fail('invalid_request', 'code_challenge is required for this client');
    }

    const requestedScope = query.scope ?? 'openid';
    const scopeTokens = requestedScope.split(/\s+/).filter(Boolean);
    if (!scopeTokens.includes('openid')) {
      return fail('invalid_scope', 'scope must contain "openid"');
    }

    if (client.allowedScopes) {
      const allowed = new Set(['openid', ...client.allowedScopes]);
      const denied = scopeTokens.filter((s) => !allowed.has(s));
      if (denied.length > 0) {
        return fail('invalid_scope', `scope not allowed for this client: ${denied.join(' ')}`);
      }
    }

    // dev-oidc holds no browser session, so it can never satisfy a silent
    // re-authentication. Answering login_required lets the relying party fall
    // back to an interactive redirect immediately; rendering the login page
    // into a hidden silent-renew iframe just hung until the RP timed out.
    const prompts = (query.prompt ?? '').split(/\s+/).filter(Boolean);
    if (prompts.includes('none')) {
      return fail('login_required', 'dev-oidc keeps no session; interactive login is required');
    }

    const pendingAuthId = tenant.pending.create({
      clientId: client.clientId,
      redirectUri,
      codeChallenge: query.code_challenge,
      nonce: query.nonce ?? '',
      state: state ?? '',
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
      adminUrl: deps.adminPath ? deps.adminPath(tenant.slug) : '/admin',
    });

    return reply.code(200).type('text/html; charset=utf-8').send(html);
  };

  app.get(`${prefix}/authorize`, (request, reply) => handle(request, reply, request.query));
  app.post(`${prefix}/authorize`, (request, reply) => handle(request, reply, request.body));
}
