import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as jose from 'jose';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { assembleClaims } from '@/oidc/claims.js';

export interface UserInfoDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

function unauthorized(reply: FastifyReply, withError: boolean): FastifyReply {
  const challenge = withError ? 'Bearer error="invalid_token"' : 'Bearer';
  return reply
    .code(401)
    .header('www-authenticate', challenge)
    .send(withError ? { error: 'invalid_token' } : {});
}

// Extract the access token from the Authorization header (preferred) or, for
// POST requests, the `access_token` form-body parameter (RFC 6750 §2.2 /
// OIDC Core §5.3.1).
function extractToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const body = request.body as { access_token?: unknown } | undefined;
  if (body && typeof body.access_token === 'string' && body.access_token.trim() !== '') {
    return body.access_token.trim();
  }
  return null;
}

export function registerUserInfo(app: FastifyInstance, deps: UserInfoDeps): void {
  const prefix = deps.pathPrefix ?? '';

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const tenant = deps.getTenant(request);
    const token = extractToken(request);
    if (!token) {
      return unauthorized(reply, false);
    }

    let payload: jose.JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, tenant.keyMaterial.publicKey, {
        issuer: tenant.issuer,
      }));
    } catch {
      return unauthorized(reply, true);
    }

    // userinfo is for access tokens only. dev-oidc access tokens always carry a
    // `scope` claim; ID tokens do not — reject anything without one.
    if (typeof payload.scope !== 'string') {
      return unauthorized(reply, true);
    }

    const config = tenant.runtime.get();
    const profile = config.profiles.find((p) => p.id === payload.sub);
    if (!profile) {
      return unauthorized(reply, true);
    }

    const claims = assembleClaims({
      profile,
      subjectClaim: config.subjectClaim,
      scope: payload.scope,
      destination: 'userinfo',
    });
    return reply.code(200).send(claims);
  };

  app.get(`${prefix}/userinfo`, handler);
  app.post(`${prefix}/userinfo`, handler);
}
