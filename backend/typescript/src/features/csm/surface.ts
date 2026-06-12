/**
 * CSM workflow surface (ADR 0014) — `ctx.features.csm`, a THIN read/health adapter
 * over `accountsService` (the source of truth shared with the REST face). Tenant
 * comes from the run scope; every method is tenant-guarded at the SERVICE layer
 * (CTI-1) — a cross-tenant accountId reads as not-found. The unguarded `getAccount`
 * (by id, route-only) is deliberately NOT surfaced here (mirrors crm/surface.ts).
 *
 * Reads project out host-internal columns: a node's output is recorded in the
 * durable event log, so it carries display fields, not identity/attribution.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listAccounts, getAccountForTenant, setAccountHealthForTenant } from './accountsService.js';

const INTERNAL = new Set(['tenantId', 'createdAt', 'updatedAt']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const projectOne = (o: object | null): Record<string, unknown> | null => (o ? project(o) : null);

function parseScore(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function buildCsmSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // Read — at-risk accounts first (lowest health), the service's own sort.
    listAccounts: async () => {
      const accounts = await listAccounts(tenantId);
      return { accounts: accounts.map(project) };
    },
    getAccount: async (args) => {
      const account = await getAccountForTenant(tenantId, str(args.accountId));
      return { account: projectOne(account) };
    },
    // Health write — tenant-guarded, idempotent by accountId (update-only).
    setHealth: async (args) => {
      const patch: { name?: string; healthScore?: number } = {};
      if (optStr(args.name)) patch.name = str(args.name);
      const hs = parseScore(args.healthScore);
      if (hs !== undefined) patch.healthScore = hs;
      const account = await setAccountHealthForTenant(tenantId, str(args.accountId), patch);
      return { account: projectOne(account) };
    },
  };
}
