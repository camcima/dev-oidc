import os from 'node:os';
import path from 'node:path';

/**
 * Expand a leading `~/` to the user's home directory. Node's `fs` does not
 * interpret tildes (the shell normally does), so a path like
 * `~/certs/dev-oidc.pem` typed into the CLI or hub.json would otherwise be
 * read as a literal `./~/certs/dev-oidc.pem` and fail with ENOENT.
 */
export function expandTildePath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** Cache location for auto-provisioned mkcert leaf certificates. */
export function defaultCertCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const root = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), '.cache');
  return path.join(root, 'dev-oidc', 'certs');
}

/** SAN list used when TLS is enabled without explicit hostnames. */
export function defaultTlsHostnames(host: string, publicUrl?: string): string[] {
  const set = new Set<string>([host, 'localhost']);
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (url.hostname) set.add(url.hostname);
    } catch {
      // An unparseable publicUrl is reported elsewhere; ignore it here.
    }
  }
  return [...set];
}
