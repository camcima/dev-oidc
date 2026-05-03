import { execFile } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MkcertHandle {
  binary: string;
  caroot: string;
}

export interface EnsureCertPairArgs {
  mkcert: MkcertHandle;
  cacheDir: string;
  hostnames: string[];
}

export interface CertPair {
  certPath: string;
  keyPath: string;
}

async function whichMkcert(): Promise<string | null> {
  // Use `which` on POSIX, `where.exe` on Windows. Both honor PATH.
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, ['mkcert']);
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

async function resolveCAROOT(binary: string): Promise<string> {
  if (process.env.CAROOT && process.env.CAROOT.trim().length > 0) {
    return process.env.CAROOT.trim();
  }
  const { stdout } = await execFileAsync(binary, ['-CAROOT']);
  return stdout.trim();
}

export async function findMkcert(): Promise<MkcertHandle | null> {
  const binary = await whichMkcert();
  if (!binary) return null;
  const caroot = await resolveCAROOT(binary);
  try {
    await access(path.join(caroot, 'rootCA.pem'));
  } catch {
    return null;
  }
  return { binary, caroot };
}

function cacheKeyFor(hostnames: string[]): string {
  const sorted = [...hostnames].sort();
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

async function existsAndValid(certPath: string, minDaysRemaining: number): Promise<boolean> {
  try {
    const buf = await readFile(certPath);
    const x509 = new crypto.X509Certificate(buf);
    const notAfter = new Date(x509.validTo).getTime();
    const minMs = Date.now() + minDaysRemaining * 24 * 60 * 60 * 1000;
    return notAfter > minMs;
  } catch {
    return false;
  }
}

export async function ensureCertPair(args: EnsureCertPairArgs): Promise<CertPair> {
  if (args.hostnames.length === 0) {
    throw new Error('ensureCertPair: hostnames must be non-empty');
  }
  await mkdir(args.cacheDir, { recursive: true });
  const key = cacheKeyFor(args.hostnames);
  const certPath = path.join(args.cacheDir, `${key}.pem`);
  const keyPath = path.join(args.cacheDir, `${key}-key.pem`);

  const certValid = await existsAndValid(certPath, 30);
  let keyExists = false;
  try {
    await stat(keyPath);
    keyExists = true;
  } catch {
    keyExists = false;
  }

  if (!(certValid && keyExists)) {
    await execFileAsync(args.mkcert.binary, [
      '-cert-file',
      certPath,
      '-key-file',
      keyPath,
      ...args.hostnames,
    ]);
  }

  return { certPath, keyPath };
}
