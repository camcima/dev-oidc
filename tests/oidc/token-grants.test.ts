import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import type { Client, Config } from '@/config/schema.js';
import { createRuntimeConfig } from '@/config/runtime.js';
import { createCodeStore } from '@/oidc/codes.js';
import { createKeyMaterial } from '@/oidc/keys.js';
import { registerToken } from '@/oidc/token.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

function client(overrides: Partial<Client> = {}): Client {
  return {
    clientId: 'my-app',
    redirectUris: ['http://localhost:5173/cb'],
    postLogoutRedirectUris: [],
    audience: 'my-api',
    ...overrides,
  };
}

function buildConfig(clients: Client[]): Config {
  return {
    signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
    clients,
    subjectClaim: 'sub',
    tokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 28800,
    branding: { title: 'T', accentColor: '#000', logoUrl: null },
    profiles: [{ id: 'alice', displayName: 'Alice', email: 'a@x.com', avatar: null, claims: {} }],
  };
}

async function buildApp(clients: Client[] = [client()]) {
  const config = buildConfig(clients);
  const runtime = createRuntimeConfig(config);
  const codes = createCodeStore({ ttlMs: 60_000, refreshTtlMs: 60_000 });
  const keyMaterial = await createKeyMaterial(runtime.get().signingKey);
  const app = Fastify();
  await app.register(formbody);
  const tenant = {
    slug: '(legacy)',
    configPath: '/dev/null',
    status: 'active',
    issuer: 'http://localhost:8095',
    watcher: null,
    runtime,
    codes,
    keyMaterial,
  } as unknown as ActiveTenantState;
  registerToken(app, { getTenant: () => tenant });
  return { app, codes, keyMaterial };
}

function post(app: Awaited<ReturnType<typeof buildApp>>['app'], body: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(body).toString(),
  });
}

const s256 = (v: string): string => createHash('sha256').update(v).digest('base64url');

