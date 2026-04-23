import { describe, expect, it } from 'vitest';
import { createKeyMaterial } from '@/oidc/keys.js';

describe('createKeyMaterial', () => {
  it('generates an RS256 keypair when source is "generate"', async () => {
    const km = await createKeyMaterial({ kid: 'k1', alg: 'RS256', source: 'generate' });

    expect(km.kid).toBe('k1');
    expect(km.alg).toBe('RS256');
    expect(km.publicJwk.kid).toBe('k1');
    expect(km.publicJwk.alg).toBe('RS256');
    expect(km.publicJwk.use).toBe('sig');
    expect(km.publicJwk.kty).toBe('RSA');
  });

  it('produces a public JWK without private material', async () => {
    const km = await createKeyMaterial({ kid: 'k1', alg: 'RS256', source: 'generate' });

    expect(km.publicJwk.d).toBeUndefined();
    expect(km.publicJwk.p).toBeUndefined();
    expect(km.publicJwk.q).toBeUndefined();
  });
});
