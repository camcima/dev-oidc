import type * as jose from 'jose';
import type { KeyMaterial } from '@/oidc/keys.js';

export interface JwksDocument {
  keys: readonly jose.JWK[];
}

export function buildJwks(keyMaterial: KeyMaterial): JwksDocument {
  return { keys: [keyMaterial.publicJwk] };
}
