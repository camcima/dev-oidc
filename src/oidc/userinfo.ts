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

export function registerUserInfo(app: FastifyInstance, deps: UserInfoDeps): void {
  const prefix = deps.pathPrefix ?? '';

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const tenant = deps.getTenant(request);
    const auth = request.headers.authorization;
    if (!auth || !/^Bearer\s+/i.test(auth)) {
      return unauthorized(reply, false);
    }
    const token = auth.replace(/^Bearer\s+/i, '').trim();

    let payload: jose.JWTPayload;
    try {
      const key = await jose.importJWK(tenant.keyMaterial.publicJwk, tenant.keyMaterial.alg);
      ({ payload } = await jose.jwtVerify(token, key, { issuer: tenant.issuer }));
    } catch {
      return unauthorized(reply, true);
    }

    const config = tenant.runtime.get();
    const profile = config.profiles.find((p) => p.id === payload.sub);
    if (!profile) {
      return unauthorized(reply, true);
    }

    const scope = typeof payload.scope === 'string' ? payload.scope : 'openid';
    const claims = assembleClaims({
      profile,
      subjectClaim: config.subjectClaim,
      scope,
      destination: 'userinfo',
    });
    return reply.code(200).send(claims);
  };

  app.get(`${prefix}/userinfo`, handler);
  app.post(`${prefix}/userinfo`, handler);
}
