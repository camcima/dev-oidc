import * as jose from 'jose';
import type { SigningKey } from '@/config/schema.js';

export interface KeyMaterial {
  kid: string;
  alg: 'RS256';
  privateKey: jose.KeyLike;
  publicJwk: jose.JWK;
}

export async function createKeyMaterial(config: SigningKey): Promise<KeyMaterial> {
  if (config.source !== 'generate') {
    throw new Error(
      `dev-oidc: signingKey.source "${config.source}" not yet supported; use "generate"`,
    );
  }

  const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk: jose.JWK = {
    ...(await jose.exportJWK(publicKey)),
    kid: config.kid,
    use: 'sig',
    alg: 'RS256',
  };

  return { kid: config.kid, alg: 'RS256', privateKey, publicJwk: jwk };
}
