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
import { OpenwopError } from '../../types.js';
import { listAccounts, getAccountForTenant, setAccountHealthForTenant, type HealthMethod } from './accountsService.js';

const INTERNAL = new Set(['tenantId', 'createdAt', 'updatedAt']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const projectOne = (o: object | null): Record<string, unknown> | null => (o ? project(o) : null);

/**
 * ADR 0582 §4 (CSM-11) — a PRESENT-but-invalid score is a typed failure.
 *
 * This used to drop a non-numeric `healthScore` to `undefined`. A chain passing
 * an embedded `{{params.*}}` score — which freezes to a STRING, the recorded
 * RFC 0013 Path-A behaviour — therefore reached `setHealth` with neither a score
 * nor factors, wrote nothing, and the node still returned `status:'success'`:
 * success-with-empty on a durable write path. Absent still means absent.
 */
function parseScore(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new OpenwopError('validation_error', 'Field `healthScore` MUST be a finite number in [0, 100].', 400, { field: 'healthScore' });
  }
  return v;
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
    // ADR 0212 §2: an optional `factors` array marks this a COMPUTED set (the
    // service stamps `healthComputedAt`); omitted, a `healthScore` set here
    // clears any prior computed factors (hand-typed ≠ computed). `crmRef` is
    // deliberately NOT accepted here — ADR 0212 §1 keeps the link routes-only
    // in v1 (see accountsService.ts header).
    setHealth: async (args) => {
      const patch: {
        name?: string;
        healthScore?: number;
        factors?: unknown;
        computedForCompanyId?: string;
        method?: HealthMethod;
        measureFailed?: { reason: string };
      } = {};
      if (optStr(args.name)) patch.name = str(args.name);
      const hs = parseScore(args.healthScore);
      if (hs !== undefined) patch.healthScore = hs;
      // ADR 0582 §4/§5 — a computed set carries the company it measured and the
      // arithmetic it used; the service refuses the write without them. Note
      // `factors` is passed through even when NOT an array so the service's
      // fail-closed validator sees it (dropping a malformed value here would
      // silently downgrade a computed write to a bare score).
      if (args.factors !== undefined) patch.factors = args.factors;
      if (optStr(args.companyId)) patch.computedForCompanyId = str(args.companyId);
      if (optStr(args.method)) patch.method = str(args.method) as HealthMethod;
      if (optStr(args.measureFailedReason)) patch.measureFailed = { reason: str(args.measureFailedReason) };
      const account = await setAccountHealthForTenant(tenantId, str(args.accountId), patch);
      return { account: projectOne(account) };
    },
  };
}
