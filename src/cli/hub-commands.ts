import { stat } from 'node:fs/promises';
import path from 'node:path';
import { deriveSlugFromPath } from '@/cli/slug.js';
import { loadConfig } from '@/config/loader.js';
import { loadHubConfig, mutateHubConfig } from '@/hub/loader.js';
import { computeIssuer, deriveDefaultPublicUrl } from '@/hub/issuer.js';
import { isReservedSlug, SLUG_REGEX } from '@/hub/schema.js';

const DEFAULT_PROJECT_CONFIG_FILENAME = 'dev-oidc.config.json';

/**
 * Accept either a path-to-`.json` or a project directory. When given a
 * directory we look for `dev-oidc.config.json` inside it. This matches how
 * users naturally describe registration ("register this project"), while
 * still supporting an explicit file path for repos that diverge from the
 * default name.
 */
async function resolveProjectConfigPath(arg: string): Promise<string> {
  const abs = path.resolve(arg);
  try {
    const st = await stat(abs);
    if (st.isDirectory()) return path.join(abs, DEFAULT_PROJECT_CONFIG_FILENAME);
  } catch {
    // Path doesn't exist; fall through and let downstream loadConfig
    // produce the canonical "ENOENT" error.
  }
  return abs;
}

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
  const absConfig = await resolveProjectConfigPath(options.configPathArg);
  if (!absConfig.endsWith('.json')) {
    return {
      exitCode: 1,
      stderr: `dev-oidc: project config path must end in .json (got ${absConfig}); pass a directory containing ${DEFAULT_PROJECT_CONFIG_FILENAME} or an explicit .json path\n`,
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

  let conflictPath: string | null = null;
  let conflictSlug: string | null = null;
  try {
    await mutateHubConfig(options.hubConfigPath, (hub) => {
      const existing = hub.tenants.find((t) => t.slug === slug);
      if (existing) {
        conflictPath = existing.configPath;
        // Throw a sentinel to abort the mutation; we surface the message below.
        throw new Error('__slug_conflict__');
      }
      const pathOwner = hub.tenants.find((t) => t.configPath === absConfig);
      if (pathOwner) {
        conflictSlug = pathOwner.slug;
        throw new Error('__configpath_conflict__');
      }
      return {
        ...hub,
        tenants: [...hub.tenants, { slug, configPath: absConfig, enabled: true }],
      };
    });
  } catch (err) {
    if (err instanceof Error && err.message === '__slug_conflict__' && conflictPath) {
      return {
        exitCode: 1,
        stderr: `dev-oidc: slug "${slug}" already registered to ${conflictPath}; use a different --slug or run \`dev-oidc unregister ${slug}\` first\n`,
      };
    }
    if (err instanceof Error && err.message === '__configpath_conflict__' && conflictSlug) {
      return {
        exitCode: 1,
        stderr: `dev-oidc: config ${absConfig} is already registered to slug "${conflictSlug}"; unregister it first or use a separate config file\n`,
      };
    }
    // Lockfile timeouts, fs permission errors, malformed hub.json on read, etc.
    // Map to exitCode=2 (system error) so the CLI exits cleanly with a clear
    // message instead of falling through to the top-level "failed to start"
    // catch.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 2,
      stderr: `dev-oidc: failed to update hub config: ${msg}\n`,
    };
  }
  return { exitCode: 0, stdout: `Registered "${slug}" → ${absConfig}\n` };
}

export interface UnregisterOptions {
  hubConfigPath: string;
  slug: string;
}

export async function runUnregister(options: UnregisterOptions): Promise<CommandResult> {
  if (!SLUG_REGEX.test(options.slug)) {
    return {
      exitCode: 1,
      stderr: `dev-oidc: invalid slug shape; expected ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$\n`,
    };
  }
  let removedConfigPath: string | null = null;
  try {
    await mutateHubConfig(options.hubConfigPath, (hub) => {
      const existing = hub.tenants.find((t) => t.slug === options.slug);
      if (!existing) {
        throw new Error('__unknown_slug__');
      }
      removedConfigPath = existing.configPath;
      return { ...hub, tenants: hub.tenants.filter((t) => t.slug !== options.slug) };
    });
  } catch (err) {
    if (err instanceof Error && err.message === '__unknown_slug__') {
      return { exitCode: 1, stderr: `dev-oidc: unknown slug "${options.slug}"\n` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 2,
      stderr: `dev-oidc: failed to update hub config: ${msg}\n`,
    };
  }
  return {
    exitCode: 0,
    stdout: `Unregistered "${options.slug}" → ${removedConfigPath!}\n`,
  };
}

export interface ListOptions {
  hubConfigPath: string;
  json?: boolean;
}

export async function runList(options: ListOptions): Promise<CommandResult> {
  let hub;
  try {
    hub = await loadHubConfig(options.hubConfigPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, stderr: `dev-oidc: failed to read hub config: ${msg}\n` };
  }
  if (options.json) {
    return { exitCode: 0, stdout: JSON.stringify(hub.tenants, null, 2) + '\n' };
  }
  if (hub.tenants.length === 0) {
    return { exitCode: 0, stdout: 'No tenants registered.\n' };
  }
  const publicUrl =
    hub.server.publicUrl ??
    deriveDefaultPublicUrl({
      host: hub.server.host,
      port: hub.server.port,
      tlsEnabled: hub.server.tls !== undefined,
    });
  const lines = ['SLUG\tENABLED\tISSUER\tPATH'];
  for (const t of hub.tenants) {
    const issuer = computeIssuer({ publicUrl, slug: t.slug });
    lines.push(`${t.slug}\t${t.enabled ? 'yes' : 'no'}\t${issuer}\t${t.configPath}`);
  }
  return { exitCode: 0, stdout: lines.join('\n') + '\n' };
}
