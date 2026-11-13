/**
 * ADR 1108 — the listed operator's plan exemption, carried past the HTTP edge.
 *
 * The user decision (ADR 0419 correction 2026-10-02, #4323): the host's listed
 * operator has every feature in any workspace they act in. The HTTP lane gets
 * that from `toggleSubjectOf(req)` (`isListedSuperadmin(req)` → `planExempt`),
 * but the lanes downstream of a request — chat tools and in-run
 * `ctx.features` — resolve access with no request, so they applied the
 * workspace's plan and refused the operator what the route had just served.
 *
 * The exemption is decided ONCE, at the request that creates the run, by
 * `isListedSuperadmin(req)` — the only place that can see whether an API key
 * narrowed itself (ADR 0795 D1: such a key does not inherit it) — and stamped
 * on the RESERVED `run.metadata.planExempt` key (a client value is stripped).
 * Downstream, {@link operatorPlanExempt} honours the stamp only while it still
 * holds: the run has a person, and the run's tenant or that person's own
 * personal tenant is STILL listed. So de-listing an operator ends the
 * exemption for runs already in flight, and the stamp alone grants nothing.
 *
 * Never stamped: scheduled / triggered / heartbeat runs (no request) and runs
 * started by anyone not listed. A sub-workflow CHILD of a run whose exemption
 * still holds is stamped by the dispatcher from the PARENT ROW
 * ({@link childPlanExemptionStamp}).
 *
 * The stamp's PROVENANCE is the person check. Its only writers are a request
 * from the listed person (`POST /runs`, `:fork`), a tool acting for that person
 * (`startWorkflowRun`'s explicit parameter, which those tools pass only with an
 * acting user), and the dispatcher copying from a parent whose own exemption
 * held. So this module never reads the ADR 0832 org-scope subject: it narrows and
 * never grants (ADR 0832 D3), and a child's actorlessness is no reason to drop
 * a stamp its parent's person earned.
 */
import type { Request } from 'express';
import type { ToggleSubject } from './featureToggles/types.js';
import { isListedSuperadmin, isListedSuperadminTenant } from './superadmin.js';
import { isPersonalTenantId } from './requestSubject.js';

/** The reserved run-metadata key (listed in `RESERVED_RUN_METADATA_KEYS`). */
export const PLAN_EXEMPT_METADATA_KEY = 'planExempt';
/** The reserved, NON-granting key a sub-workflow child records its operator's
 *  personal tenant under — read only by the exemption's allowlist re-check. */
export const PLAN_EXEMPT_PERSONAL_TENANT_KEY = 'planExemptPersonalTenant';

/** The value to stamp on a run created by this request: `true` for the listed
 *  operator acting in person (`isListedSuperadmin`), else `undefined`. */
export function planExemptStampOf(req: Request): true | undefined {
  return isListedSuperadmin(req) ? true : undefined;
}

/** The stamp as read back off a run row (anything but `true` is no stamp). */
export function planExemptOfRunMetadata(metadata: Record<string, unknown> | undefined): true | undefined {
  return metadata?.[PLAN_EXEMPT_METADATA_KEY] === true ? true : undefined;
}

/** The req-less scope a tool call or a run surface carries. */
export interface PlanExemptScope {
  tenantId: string;
  actingUserId?: string | undefined;
  personalTenant?: string | undefined;
  /** A sub-workflow child's NON-granting record of its operator's personal
   *  tenant (`run.metadata.planExemptPersonalTenant`); read only below. */
  planExemptPersonalTenant?: string | undefined;
  planExempt?: boolean | undefined;
}

/**
 * Whether the stamp still holds: stamped, and the run's tenant or the person's
 * own (shape-guarded, USERS-19) personal tenant still listed in
 * `OPENWOP_SUPERADMIN_TENANTS`. Fail-closed on every missing piece.
 */
export function operatorPlanExempt(scope: PlanExemptScope): boolean {
  if (scope.planExempt !== true) return false;
  if (isListedSuperadminTenant(scope.tenantId)) return true;
  const person = scope.personalTenant ?? scope.planExemptPersonalTenant;
  return isPersonalTenantId(person) && isListedSuperadminTenant(person);
}

/** The access-resolution subject for a req-less lane: the route's shape
 *  `{ tenantId, userId? }` plus the operator exemption when it holds. */
export function scopeToggleSubject(scope: PlanExemptScope): ToggleSubject {
  return {
    tenantId: scope.tenantId,
    ...(scope.actingUserId ? { userId: scope.actingUserId } : {}),
    ...(operatorPlanExempt(scope) ? { planExempt: true } : {}),
  };
}

/** What a tool that STARTS a run on the person's behalf forwards to
 *  `startWorkflowRun`, so the started run keeps the exemption it was started
 *  under (and only while it holds). */
export function forwardedPlanExemption(scope: PlanExemptScope): { planExempt?: true; personalTenant?: string } {
  return {
    ...(operatorPlanExempt(scope) ? { planExempt: true as const } : {}),
    ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}),
  };
}

/** The run-start (launch) subject for a req-less launcher: `{ planExempt }` while
 *  the exemption holds, else `{}` — the shape the dispatcher and the starter
 *  used before (no `userId`, so user-bucketed launch semantics are unchanged). */
export function launchPlanExemptSubject(scope: PlanExemptScope): { planExempt?: true } {
  return operatorPlanExempt(scope) ? { planExempt: true } : {};
}

/** The req-less scope recorded on a run row (what the executor reads). */
export function planExemptScopeOfRun(tenantId: string, metadata: Record<string, unknown> | undefined): PlanExemptScope {
  const s = (k: string): string | undefined => (typeof metadata?.[k] === 'string' && metadata[k] ? metadata[k] as string : undefined);
  return {
    tenantId,
    ...(s('actingUserId') ? { actingUserId: s('actingUserId') } : {}),
    ...(s('personalTenant') ? { personalTenant: s('personalTenant') } : {}),
    ...(s(PLAN_EXEMPT_PERSONAL_TENANT_KEY) ? { planExemptPersonalTenant: s(PLAN_EXEMPT_PERSONAL_TENANT_KEY) } : {}),
    ...(planExemptOfRunMetadata(metadata) ? { planExempt: true } : {}),
  };
}

/** What a sub-workflow child inherits from its PARENT ROW: the stamp and the
 *  person's personal tenant (needed for the re-check), only while the parent's
 *  exemption holds. Empty for every other parent. */
export function childPlanExemptionStamp(parentTenantId: string, parentMetadata: Record<string, unknown> | undefined): { planExempt?: true; [PLAN_EXEMPT_PERSONAL_TENANT_KEY]?: string } {
  const parent = planExemptScopeOfRun(parentTenantId, parentMetadata);
  if (!operatorPlanExempt(parent)) return {};
  // NOT the authority-bearing `personalTenant` key: that one admits the implicit
  // personal-tenant owner at `assertTenantScope` / `assertOrgScope`, and a child
  // carries no actor (ADR 0627 / ADR 0832 D3). The re-check reads this one only.
  const person = parent.personalTenant ?? parent.planExemptPersonalTenant;
  return { planExempt: true, ...(person ? { [PLAN_EXEMPT_PERSONAL_TENANT_KEY]: person } : {}) };
}

/** The TENANT-ONLY subject a surface's cross-feature read used (no `userId`, so
 *  user-bucketed semantics are unchanged), plus the operator exemption while it
 *  holds. */
export function tenantToggleSubject(scope: PlanExemptScope): ToggleSubject {
  return { tenantId: scope.tenantId, ...(operatorPlanExempt(scope) ? { planExempt: true } : {}) };
}
