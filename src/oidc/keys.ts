import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as jose from 'jose';
import type { SigningKey } from '@/config/schema.js';

export type SigningAlg = 'RS256' | 'ES256';

export interface KeyMaterial {
  kid: string;
  alg: SigningAlg;
  privateKey: jose.KeyLike;
  publicJwk: jose.JWK;
}

export async function createKeyMaterial(config: SigningKey): Promise<KeyMaterial> {
  const alg: SigningAlg = config.alg;
  if (config.source === 'generate') {
    return generateEphemeralKey(config.kid, alg);
  }

  const filePath = config.source.slice('file:'.length);
  const existing = await loadKeyFromFile(filePath, config.kid, alg);
  if (existing) return existing;
  const generated = await generateEphemeralKey(config.kid, alg);
  await saveKeyToFile(filePath, generated);
  return generated;
}

async function generateEphemeralKey(kid: string, alg: SigningAlg): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await jose.generateKeyPair(alg, { extractable: true });
  const jwk: jose.JWK = {
    ...(await jose.exportJWK(publicKey)),
    kid,
    use: 'sig',
    alg,
  };
  return { kid, alg, privateKey, publicJwk: jwk };
}

interface PersistedKey {
  kid: string;
  privateJwk: jose.JWK;
  publicJwk: jose.JWK;
}

async function loadKeyFromFile(
  filePath: string,
  kid: string,
  configAlg: SigningAlg,
): Promise<KeyMaterial | null> {
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

  const persistedAlg = (parsed.publicJwk.alg as SigningAlg | undefined) ?? 'RS256';
  if (persistedAlg !== configAlg) {
    throw new Error(
      `dev-oidc: signing key at ${filePath} has alg "${persistedAlg}", but config expects "${configAlg}". ` +
        `Either align the config alg, delete the file to regenerate, or use a different path.`,
    );
  }

  const privateKey = (await jose.importJWK(parsed.privateJwk, configAlg)) as jose.KeyLike;
  const publicJwk: jose.JWK = { ...parsed.publicJwk, alg: configAlg };
  return { kid, alg: configAlg, privateKey, publicJwk };
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
