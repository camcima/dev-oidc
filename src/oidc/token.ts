import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as jose from 'jose';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import type { Profile } from '@/config/schema.js';
import { assembleClaims } from '@/oidc/claims.js';

export interface TokenDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

interface TokenBody {
  grant_type?: string;
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
}

function s256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

interface ExtractedCreds {
  clientId?: string;
  secret?: string;
  conflict?: boolean;
}

function extractClientCredentials(request: FastifyRequest, body: TokenBody): ExtractedCreds {
  const auth = request.headers.authorization;
  let basicId: string | undefined;
  let basicSecret: string | undefined;
  if (auth && /^Basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx > 0) {
      basicId = decoded.slice(0, idx);
      basicSecret = decoded.slice(idx + 1);
    }
  }

  const formId = body.client_id;
  const formSecret = body.client_secret;

  if (basicId && formId && basicId !== formId) return { conflict: true };
  if (basicSecret && formSecret && basicSecret !== formSecret) return { conflict: true };

  return { clientId: basicId ?? formId, secret: basicSecret ?? formSecret };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function registerToken(app: FastifyInstance, deps: TokenDeps): void {
  const prefix = deps.pathPrefix ?? '';
  app.post(`${prefix}/token`, async (request, reply) => {
    const tenant = deps.getTenant(request);
    const body = request.body as TokenBody;
    const creds = extractClientCredentials(request, body);
    if (creds.conflict) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'client credentials disagree between Authorization header and body',
      });
    }
    if (!creds.clientId) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'client_id required',
      });
    }

    const config = tenant.runtime.get();
    const client = config.clients.find((c) => c.clientId === creds.clientId);
    if (!client) {
      return reply
        .code(401)
        .header('www-authenticate', 'Basic realm="dev-oidc"')
        .send({ error: 'invalid_client' });
    }

    if (client.clientSecret) {
      if (!creds.secret || !constantTimeEqual(client.clientSecret, creds.secret)) {
        return reply
          .code(401)
          .header('www-authenticate', 'Basic realm="dev-oidc"')
          .send({ error: 'invalid_client' });
      }
    }

    // Override body.client_id with the verified id, in case the body field
    // was missing but Basic auth supplied it.
    body.client_id = creds.clientId;

    switch (body.grant_type) {
      case 'authorization_code':
        return handleCodeGrant(tenant, body, reply);
      case 'refresh_token':
        return handleRefreshGrant(tenant, body, reply);
      default:
        return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
  });
}

async function handleCodeGrant(
  tenant: ActiveTenantState,
  body: TokenBody,
  reply: FastifyReply,
): Promise<unknown> {
  if (!body.code || !body.code_verifier || !body.client_id) {
    return reply
      .code(400)
      .send({ error: 'invalid_request', error_description: 'missing required fields' });
  }

  const record = tenant.codes.consume(body.code);
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

  const config = tenant.runtime.get();
  const profile = config.profiles.find((p) => p.id === record.profileId);
  if (!profile) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'profile no longer exists' });
  }

  return issueTokenSet(tenant, profile, record.clientId, record.nonce, record.scope, reply);
}

async function handleRefreshGrant(
  tenant: ActiveTenantState,
  body: TokenBody,
  reply: FastifyReply,
): Promise<unknown> {
  if (!body.refresh_token || !body.client_id) {
    return reply.code(400).send({ error: 'invalid_request' });
  }

  const record = tenant.codes.consumeRefresh(body.refresh_token);
  if (!record || record.clientId !== body.client_id) {
    return reply.code(400).send({ error: 'invalid_grant' });
  }

  const config = tenant.runtime.get();
  const profile = config.profiles.find((p) => p.id === record.profileId);
  if (!profile) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'profile no longer exists' });
  }

  return issueTokenSet(tenant, profile, record.clientId, '', record.scope, reply);
}

async function issueTokenSet(
  tenant: ActiveTenantState,
  profile: Profile,
  clientId: string,
  nonce: string,
  scope: string,
  reply: FastifyReply,
): Promise<unknown> {
  const config = tenant.runtime.get();
  const client = config.clients.find((c) => c.clientId === clientId);
  if (!client) {
    return reply.code(400).send({ error: 'invalid_client' });
  }
  const baseClaims = assembleClaims({
    profile,
    subjectClaim: config.subjectClaim,
    scope,
    destination: 'id_token',
  });

  const accessToken = await new jose.SignJWT({ ...baseClaims, scope })
    .setProtectedHeader({
      alg: tenant.keyMaterial.alg,
      kid: tenant.keyMaterial.kid,
      typ: 'JWT',
    })
    .setIssuer(tenant.issuer)
    .setAudience(client.audience)
    .setSubject(profile.id)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtlSeconds}s`)
    .sign(tenant.keyMaterial.privateKey);

  const idToken = await new jose.SignJWT({ ...baseClaims, nonce: nonce || undefined })
    .setProtectedHeader({
      alg: tenant.keyMaterial.alg,
      kid: tenant.keyMaterial.kid,
      typ: 'JWT',
    })
    .setIssuer(tenant.issuer)
    .setAudience(clientId)
    .setSubject(profile.id)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtlSeconds}s`)
    .sign(tenant.keyMaterial.privateKey);

  const refreshToken = tenant.codes.issueRefresh({ clientId, profileId: profile.id, scope });

  return reply.code(200).send({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.tokenTtlSeconds,
    refresh_token: refreshToken,
    id_token: idToken,
    scope,
  });
}
