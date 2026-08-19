import type { RuntimeConfig } from '@/config/runtime.js';
import type { KeyMaterial } from '@/oidc/keys.js';
import type { CodeStore } from '@/oidc/codes.js';
import type { PendingAuthStore } from '@/oidc/pending.js';
import type { ConfigWatcher } from '@/config/watcher.js';
import type { JwksDocument } from '@/oidc/jwks.js';

export type TenantStatus = 'active' | 'error';

export interface ActiveTenantState {
  slug: string;
  configPath: string;
  status: 'active';
  /**
   * Live view of the tenant's config. There is deliberately no snapshot field
   * beside it: one existed, went stale on every hot reload, and had no readers
   * — but sat next to `runtime` inviting the next contributor to use it.
   */
  runtime: RuntimeConfig;
  keyMaterial: KeyMaterial;
  jwks: JwksDocument;
  codes: CodeStore;
  pending: PendingAuthStore;
  watcher: ConfigWatcher | null;
  issuer: string;
}

export interface ErrorTenantState {
  slug: string;
  configPath: string;
  status: 'error';
  lastError: string;
}

export type TenantState = ActiveTenantState | ErrorTenantState;
