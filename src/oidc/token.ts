import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as jose from 'jose';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import type { Client, Profile } from '@/config/schema.js';
import { assembleClaims } from '@/oidc/claims.js';

export interface TokenDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

interface TokenBody {
  grant_type?: string;
  scope?: string;
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
  /**
   * Candidate secrets to test. RFC 6749 §2.3.1 says Basic-auth credentials are
   * form-urlencoded before base64, and spec-conformant clients encode them —
   * but plenty of tools send the raw bytes. Both readings are offered so a
   * secret containing reserved characters works either way; each is compared
   * against the configured value, so accepting two candidates leaks nothing.
   */
  secrets: string[];
  conflict?: boolean;
}

/** Form-urlencoded decode; returns null when the input is not valid encoding. */
function formUrlDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function candidates(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const decoded = formUrlDecode(raw);
  return decoded !== null && decoded !== raw ? [raw, decoded] : [raw];
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

  // Compare ids after decoding so an encoded header and a raw body field for
  // the same client are not mistaken for a conflict.
  const basicIdDecoded = basicId === undefined ? undefined : (formUrlDecode(basicId) ?? basicId);
  if (basicId && formId && basicId !== formId && basicIdDecoded !== formId) {
    return { conflict: true, secrets: [] };
  }
  if (basicSecret && formSecret && !candidates(basicSecret).includes(formSecret)) {
    return { conflict: true, secrets: [] };
  }

  return {
    clientId: basicIdDecoded ?? formId,
    secrets: basicSecret !== undefined ? candidates(basicSecret) : candidates(formSecret),
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function secretMatches(expected: string, offered: string[]): boolean {
  let ok = false;
  for (const candidate of offered) {
    if (constantTimeEqual(expected, candidate)) ok = true;
  }
  return ok;
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
      if (!secretMatches(client.clientSecret, creds.secrets)) {
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
      case 'client_credentials':
        return handleClientCredentialsGrant(tenant, client, body, reply);
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
  const code = body.code;
  const verifier = body.code_verifier;
  const clientId = body.client_id;
  const redirectUri = body.redirect_uri;
  if (!code || !clientId || !redirectUri) {
    return reply
      .code(400)
      .send({ error: 'invalid_request', error_description: 'missing required fields' });
  }

  const result = tenant.codes.consumeIf(code, (record) => {
    if (record.clientId !== clientId) return 'client_id mismatch';
    // PKCE is verified whenever the authorization request supplied a
    // challenge, whether or not the client was obliged to send one.
    if (record.codeChallenge !== undefined) {
      if (!verifier) return 'code_verifier is required for this authorization code';
      if (s256(verifier) !== record.codeChallenge) return 'PKCE verifier mismatch';
    }
    if (redirectUri !== record.redirectUri) return 'redirect_uri mismatch';
    return null;
  });
  if (result.status === 'missing') {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'code expired or already consumed' });
  }
  if (result.status === 'rejected') {
    return reply.code(400).send({ error: 'invalid_grant', error_description: result.reason });
  }
  const record = result.record;

  const config = tenant.runtime.get();
  const profile = config.profiles.find((p) => p.id === record.profileId);
  if (!profile) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'profile no longer exists' });
  }

  return issueTokenSet(
    tenant,
    profile,
    record.clientId,
    record.nonce,
    record.scope,
    record.authTime,
    reply,
  );
}

async function handleRefreshGrant(
  tenant: ActiveTenantState,
  body: TokenBody,
  reply: FastifyReply,
): Promise<unknown> {
  const refreshToken = body.refresh_token;
  const clientId = body.client_id;
  if (!refreshToken || !clientId) {
    return reply.code(400).send({ error: 'invalid_request' });
  }

  const result = tenant.codes.consumeRefreshIf(refreshToken, (record) =>
    record.clientId === clientId ? null : 'client_id mismatch',
  );
  if (result.status !== 'consumed') {
    return reply.code(400).send({ error: 'invalid_grant' });
  }
  const record = result.record;

  const config = tenant.runtime.get();
  const profile = config.profiles.find((p) => p.id === record.profileId);
  if (!profile) {
    return reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'profile no longer exists' });
  }

  return issueTokenSet(tenant, profile, record.clientId, '', record.scope, record.authTime, reply);
}

/**
 * RFC 6749 §4.4 machine-to-machine grant: no user, so no id_token and no
 * refresh token (§4.4.3), and `openid` is not required. Only confidential
 * clients qualify — a public client has nothing to authenticate with.
 */
async function handleClientCredentialsGrant(
  tenant: ActiveTenantState,
  client: Client,
  body: TokenBody,
  reply: FastifyReply,
): Promise<unknown> {
  if (!client.clientSecret) {
    return reply.code(400).send({
      error: 'unauthorized_client',
      error_description: 'client_credentials requires a client with a clientSecret',
    });
  }

  const scope = body.scope ?? '';
  const scopeTokens = scope.split(/\s+/).filter(Boolean);
  if (client.allowedScopes) {
    const allowed = new Set(client.allowedScopes);
    const denied = scopeTokens.filter((s) => !allowed.has(s));
    if (denied.length > 0) {
      return reply.code(400).send({
        error: 'invalid_scope',
        error_description: `scope not allowed for this client: ${denied.join(' ')}`,
      });
    }
  }

  const config = tenant.runtime.get();
  const accessToken = await new jose.SignJWT({ scope, client_id: client.clientId })
    .setProtectedHeader({
      alg: tenant.keyMaterial.alg,
      kid: tenant.keyMaterial.kid,
      typ: 'JWT',
    })
    .setIssuer(tenant.issuer)
    .setAudience(client.audience)
    .setSubject(client.clientId)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtlSeconds}s`)
    .sign(tenant.keyMaterial.privateKey);

  return reply.code(200).send({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.tokenTtlSeconds,
    scope,
  });
}

async function issueTokenSet(
  tenant: ActiveTenantState,
  profile: Profile,
  clientId: string,
  nonce: string,
  scope: string,
  authTime: number | undefined,
  reply: FastifyReply,
): Promise<unknown> {
  const config = tenant.runtime.get();
  const client = config.clients.find((c) => c.clientId === clientId);
  if (!client) {
    return reply.code(400).send({ error: 'invalid_client' });
  }
  const subjectClaim = config.subjectClaim;
  const at = authTime ?? Math.floor(Date.now() / 1000);

  const accessClaims = assembleClaims({
    profile,
    subjectClaim,
    scope,
    destination: 'access_token',
  });
  const accessToken = await new jose.SignJWT({ ...accessClaims, scope })
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

  const atHash = createHash('sha256')
    .update(accessToken)
    .digest()
    .subarray(0, 16)
    .toString('base64url');

  const idClaims = assembleClaims({ profile, subjectClaim, scope, destination: 'id_token' });
  const idToken = await new jose.SignJWT({
    ...idClaims,
    nonce: nonce || undefined,
    azp: clientId,
    at_hash: atHash,
    auth_time: at,
  })
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

  const refreshToken = tenant.codes.issueRefresh({
    clientId,
    profileId: profile.id,
    scope,
    authTime: at,
  });

  return reply.code(200).send({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.tokenTtlSeconds,
    refresh_token: refreshToken,
    id_token: idToken,
    scope,
  });
}
