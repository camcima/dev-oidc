import path from 'node:path';
import { z } from 'zod';

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

const ServerSchema = z.object({
  port: z.number().int().positive().default(8095),
  host: z.string().default('127.0.0.1'),
  publicUrl: z.string().url().optional(),
});

export const HubConfigSchema = z
  .object({
    version: z.literal('1').default('1'),
    server: ServerSchema.default({ port: 8095, host: '127.0.0.1' }),
    tenants: z.array(TenantEntrySchema).default([]),
  })
  .superRefine((value, ctx) => {
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
  });

export type HubConfig = z.infer<typeof HubConfigSchema>;
export type HubTenantEntry = z.infer<typeof TenantEntrySchema>;
