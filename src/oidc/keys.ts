import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as jose from 'jose';
import type { SigningKey } from '@/config/schema.js';

export interface KeyMaterial {
  kid: string;
  alg: 'RS256';
  privateKey: jose.KeyLike;
  publicJwk: jose.JWK;
}

export async function createKeyMaterial(config: SigningKey): Promise<KeyMaterial> {
  if (config.source === 'generate') {
    return generateEphemeralKey(config.kid);
  }

  // `file:<path>` — load the JWK from disk if it exists, otherwise generate
  // and persist one. Persisted keys survive container restarts so JWTs minted
  // before the restart remain verifiable against the same public key.
  const filePath = config.source.slice('file:'.length);
  const existing = await loadKeyFromFile(filePath, config.kid);
  if (existing) return existing;
  const generated = await generateEphemeralKey(config.kid);
  await saveKeyToFile(filePath, generated);
  return generated;
}

async function generateEphemeralKey(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk: jose.JWK = {
    ...(await jose.exportJWK(publicKey)),
    kid,
    use: 'sig',
    alg: 'RS256',
  };
  return { kid, alg: 'RS256', privateKey, publicJwk: jwk };
}

interface PersistedKey {
  kid: string;
  privateJwk: jose.JWK;
  publicJwk: jose.JWK;
}

async function loadKeyFromFile(filePath: string, kid: string): Promise<KeyMaterial | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') return null;
    throw error;
  }

  const parsed = JSON.parse(raw) as PersistedKey;
  if (parsed.kid !== kid) {
    throw new Error(
      `dev-oidc: signing key at ${filePath} has kid "${parsed.kid}", but config expects "${kid}". ` +
        `Either align the config kid, delete the file to regenerate, or use a different path.`,
    );
  }

  const privateKey = (await jose.importJWK(parsed.privateJwk, 'RS256')) as jose.KeyLike;
  return { kid, alg: 'RS256', privateKey, publicJwk: parsed.publicJwk };
}

async function saveKeyToFile(filePath: string, material: KeyMaterial): Promise<void> {
  const privateJwk = await jose.exportJWK(material.privateKey);
  const payload: PersistedKey = {
    kid: material.kid,
    privateJwk,
    publicJwk: material.publicJwk,
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}
