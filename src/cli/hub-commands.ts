import path from 'node:path';
import { deriveSlugFromPath } from '@/cli/slug.js';
import { loadConfig } from '@/config/loader.js';
import { loadHubConfig, saveHubConfig } from '@/hub/loader.js';
import { computeIssuer, deriveDefaultPublicUrl } from '@/hub/issuer.js';
import { isReservedSlug, SLUG_REGEX } from '@/hub/schema.js';

export interface CommandResult {
  exitCode: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

export interface RegisterOptions {
  hubConfigPath: string;
  configPathArg: string;
  slug?: string;
}

export async function runRegister(options: RegisterOptions): Promise<CommandResult> {
  const absConfig = path.resolve(options.configPathArg);
  if (!absConfig.endsWith('.json')) {
    return {
      exitCode: 1,
      stderr: `dev-oidc: project config path must end in .json: ${absConfig}\n`,
    };
  }

  try {
    await loadConfig(absConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stderr: `dev-oidc: ${msg}\n` };
  }

  const slug = options.slug ?? deriveSlugFromPath(absConfig);
  if (!slug) {
    return {
      exitCode: 1,
      stderr: 'dev-oidc: could not derive slug from project directory name; pass --slug <name>\n',
    };
  }
  if (!SLUG_REGEX.test(slug)) {
    return {
      exitCode: 1,
      stderr: `dev-oidc: slug "${slug}" does not match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$\n`,
    };
  }
  if (isReservedSlug(slug)) {
    return { exitCode: 1, stderr: `dev-oidc: slug "${slug}" is reserved\n` };
  }

  const hub = await loadHubConfig(options.hubConfigPath);
  const existing = hub.tenants.find((t) => t.slug === slug);
  if (existing) {
    return {
      exitCode: 1,
      stderr: `dev-oidc: slug "${slug}" already registered to ${existing.configPath}; use a different --slug or run \`dev-oidc unregister ${slug}\` first\n`,
    };
  }

  const next = {
    ...hub,
    tenants: [...hub.tenants, { slug, configPath: absConfig, enabled: true }],
  };
  await saveHubConfig(options.hubConfigPath, next);
  return { exitCode: 0, stdout: `Registered "${slug}" → ${absConfig}\n` };
}

export interface UnregisterOptions {
  hubConfigPath: string;
  slug: string;
}

export async function runUnregister(options: UnregisterOptions): Promise<CommandResult> {
  const hub = await loadHubConfig(options.hubConfigPath);
  const existing = hub.tenants.find((t) => t.slug === options.slug);
  if (!existing) {
    return { exitCode: 1, stderr: `dev-oidc: unknown slug "${options.slug}"\n` };
  }
  const next = { ...hub, tenants: hub.tenants.filter((t) => t.slug !== options.slug) };
  await saveHubConfig(options.hubConfigPath, next);
  return { exitCode: 0, stdout: `Unregistered "${options.slug}" → ${existing.configPath}\n` };
}

export interface ListOptions {
  hubConfigPath: string;
  json?: boolean;
}

export async function runList(options: ListOptions): Promise<CommandResult> {
  const hub = await loadHubConfig(options.hubConfigPath);
  if (options.json) {
    return { exitCode: 0, stdout: JSON.stringify(hub.tenants, null, 2) + '\n' };
  }
  if (hub.tenants.length === 0) {
    return { exitCode: 0, stdout: 'No tenants registered.\n' };
  }
  const publicUrl = hub.server.publicUrl ?? deriveDefaultPublicUrl(hub.server);
  const lines = ['SLUG\tENABLED\tISSUER\tPATH'];
  for (const t of hub.tenants) {
    const issuer = computeIssuer({ publicUrl, slug: t.slug });
    lines.push(`${t.slug}\t${t.enabled ? 'yes' : 'no'}\t${issuer}\t${t.configPath}`);
  }
  return { exitCode: 0, stdout: lines.join('\n') + '\n' };
}
