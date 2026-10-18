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
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface, type FeatureSurfaceOrgPolicy } from '../../host/featureSurfaces.js';
import type { HostEventOrigin } from '../../host/hostEventDispatcher.js';
import { isWorkspaceMember } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import {
  listAccounts, getAccountForTenant, setAccountHealthForTenant, listRenewalsDue, validateCrmRef, MAX_PLAY_ACCOUNTS, MAX_RENEWAL_WINDOW_DAYS, type HealthMethod,
} from './accountsService.js';

/**
 * ADR 0882 D1 (CSM2WF-1/-2) — the closed-world method partition. `csm` used to
 * register its surface with NO policy, and no method takes an `orgId`, so the
 * ADR 0832 org floor never fired: a Viewer's run rescored accounts its HTTP door
 * refuses, and a run whose person had been REMOVED kept reading the whole book.
 * Every method is now in exactly one set (`adr0882-csm-surface-floors.test.ts`
 * fails on an unclassified one), and the seam asks the run's person (actor, else
 * the causing member — an event binding's creator) for the tenant scope. Reads
 * are floored too, unlike CRM's: CSM accounts are tenant-wide, so a read floor is
 * the only thing that stops a removed member's scheduled run.
 */
export const CSM_SURFACE_READS = new Set(['listAccounts', 'getAccount', 'listRenewalsDue', 'playTargets']);
export const CSM_SURFACE_WRITERS = new Set(['setHealth']);
export const CSM_SURFACE_POLICY: FeatureSurfaceOrgPolicy = {
  tenantMethodScopes: {
    ...Object.fromEntries([...CSM_SURFACE_READS].map((m) => [m, 'workspace:read' as const])),
    ...Object.fromEntries([...CSM_SURFACE_WRITERS].map((m) => [m, 'workspace:write' as const])),
  },
  // ADR 0882 D2 — a computed set names its org, and measuring an org is a WRITE
  // there, as for CRM's org writers.
  methodScopes: { setHealth: 'workspace:write' },
};

// ADR 0882 D3 — `ownerUserId` is a member subject id and `owner` is a typed
// person's name (declared PII, CSM2CD-5); read outputs land in the durable
// run-event log and in model context, so neither rides the run lane.
const INTERNAL = new Set(['tenantId', 'createdAt', 'updatedAt', 'ownerUserId', 'owner']);
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
  const origin: HostEventOrigin = {
    ...(scope.runId ? { runId: scope.runId } : {}),
    ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
    ...(scope.chainId ? { chainId: scope.chainId } : {}),
  };
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
        computedForOrgId?: string;
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
      // ADR 0882 D2 — the org a computed set was MEASURED in. Absent is not
      // "every org" (the ADR 0832 S-A shape): the service then records why it
      // stopped measuring and refuses. Named, it engages the seam's org floor.
      if (typeof args.orgId === 'string' && args.orgId !== '') patch.computedForOrgId = args.orgId;
      if (optStr(args.method)) patch.method = str(args.method) as HealthMethod;
      if (optStr(args.measureFailedReason)) patch.measureFailed = { reason: str(args.measureFailedReason) };
      const account = await setAccountHealthForTenant(tenantId, str(args.accountId), patch, origin);
      return { account: projectOne(account) };
    },
    // ADR 0882 D6 — the renewal window. `days` is bounded; absent ⇒ 90.
    listRenewalsDue: async (args) => {
      const raw = args.days;
      let days = 90;
      if (raw !== undefined && raw !== null && raw !== '') {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > MAX_RENEWAL_WINDOW_DAYS) {
          throw new OpenwopError('validation_error', `Field \`days\` MUST be a number in [0, ${MAX_RENEWAL_WINDOW_DAYS}].`, 400, { field: 'days' });
        }
        days = raw;
      }
      const out = await listRenewalsDue(tenantId, days);
      return {
        asOf: out.asOf,
        days,
        accounts: out.accounts.map((r) => ({ ...project(r.account), overdue: r.overdue, daysUntil: r.daysUntil })),
      };
    },
    /**
     * ADR 0882 D6 — what a play needs to write tasks for each account: its CRM
     * link, renewal date, and the owner to assign (only while that person is still
     * a workspace member). Consumed INSIDE `create-play-tasks` and never echoed in
     * a node output, so the owner id stays out of the run-event log.
     */
    playTargets: async (args) => {
      const ids = Array.isArray(args.accountIds) ? args.accountIds : [];
      if (ids.length === 0 || ids.length > MAX_PLAY_ACCOUNTS || !ids.every((x) => typeof x === 'string' && x.length > 0)) {
        throw new OpenwopError('validation_error', `Field \`accountIds\` MUST be 1–${MAX_PLAY_ACCOUNTS} account ids.`, 400, { field: 'accountIds' });
      }
      const targets: Array<Record<string, unknown>> = [];
      for (const id of new Set(ids as string[])) {
        const a = await getAccountForTenant(tenantId, id);
        if (!a) {
          targets.push({ accountId: id, missing: true });
          continue;
        }
        const assignee = a.ownerUserId && (await isWorkspaceMember(a.ownerUserId, tenantId)) ? a.ownerUserId : undefined;
        // CSM2CD-3 — a link to a merged (tombstoned) or deleted company is not a
        // target: a play must not attach tasks to a company that no longer exists.
        let linkGone = false;
        if (a.crmRef) {
          try {
            await validateCrmRef(tenantId, a.crmRef);
          } catch (err) {
            if (err instanceof OpenwopError && err.code === 'not_found') linkGone = true;
            else throw err;
          }
        }
        targets.push({
          ...(linkGone ? { linkGone: true } : {}),
          accountId: a.accountId,
          name: a.name,
          ...(a.crmRef ? { orgId: a.crmRef.orgId, companyId: a.crmRef.companyId } : {}),
          ...(a.renewalDate ? { renewalDate: a.renewalDate } : {}),
          ...(assignee ? { assignee } : {}),
        });
      }
      return { targets };
    },
  };
}
