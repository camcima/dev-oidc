import { z } from 'zod';

const SigningKeySchema = z.object({
  kid: z.string().min(1),
  alg: z.enum(['RS256', 'ES256']).default('RS256'),
  source: z.union([z.literal('generate'), z.string().regex(/^file:.+/)]).default('generate'),
});

const ClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  redirectUris: z.array(z.string().url()).min(1),
  postLogoutRedirectUris: z.array(z.string().url()).default([]),
  audience: z.string().min(1),
});

const BrandingInner = z.object({
  title: z.string().default('Dev OIDC Login'),
  accentColor: z.string().default('#1f6feb'),
  logoUrl: z.string().url().nullable().default(null),
});
const BrandingSchema = BrandingInner.default(BrandingInner.parse({}));

const ProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().email(),
  avatar: z.string().url().nullable().default(null),
  claims: z.record(z.string(), z.unknown()).default({}),
});

const ConfigBodySchema = z.object({
  signingKey: SigningKeySchema,
  clients: z.array(ClientSchema).min(1),
  subjectClaim: z.string().default('sub'),
  tokenTtlSeconds: z.number().int().positive().default(900),
  refreshTokenTtlSeconds: z.number().int().positive().default(28800),
  branding: BrandingSchema,
  profiles: z.array(ProfileSchema).default([]),
});

const KNOWN_KEYS = new Set(Object.keys(ConfigBodySchema.shape));

export const ConfigSchema = ConfigBodySchema.passthrough().superRefine((value, ctx) => {
  const raw = value as Record<string, unknown>;

  // Tailored error messages for fields that USED to live here in v0.1.x.
  if ('issuer' in raw) {
    ctx.addIssue({
      code: 'custom',
      path: ['issuer'],
      message:
        'issuer no longer belongs in project config; the Hub computes it from publicUrl + slug, or pass `--public-url` for legacy mode',
    });
  }
  if ('port' in raw) {
    ctx.addIssue({
      code: 'custom',
      path: ['port'],
      message:
        'port no longer belongs in project config; set hub.server.port in hub.json (or pass `--port` for legacy mode)',
    });
  }
  if ('host' in raw) {
    ctx.addIssue({
      code: 'custom',
      path: ['host'],
      message:
        'host no longer belongs in project config; set hub.server.host in hub.json (or pass `--host` for legacy mode)',
    });
  }

  // Reject any other unrecognized keys (strict-like behaviour for all other unknown fields).
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key) && key !== 'issuer' && key !== 'port' && key !== 'host') {
      ctx.addIssue({
        code: 'unrecognized_keys',
        keys: [key],
        path: [],
        message: `Unrecognized key: "${key}"`,
      });
    }
  }
}) as unknown as typeof ConfigBodySchema;

export type Config = z.infer<typeof ConfigBodySchema>;
export type Client = z.infer<typeof ClientSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type SigningKey = z.infer<typeof SigningKeySchema>;
export type Branding = z.infer<typeof BrandingSchema>;
