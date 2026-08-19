import path from 'node:path';
import { z } from 'zod';
import { httpUrl } from '@/shared/url-schema.js';

export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const RESERVED_SLUGS: readonly string[] = [
  'admin',
  'api',
  '.well-known',
  '_health',
  '_internal',
  'static',
];

export function isReservedSlug(slug: string): boolean {
  if (RESERVED_SLUGS.includes(slug)) return true;
  if (slug.startsWith('_') || slug.startsWith('.')) return true;
  return false;
}

const SlugSchema = z
  .string()
  .regex(SLUG_REGEX, 'slug must match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$')
  .refine((s) => !isReservedSlug(s), { message: 'slug is reserved' });

const TenantEntrySchema = z.object({
  slug: SlugSchema,
  configPath: z
    .string()
    .min(1)
    .refine((p) => path.isAbsolute(p), { message: 'configPath must be absolute' }),
  enabled: z.boolean().default(true),
});

const TlsSchema = z
  .object({
    hostnames: z.array(z.string().min(1)).optional(),
    cert: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (Boolean(v.cert) !== Boolean(v.key)) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'tls.cert and tls.key must both be set or both omitted',
      });
    }
    if ((v.cert || v.key) && v.hostnames !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['hostnames'],
        message: 'tls.hostnames is only valid in auto-mkcert mode (when cert/key are not set)',
      });
    }
  });

// `looseObject` rather than `object` so unknown keys reach the refinement
// below instead of being silently stripped. Plain z.object() dropped a typo
// like `pubicUrl` without a word, and destroyed the "//" comment keys the
// shipped examples/hub.json relies on whenever the CLI rewrote the file.
const ServerSchema = z.looseObject({
  port: z.number().int().positive().default(8095),
  host: z.string().default('127.0.0.1'),
  publicUrl: httpUrl({ allowQuery: false }).optional(),
  tls: TlsSchema.optional(),
});

/** Keys beginning with "//" are JSON's idiomatic comment convention. */
function isCommentKey(key: string): boolean {
  return key.startsWith('//');
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  known: Set<string>,
  ctx: z.RefinementCtx,
  basePath: (string | number)[],
): void {
  for (const key of Object.keys(value)) {
    if (known.has(key) || isCommentKey(key)) continue;
    ctx.addIssue({
      code: 'custom',
      path: [...basePath, key],
      message: `Unrecognized key: "${key}"`,
    });
  }
}

const KNOWN_SERVER_KEYS = new Set(['port', 'host', 'publicUrl', 'tls']);
const KNOWN_ROOT_KEYS = new Set(['version', 'server', 'tenants']);

export const HubConfigSchema = z
  .looseObject({
    version: z.literal('1').default('1'),
    server: ServerSchema.default({ port: 8095, host: '127.0.0.1' }),
    tenants: z.array(TenantEntrySchema).default([]),
  })
  .superRefine((value, ctx) => {
    rejectUnknownKeys(value as Record<string, unknown>, KNOWN_ROOT_KEYS, ctx, []);
    rejectUnknownKeys(value.server as unknown as Record<string, unknown>, KNOWN_SERVER_KEYS, ctx, [
      'server',
    ]);

    const seen = new Set<string>();
    for (const [i, t] of value.tenants.entries()) {
      if (seen.has(t.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tenants', i, 'slug'],
          message: `duplicate slug "${t.slug}"`,
        });
      }
      seen.add(t.slug);
    }

    const seenPaths = new Map<string, string>();
    for (const [i, t] of value.tenants.entries()) {
      const owner = seenPaths.get(t.configPath);
      if (owner !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['tenants', i, 'configPath'],
          message: `duplicate configPath "${t.configPath}" (already used by slug "${owner}")`,
        });
      } else {
        seenPaths.set(t.configPath, t.slug);
      }
    }
  });

export type HubConfig = z.infer<typeof HubConfigSchema>;
export type HubTenantEntry = z.infer<typeof TenantEntrySchema>;
export type Tls = z.infer<typeof TlsSchema>;
