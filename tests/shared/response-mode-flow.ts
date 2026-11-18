import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';

export interface ResponseModeFlowOptions {
  /** '' for legacy mode, '/<slug>' for a hub tenant. */
  prefix: string;
  clientId: string;
  redirectUri: string;
  profileId: string;
  responseMode: 'fragment' | 'form_post';
}

export interface ResponseModeFlowResult {
  tokenStatus: number;
  tokens: { access_token?: string; id_token?: string };
}

/**
 * Drives /authorize → /authorize/complete → /token with the given
 * response_mode, reading code and state from the channel that mode uses.
 */
export async function runResponseModeFlow(
  app: FastifyInstance,
  opts: ResponseModeFlowOptions,
): Promise<ResponseModeFlowResult> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authRes = await app.inject({
    method: 'GET',
    url:
      `${opts.prefix}/authorize?` +
      new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        response_mode: opts.responseMode,
        scope: 'openid',
        state: 'rm-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
  });
  expect(authRes.statusCode).toBe(200);
  const pendingId = authRes.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1]!;

  const completeRes = await app.inject({
    method: 'POST',
    url: `${opts.prefix}/authorize/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pendingAuthId=${pendingId}&profileId=${opts.profileId}`,
  });

  let response: URLSearchParams;
  if (opts.responseMode === 'fragment') {
    expect(completeRes.statusCode).toBe(302);
    const location = new URL(completeRes.headers.location as string);
    expect(location.origin + location.pathname + location.search).toBe(opts.redirectUri);
    response = new URLSearchParams(location.hash.slice(1));
  } else {
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.headers['content-type']).toBe('text/html; charset=utf-8');
    const action = completeRes.payload.match(/<form method="post" action="([^"]+)">/)![1]!;
    expect(action).toBe(opts.redirectUri);
    response = new URLSearchParams();
    const inputs = completeRes.payload.matchAll(
      /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
    );
    for (const m of inputs) response.append(m[1]!, m[2]!);
    expect([...response.keys()].sort()).toEqual(['code', 'state']);
  }
  expect(response.get('state')).toBe('rm-state');
  const code = response.get('code');
  expect(code).toBeTruthy();

  const tokenRes = await app.inject({
    method: 'POST',
    url: `${opts.prefix}/token`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
    }).toString(),
  });
  return {
    tokenStatus: tokenRes.statusCode,
    tokens: tokenRes.json() as ResponseModeFlowResult['tokens'],
  };
}
