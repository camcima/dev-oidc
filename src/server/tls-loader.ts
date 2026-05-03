import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findMkcert, ensureCertPair } from '@/server/mkcert.js';

export interface TlsConfigInput {
  cert?: string;
  key?: string;
  hostnames?: string[];
}

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

export type TlsErrorCode =
  | 'BYO_FILE_MISSING'
  | 'MKCERT_NOT_FOUND'
  | 'CAROOT_NOT_INITIALIZED'
  | 'INVALID_HOSTNAMES'
  | 'PATH_NOT_ABSOLUTE';

export class TlsConfigurationError extends Error {
  public readonly code: TlsErrorCode;
  constructor(
    code: TlsErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TlsConfigurationError';
    this.code = code;
  }
}

export interface LoadTlsMaterialArgs {
  config: TlsConfigInput;
  cacheDir: string;
  defaultHostnames: string[];
}

export async function loadTlsMaterial(args: LoadTlsMaterialArgs): Promise<TlsMaterial> {
  const { config, cacheDir, defaultHostnames } = args;

  // BYO mode: explicit cert + key paths.
  if (config.cert !== undefined && config.key !== undefined) {
    if (!path.isAbsolute(config.cert) || !path.isAbsolute(config.key)) {
      throw new TlsConfigurationError(
        'PATH_NOT_ABSOLUTE',
        `dev-oidc: TLS cert/key paths must be absolute. Received cert="${config.cert}", key="${config.key}".`,
      );
    }
    let cert: Buffer;
    let key: Buffer;
    try {
      cert = await readFile(config.cert);
    } catch (err) {
      throw new TlsConfigurationError(
        'BYO_FILE_MISSING',
        `dev-oidc: cannot read TLS cert at ${config.cert}: ${(err as Error).message}`,
        err,
      );
    }
    try {
      key = await readFile(config.key);
    } catch (err) {
      throw new TlsConfigurationError(
        'BYO_FILE_MISSING',
        `dev-oidc: cannot read TLS key at ${config.key}: ${(err as Error).message}`,
        err,
      );
    }
    return { cert, key };
  }

  // Auto-mkcert mode.
  const result = await findMkcert();
  if (!result.ok) {
    if (result.kind === 'not-found') {
      throw new TlsConfigurationError(
        'MKCERT_NOT_FOUND',
        'dev-oidc: TLS requires mkcert. Install from https://github.com/FiloSottile/mkcert and run `mkcert -install` once on your host. Alternatively, set tls.cert and tls.key for BYO mode.',
      );
    }
    throw new TlsConfigurationError(
      'CAROOT_NOT_INITIALIZED',
      `dev-oidc: mkcert is installed but its local CA at ${result.caroot} has not been initialized. Run \`mkcert -install\` once on your host to create the root CA, then retry.`,
    );
  }
  const hostnames = config.hostnames ?? defaultHostnames;
  if (hostnames.length === 0) {
    throw new TlsConfigurationError(
      'INVALID_HOSTNAMES',
      'dev-oidc: at least one hostname must be provided for auto-mkcert mode.',
    );
  }
  const pair = await ensureCertPair({ mkcert: result.handle, cacheDir, hostnames });
  const cert = await readFile(pair.certPath);
  const key = await readFile(pair.keyPath);
  return { cert, key };
}
