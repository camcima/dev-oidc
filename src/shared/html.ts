const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const ESCAPE_RE = /[&<>"']/g;

export function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(ESCAPE_RE, (c) => ESCAPE_MAP[c] ?? c);
}

export class Html {
  constructor(public readonly value: string) {}
}

function interpolate(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value === null || value === undefined || value === false) return '';
  return escape(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i] ?? '';
    if (i < values.length) out += interpolate(values[i]);
  }
  return new Html(out);
}

export function renderToString(h: Html): string {
  return h.value;
}