describe('client_credentials grant', () => {
  it('issues an access token for a confidential client', async () => {
    const { app, keyMaterial } = await buildApp([client({ clientSecret: 's3cret' })]);
    const res = await post(app, {
      grant_type: 'client_credentials',
      client_id: 'my-app',
      client_secret: 's3cret',
      scope: 'api.read',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('api.read');

    const key = await jose.importJWK(keyMaterial.publicJwk, keyMaterial.alg);
    const { payload } = await jose.jwtVerify(body.access_token as string, key, {
      issuer: 'http://localhost:8095',
      audience: 'my-api',
    });
    expect(payload.sub).toBe('my-app');
    expect(payload.client_id).toBe('my-app');
    expect(payload.scope).toBe('api.read');
    await app.close();
  });

  it('returns no id_token and no refresh_token, per RFC 6749 4.4.3', async () => {
    const { app } = await buildApp([client({ clientSecret: 's3cret' })]);
    const res = await post(app, {
      grant_type: 'client_credentials',
      client_id: 'my-app',
      client_secret: 's3cret',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.id_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
    await app.close();
  });

  it('refuses a public client, which has no secret to authenticate with', async () => {
    const { app } = await buildApp([client()]);
    const res = await post(app, { grant_type: 'client_credentials', client_id: 'my-app' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unauthorized_client');
    await app.close();
  });

  it('enforces allowedScopes', async () => {
    const { app } = await buildApp([
      client({ clientSecret: 's3cret', allowedScopes: ['api.read'] }),
    ]);
    const res = await post(app, {
      grant_type: 'client_credentials',
      client_id: 'my-app',
      client_secret: 's3cret',
      scope: 'api.read api.write',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_scope');
    await app.close();
  });

  it('does not require the openid scope, since no user is involved', async () => {
    const { app } = await buildApp([client({ clientSecret: 's3cret' })]);
    const res = await post(app, {
      grant_type: 'client_credentials',
      client_id: 'my-app',
      client_secret: 's3cret',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('a failed code exchange burns the authorization code', () => {
  it('rejects a retry with the correct verifier after a PKCE mismatch', async () => {
    const { app, codes } = await buildApp();
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: '',
      redirectUri: 'http://localhost:5173/cb',
      scope: 'openid',
    });

    const bad = await post(app, {
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier',
      client_id: 'my-app',
      redirect_uri: 'http://localhost:5173/cb',
    });
    expect(bad.statusCode).toBe(400);

    // Real IdPs revoke the code on a failed exchange; leaving it live let a
    // broken client succeed on retry in dev but fail in production.
    const retry = await post(app, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'my-app',
      redirect_uri: 'http://localhost:5173/cb',
    });
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error).toBe('invalid_grant');
    await app.close();
  });

  it('burns the code when the redirect_uri does not match', async () => {
    const { app, codes } = await buildApp();
    const verifier = 'verifier-0123456789abcdef0123456789abcdef';
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256(verifier),
      nonce: '',
      redirectUri: 'http://localhost:5173/cb',
      scope: 'openid',
    });

    await post(app, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'my-app',
      redirect_uri: 'http://localhost:5173/other',
    });
    const retry = await post(app, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'my-app',
      redirect_uri: 'http://localhost:5173/cb',
    });
    expect(retry.statusCode).toBe(400);
    await app.close();
  });
});

describe('Basic auth credentials are form-urlencoded (RFC 6749 2.3.1)', () => {
  const SECRET = 'p@ss word/with+special&chars';

  function basicHeader(id: string, secret: string): string {
    return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
  }

  it('accepts a percent-encoded secret in the Authorization header', async () => {
    const { app } = await buildApp([client({ clientSecret: SECRET })]);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicHeader(encodeURIComponent('my-app'), encodeURIComponent(SECRET)),
      },
      payload: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('still accepts a raw, unencoded secret for compatibility', async () => {
    const { app } = await buildApp([client({ clientSecret: SECRET })]);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicHeader('my-app', SECRET),
      },
      payload: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a wrong secret regardless of encoding', async () => {
    const { app } = await buildApp([client({ clientSecret: SECRET })]);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicHeader('my-app', 'not-the-secret'),
      },
      payload: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('authorization codes issued without a PKCE challenge', () => {
  function issueWithoutChallenge(codes: Awaited<ReturnType<typeof buildApp>>['codes']): string {
    return codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      nonce: '',
      redirectUri: 'http://localhost:5173/cb',
      scope: 'openid',
    });
  }

  it('exchanges without a code_verifier', async () => {
    const { app, codes } = await buildApp([client({ clientSecret: 's3cret' })]);
    const res = await post(app, {
      grant_type: 'authorization_code',
      code: issueWithoutChallenge(codes),
      client_id: 'my-app',
      client_secret: 's3cret',
      redirect_uri: 'http://localhost:5173/cb',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.id_token).toBeDefined();
    expect(body.access_token).toBeDefined();
    await app.close();
  });

  it('ignores a stray code_verifier when no challenge was stored', async () => {
    const { app, codes } = await buildApp([client({ clientSecret: 's3cret' })]);
    const res = await post(app, {
      grant_type: 'authorization_code',
      code: issueWithoutChallenge(codes),
      code_verifier: 'unsolicited-verifier',
      client_id: 'my-app',
      client_secret: 's3cret',
      redirect_uri: 'http://localhost:5173/cb',
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('still rejects a missing verifier when a challenge WAS stored', async () => {
    const { app, codes } = await buildApp();
    const code = codes.issue({
      clientId: 'my-app',
      profileId: 'alice',
      codeChallenge: s256('verifier-0123456789abcdef0123456789abcdef'),
      nonce: '',
      redirectUri: 'http://localhost:5173/cb',
      scope: 'openid',
    });

    const res = await post(app, {
      grant_type: 'authorization_code',
      code,
      client_id: 'my-app',
      redirect_uri: 'http://localhost:5173/cb',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect(res.json().error_description).toContain('code_verifier');
    await app.close();
  });
});
