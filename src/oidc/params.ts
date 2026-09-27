/**
 * Reads protocol parameters from a parsed query string or request body.
 *
 * Fastify hands handlers whatever the parser produced: `undefined` for an
 * empty body, `null` for a JSON `null`, arrays for a repeated form or query
 * parameter, numbers and objects from JSON. Casting that to an interface let
 * those shapes reach `.split()`, `Buffer.from()` and store lookups as 500s.
 * RFC 6749 requires each parameter to appear at most once and treats anything
 * else as `invalid_request`, so any non-string value for a named parameter is
 * rejected here, and the caller decides how to deliver the error.
 */
export type ParamsResult<K extends string> =
  { ok: true; params: Partial<Record<K, string>> } | { ok: false; invalid: K };

export function readParams<K extends string>(
  source: unknown,
  names: readonly K[],
): ParamsResult<K> {
  const fields =
    source !== null && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  const params: Partial<Record<K, string>> = {};
  for (const name of names) {
    if (!Object.hasOwn(fields, name)) continue;
    const value = fields[name];
    if (typeof value !== 'string') return { ok: false, invalid: name };
    params[name] = value;
  }
  return { ok: true, params };
}

export function invalidParamDescription(name: string): string {
  return `${name} must be a single string value`;
}
