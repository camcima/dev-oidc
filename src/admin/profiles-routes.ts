import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withConfigLock } from '@/config/mutex.js';
import { writeConfigFile } from '@/config/writer.js';
import type { Profile } from '@/config/schema.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';
import { httpUrl } from '@/shared/url-schema.js';

export interface ProfilesRoutesDeps {
  getTenant: (req: FastifyRequest) => ActiveTenantState;
  pathPrefix?: string;
}

const ProfileInput = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().email(),
  avatar: httpUrl().nullable().optional(),
  emailVerified: z.boolean().optional(),
  givenName: z.string().min(1).optional(),
  familyName: z.string().min(1).optional(),
  locale: z.string().min(1).optional(),
  hostedDomain: z.string().min(1).optional(),
  claims: z.record(z.string(), z.unknown()).optional(),
});

function toProfile(input: z.infer<typeof ProfileInput>): Profile {
  return {
    id: input.id,
    displayName: input.displayName,
    email: input.email,
    avatar: input.avatar ?? null,
    emailVerified: input.emailVerified,
    givenName: input.givenName,
    familyName: input.familyName,
    locale: input.locale,
    hostedDomain: input.hostedDomain,
    claims: input.claims ?? {},
  };
}

export function registerProfilesRoutes(app: FastifyInstance, deps: ProfilesRoutesDeps): void {
  const prefix = deps.pathPrefix ?? '/admin/api';

  app.get(`${prefix}/config`, async (request) => {
    const tenant = deps.getTenant(request);
    return tenant.runtime.get();
  });

  app.get(`${prefix}/profiles`, async (request) => {
    const tenant = deps.getTenant(request);
    return tenant.runtime.get().profiles;
  });

  app.post(`${prefix}/profiles`, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = deps.getTenant(request);
    const parsed = ProfileInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.message });
    }
    const profile = toProfile(parsed.data);
    return withConfigLock(tenant.configPath, async () => {
      const current = tenant.runtime.get();
      if (current.profiles.some((p) => p.id === profile.id)) {
        return reply
          .code(409)
          .send({ error: 'conflict', error_description: 'profile id already exists' });
      }
      const next = { ...current, profiles: [...current.profiles, profile] };
      await writeConfigFile(tenant.configPath, next);
      tenant.runtime.set(next);
      return reply.code(201).send(profile);
    });
  });

  app.put(
    `${prefix}/profiles/:id`,
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const tenant = deps.getTenant(request);
      const parsed = ProfileInput.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', details: parsed.error.message });
      }
      const profile = toProfile(parsed.data);
      return withConfigLock(tenant.configPath, async () => {
        const current = tenant.runtime.get();
        const idx = current.profiles.findIndex((p) => p.id === request.params.id);
        if (idx < 0) {
          return reply.code(404).send({ error: 'not_found' });
        }
        // A body.id that differs from the URL :id is a rename. Allow it only
        // when the new id doesn't already belong to another profile —
        // otherwise the write would produce two profiles with identical ids
        // and break the POST handler's uniqueness invariant.
        if (profile.id !== request.params.id) {
          const collides = current.profiles.some((p, i) => i !== idx && p.id === profile.id);
          if (collides) {
            return reply
              .code(409)
              .send({ error: 'conflict', error_description: 'profile id already exists' });
          }
        }
        const nextProfiles = [...current.profiles];
        nextProfiles[idx] = profile;
        const next = { ...current, profiles: nextProfiles };
        await writeConfigFile(tenant.configPath, next);
        tenant.runtime.set(next);
        return reply.code(200).send(profile);
      });
    },
  );

  app.delete(
    `${prefix}/profiles/:id`,
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const tenant = deps.getTenant(request);
      return withConfigLock(tenant.configPath, async () => {
        const current = tenant.runtime.get();
        const idx = current.profiles.findIndex((p) => p.id === request.params.id);
        if (idx < 0) {
          return reply.code(404).send({ error: 'not_found' });
        }
        const next = {
          ...current,
          profiles: current.profiles.filter((p) => p.id !== request.params.id),
        };
        await writeConfigFile(tenant.configPath, next);
        tenant.runtime.set(next);
        return reply.code(204).send();
      });
    },
  );
}
