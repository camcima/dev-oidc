export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function computeIssuer(input: { publicUrl: string; slug: string }): string {
  return `${stripTrailingSlash(input.publicUrl)}/${input.slug}`;
}

const BIND_ALL_HOSTS = new Set(['0.0.0.0', '::', '0::', '[::]', '[::0]', '0:0:0:0:0:0:0:0']);

export function isBindAllHost(host: string): boolean {
  return BIND_ALL_HOSTS.has(host);
}

export function deriveDefaultPublicUrl(input: { host: string; port: number }): string {
  return `http://${input.host}:${input.port}`;
}

/**
 * If the user binds to all interfaces (0.0.0.0 / ::) without setting an
 * explicit publicUrl, the issuer would advertise an unreachable address and
 * relying parties would fail token verification (issuer mismatch). Refuse to
 * start with a clear error.
 */
export function requirePublicUrlOrSafeHost(input: { host: string; publicUrl?: string }): void {
  if (input.publicUrl) return;
  if (isBindAllHost(input.host)) {
    throw new Error(
      `dev-oidc: refusing to start with host "${input.host}" and no publicUrl. ` +
        `An issuer of "http://${input.host}:<port>/..." is not reachable by relying parties. ` +
        `Set --public-url <url> (legacy) or server.publicUrl in hub.json (hub mode).`,
    );
  }
}
