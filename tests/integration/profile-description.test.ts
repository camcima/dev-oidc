import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import { createHubServer } from '@/hub/server.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

const DESCRIPTION = 'Portal admin · can approve refunds';

// Two tenants loaded from disk through the normal hub loader: "described"
// gives its people descriptions and also sets up claim mapping (an `oid`
// subject alias plus custom claims); "plain" is a v0.8.0 config with no
// description anywhere.
function projectConfig(withDescriptions: boolean): string {
  const dir = makeTmpDir('dev-oidc-desc-int-');
  const file = path.join(dir, 'dev-oidc.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
      clients: [
        {
          clientId: 'my-app',
          redirectUris: ['http://localhost:5173/cb'],
          audience: 'my-api',
          clientSecret: 's3cret',
        },
      ],
      ...(withDescriptions && { subjectClaim: 'oid' }),
      profiles: [
        {
          id: 'fernanda',
          displayName: 'Fernanda Ops',
          email: 'fernanda@example.com',
          givenName: 'Fernanda',
          ...(withDescriptions && { description: DESCRIPTION }),
          claims: { roles: ['portal-admin'], team: 'ops' },
        },
      ],
    }),
  );
  return file;
}

function hubConfig(tenants: Array<{ slug: string; configPath: string }>): string {
  const dir = makeTmpDir('dev-oidc-desc-hub-');
  const file = path.join(dir, 'hub.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: '1',
      server: { port: 8095, host: '127.0.0.1', publicUrl: 'http://localhost:8095' },
      tenants: tenants.map((t) => ({ ...t, enabled: true })),
    }),
  );
  return file;
}

async function startHub() {
  const server = await createHubServer({
    hubConfigPath: hubConfig([
      { slug: 'described', configPath: projectConfig(true) },
      { slug: 'plain', configPath: projectConfig(false) },
    ]),
  });
  return server;
}

interface Collected {
  loginPage: string;
  payloads: Record<string, Record<string, unknown>>;
}

const basic = 'Basic ' + Buffer.from('my-app:s3cret').toString('base64');

/** Login → code → tokens → refresh → userinfo, returning every decoded payload. */
async function runFlow(app: FastifyInstance, slug: string): Promise<Collected> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authRes = await app.inject({
    method: 'GET',
    url:
      `/${slug}/authorize?` +
      new URLSearchParams({
        client_id: 'my-app',
        redirect_uri: 'http://localhost:5173/cb',
        response_type: 'code',
        scope: 'openid profile email',
        state: 's',
        nonce: 'n',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
  });
  expect(authRes.statusCode).toBe(200);
  const pendingId = authRes.payload.match(/name="pendingAuthId"[^>]*value="([^"]+)"/)![1]!;

  const completeRes = await app.inject({
    method: 'POST',
    url: `/${slug}/authorize/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pendingAuthId=${pendingId}&profileId=fernanda`,
  });
  expect(completeRes.statusCode).toBe(302);
  const code = new URL(completeRes.headers.location as string).searchParams.get('code')!;

  const tokenRes = await app.inject({
    method: 'POST',
    url: `/${slug}/token`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'my-app',
      redirect_uri: 'http://localhost:5173/cb',
    }).toString(),
  });
  expect(tokenRes.statusCode).toBe(200);
  const tokens = tokenRes.json() as Record<string, string>;

  const refreshRes = await app.inject({
    method: 'POST',
    url: `/${slug}/token`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    payload: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token!,
      client_id: 'my-app',
    }).toString(),
  });
  expect(refreshRes.statusCode).toBe(200);
  const refreshed = refreshRes.json() as Record<string, string>;

  const userinfoRes = await app.inject({
    method: 'GET',
    url: `/${slug}/userinfo`,
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  expect(userinfoRes.statusCode).toBe(200);

  return {
    loginPage: authRes.payload,
    payloads: {
      accessToken: jose.decodeJwt(tokens.access_token!),
      idToken: jose.decodeJwt(tokens.id_token!),
      refreshedAccessToken: jose.decodeJwt(refreshed.access_token!),
      refreshedIdToken: jose.decodeJwt(refreshed.id_token!),
      userinfo: userinfoRes.json() as Record<string, unknown>,
    },
  };
}

// Claims whose values change per run; everything else must match exactly.
const VOLATILE = ['iat', 'exp', 'auth_time', 'at_hash'];
function stable(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !VOLATILE.includes(k)));
}

describe('integration: profile description', () => {
  it('shows a tenant’s descriptions on its login page', async () => {
    const server = await startHub();
    try {
      const { loginPage } = await runFlow(server.app, 'described');
      expect(loginPage).toContain(`<div class="description">${DESCRIPTION}</div>`);
    } finally {
      await server.close();
    }
  });

  it('never puts the description in a token, a refreshed token or userinfo', async () => {
    const server = await startHub();
    try {
      const { payloads } = await runFlow(server.app, 'described');
      for (const [name, payload] of Object.entries(payloads)) {
        expect(Object.keys(payload), name).not.toContain('description');
        expect(JSON.stringify(payload), name).not.toContain('Portal admin');
        // Claim mapping is really in effect, so the check above is meaningful.
        expect(payload.oid, name).toBe('fernanda');
        expect(payload.team, name).toBe('ops');
      }
    } finally {
      await server.close();
    }
  });

  it('leaves a tenant without descriptions exactly as v0.8.0 rendered and issued it', async () => {
    const server = await startHub();
    try {
      const { loginPage, payloads } = await runFlow(server.app, 'plain');
      expect(loginPage).not.toContain('class="description"');
      expect(loginPage).toMatch(/<div class="email">fernanda@example\.com<\/div>\n {6}<\/button>/);

      const identity = {
        roles: ['portal-admin'],
        team: 'ops',
        sub: 'fernanda',
        name: 'Fernanda Ops',
        given_name: 'Fernanda',
        email: 'fernanda@example.com',
        email_verified: true,
      };
      expect(payloads.userinfo).toStrictEqual(identity);
      for (const name of ['idToken', 'refreshedIdToken'] as const) {
        expect(stable(payloads[name]!), name).toStrictEqual({
          ...identity,
          ...(name === 'idToken' && { nonce: 'n' }),
          azp: 'my-app',
          iss: 'http://localhost:8095/plain',
          aud: 'my-app',
        });
      }
      for (const name of ['accessToken', 'refreshedAccessToken'] as const) {
        expect(stable(payloads[name]!), name).toStrictEqual({
          roles: ['portal-admin'],
          team: 'ops',
          sub: 'fernanda',
          scope: 'openid profile email',
          iss: 'http://localhost:8095/plain',
          aud: 'my-api',
        });
      }
    } finally {
      await server.close();
    }
  });
});
