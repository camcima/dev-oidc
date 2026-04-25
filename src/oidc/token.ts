import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as jose from 'jose';
import type { RuntimeConfig } from '@/config/runtime.js';
import type { CodeStore } from '@/oidc/codes.js';
import type { KeyMaterial } from '@/oidc/keys.js';
import type { Profile } from '@/config/schema.js';
import { buildClaims } from '@/oidc/claims.js';

export interface TokenDeps {
  runtime: RuntimeConfig;
  codes: CodeStore;
  keyMaterial: KeyMaterial;
}

interface TokenBody {
  grant_type?: string;
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
  client_id?: string;
  refresh_token?: string;
}

function s256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function registerToken(app: FastifyInstance, deps: TokenDeps): void {
  app.post('/token', async (request, reply) => {
    const body = request.body as TokenBody;
    switch (body.grant_type) {
      case 'authorization_code':
        return handleCodeGrant(deps, body, reply);
      case 'refresh_token':
        return handleRefreshGrant(deps, body, reply);
      default:
        return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
  });
}

async function handleCodeGrant(
  deps: TokenDeps,
  body: TokenBody,
  reply: FastifyReply,
): Promise<unknown> {
  if (!body.code || !body.code_verifier || !body.client_id) {
    return reply
      .code(400)
      .send({ error: 'invalid_request', error_description: 'missing required fields' });
  }

  const record = deps.codes.consume(body.code);
  if (!record) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'code expired or already consumed' });
  }

  if (record.clientId !== body.client_id) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'client_id mismatch' });
  }

  if (s256(body.code_verifier) !== record.codeChallenge) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'PKCE verifier mismatch' });
  }

  if (body.redirect_uri && body.redirect_uri !== record.redirectUri) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  const config = deps.runtime.get();
  const profile = config.profiles.find((p) => p.id === record.profileId);
  if (!profile) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'profile no longer exists' });
  }

  return issueTokenSet(deps, profile, record.clientId, record.nonce, record.scope, reply);
}

async function handleRefreshGrant(
  deps: TokenDeps,
  body: TokenBody,
  reply: FastifyReply,
): Promise<unknown> {
  if (!body.refresh_token || !body.client_id) {
    return reply.code(400).send({ error: 'invalid_request' });
  }

  const record = deps.codes.consumeRefresh(body.refresh_token);
  if (!record || record.clientId !== body.client_id) {
    return reply.code(400).send({ error: 'invalid_grant' });
  }

  const config = deps.runtime.get();
  const profile = config.profiles.find((p) => p.id === record.profileId);
  if (!profile) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'profile no longer exists' });
  }

  return issueTokenSet(deps, profile, record.clientId, '', record.scope, reply);
}

async function issueTokenSet(
  deps: TokenDeps,
  profile: Profile,
  clientId: string,
  nonce: string,
  scope: string,
  reply: FastifyReply,
): Promise<unknown> {
  const config = deps.runtime.get();
  const client = config.clients.find((c) => c.clientId === clientId);
  if (!client) {
    return reply.code(400).send({ error: 'invalid_client' });
  }
  const baseClaims = buildClaims({ profile, subjectClaim: config.subjectClaim });

  const accessToken = await new jose.SignJWT({ ...baseClaims, scope })
    .setProtectedHeader({ alg: 'RS256', kid: deps.keyMaterial.kid, typ: 'JWT' })
    .setIssuer(config.issuer)
    .setAudience(client.audience)
    .setSubject(profile.id)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtlSeconds}s`)
    .sign(deps.keyMaterial.privateKey);

  const idToken = await new jose.SignJWT({ ...baseClaims, nonce: nonce || undefined })
    .setProtectedHeader({ alg: 'RS256', kid: deps.keyMaterial.kid, typ: 'JWT' })
    .setIssuer(config.issuer)
    .setAudience(clientId)
    .setSubject(profile.id)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtlSeconds}s`)
    .sign(deps.keyMaterial.privateKey);

  const refreshToken = deps.codes.issueRefresh({ clientId, profileId: profile.id, scope });

  return reply.code(200).send({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.tokenTtlSeconds,
    refresh_token: refreshToken,
    id_token: idToken,
    scope,
  });
}
