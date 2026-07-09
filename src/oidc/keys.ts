import path from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { z } from 'zod';
import type { SigningKey } from '@/config/schema.js';

export type SigningAlg = 'RS256' | 'ES256';

export interface KeyMaterial {
  kid: string;
  alg: SigningAlg;
  privateKey: jose.KeyLike;
  publicJwk: jose.JWK;
}

export interface CreateKeyMaterialOptions {
  configDir?: string;
}

export async function createKeyMaterial(
  config: SigningKey,
  options: CreateKeyMaterialOptions = {},
): Promise<KeyMaterial> {
  if (config.source === 'generate') {
    return generateEphemeralKey(config.kid, config.alg);
  }

  const rawPath = config.source.slice('file:'.length);
  const configDir = options.configDir ?? process.cwd();
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(configDir, rawPath);
  const existing = await loadKeyFromFile(filePath, config.kid, config.alg);
  if (existing) return existing;
  const generated = await generateEphemeralKey(config.kid, config.alg);
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

// Minimum-viable JWK shape: a `kty` discriminator plus arbitrary other
// fields (jose validates the algorithm-specific bits during importJWK).
const JwkSchema = z.object({ kty: z.string().min(1) }).passthrough();

const PersistedKeySchema = z.object({
  kid: z.string().min(1),
  privateJwk: JwkSchema,
  publicJwk: JwkSchema,
});

interface PersistedKey {
  kid: string;
  privateJwk: jose.JWK;
  publicJwk: jose.JWK;
}

const PUBLIC_COMPONENTS: Record<string, readonly string[]> = {
  RSA: ['n', 'e'],
  EC: ['crv', 'x', 'y'],
};

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

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`dev-oidc: signing key at ${filePath} is not valid JSON: ${message}`);
  }
  const result = PersistedKeySchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `dev-oidc: signing key at ${filePath} is malformed (expected { kid, privateJwk, publicJwk }): ${result.error.message}`,
    );
  }
  const parsed = result.data as PersistedKey;
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

  const privateKty = parsed.privateJwk.kty;
  const publicKty = parsed.publicJwk.kty;
  const components = PUBLIC_COMPONENTS[privateKty];
  if (!components) {
    throw new Error(
      `dev-oidc: signing key at ${filePath} has unsupported key type "${privateKty}" ` +
        `(only "RSA" and "EC" are supported). Delete the file to regenerate.`,
    );
  }
  if (publicKty !== privateKty) {
    throw new Error(
      `dev-oidc: signing key at ${filePath} has inconsistent key types ` +
        `(private "${privateKty}", public "${publicKty}"). Delete the file to regenerate.`,
    );
  }
  for (const field of components) {
    const pub = (parsed.publicJwk as unknown as Record<string, unknown>)[field];
    const priv = (parsed.privateJwk as unknown as Record<string, unknown>)[field];
    if (pub === undefined || priv === undefined || pub !== priv) {
      throw new Error(
        `dev-oidc: signing key at ${filePath} has a publicJwk that does not match its privateJwk ` +
          `(component "${field}" is missing or differs). JWKS would not verify issued tokens. Delete the file to regenerate.`,
      );
    }
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
  const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
