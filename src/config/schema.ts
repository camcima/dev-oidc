import { z } from 'zod';

const SigningKeySchema = z.object({
  kid: z.string().min(1),
  alg: z.enum(['RS256']).default('RS256'),
  source: z
    .union([z.literal('generate'), z.string().regex(/^file:.+/)])
    .default('generate'),
});

const ClientSchema = z.object({
  clientId: z.string().min(1),
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

export const ConfigSchema = z.object({
  issuer: z.string().url(),
  port: z.number().int().positive().default(8080),
  host: z.string().default('127.0.0.1'),
  signingKey: SigningKeySchema,
  clients: z.array(ClientSchema).min(1),
  subjectClaim: z.string().default('sub'),
  tokenTtlSeconds: z.number().int().positive().default(900),
  refreshTokenTtlSeconds: z.number().int().positive().default(28800),
  branding: BrandingSchema,
  profiles: z.array(ProfileSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Client = z.infer<typeof ClientSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type SigningKey = z.infer<typeof SigningKeySchema>;
export type Branding = z.infer<typeof BrandingSchema>;
