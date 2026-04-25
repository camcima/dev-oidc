export function computeIssuer(input: { publicUrl: string; slug: string }): string {
  const stripped = input.publicUrl.replace(/\/+$/, '');
  return `${stripped}/${input.slug}`;
}

export function deriveDefaultPublicUrl(input: { host: string; port: number }): string {
  return `http://${input.host}:${input.port}`;
}
