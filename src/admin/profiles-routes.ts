import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeConfigFile } from '@/config/writer.js';
import type { Profile } from '@/config/schema.js';
import type { RuntimeConfig } from '@/config/runtime.js';

export interface ProfilesRoutesDeps {
  runtime: RuntimeConfig;
  configFilePath: string;
}

const ProfileInput = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().email(),
  avatar: z.string().url().nullable().optional(),
  claims: z.record(z.string(), z.unknown()).optional(),
});

function toProfile(input: z.infer<typeof ProfileInput>): Profile {
  return {
    id: input.id,
    displayName: input.displayName,
    email: input.email,
    avatar: input.avatar ?? null,
    claims: input.claims ?? {},
  };
}

export function registerProfilesRoutes(app: FastifyInstance, deps: ProfilesRoutesDeps): void {
  app.get('/admin/api/config', async () => {
    return deps.runtime.get();
  });

  app.get('/admin/api/profiles', async () => {
    return deps.runtime.get().profiles;
  });

  app.post('/admin/api/profiles', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = ProfileInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.message });
    }
    const profile = toProfile(parsed.data);
    const current = deps.runtime.get();
    if (current.profiles.some((p) => p.id === profile.id)) {
      return reply
        .code(409)
        .send({ error: 'conflict', error_description: 'profile id already exists' });
    }
    const next = { ...current, profiles: [...current.profiles, profile] };
    await writeConfigFile(deps.configFilePath, next);
    deps.runtime.set(next);
    return reply.code(201).send(profile);
  });

  app.put(
    '/admin/api/profiles/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = ProfileInput.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', details: parsed.error.message });
      }
      const profile = toProfile(parsed.data);
      const current = deps.runtime.get();
      const idx = current.profiles.findIndex((p) => p.id === request.params.id);
      if (idx < 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const nextProfiles = [...current.profiles];
      nextProfiles[idx] = profile;
      const next = { ...current, profiles: nextProfiles };
      await writeConfigFile(deps.configFilePath, next);
      deps.runtime.set(next);
      return reply.code(200).send(profile);
    },
  );

  app.delete(
    '/admin/api/profiles/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const current = deps.runtime.get();
      const idx = current.profiles.findIndex((p) => p.id === request.params.id);
      if (idx < 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const next = {
        ...current,
        profiles: current.profiles.filter((p) => p.id !== request.params.id),
      };
      await writeConfigFile(deps.configFilePath, next);
      deps.runtime.set(next);
      return reply.code(204).send();
    },
  );
}
