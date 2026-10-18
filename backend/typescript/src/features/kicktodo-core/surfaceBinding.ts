/**
 * ADR 0901 (DEC-1) — KickTodo workflow surfaces bind to the RUN PRINCIPAL.
 *
 * The nine `ctx.features['kicktodo-*']` surfaces were written under the CTI-1
 * posture: a surface closed over `scope.tenantId` and took the person it acted
 * for as an ARGUMENT (`ownerSubject`, `coachSubject`, …). Any workspace member
 * can start any chain with arbitrary params, so that let a member act as
 * another participant. This module is the ONE helper every KickTodo surface
 * wraps itself in (ADR 0901 D4); each method declares a {@link KicktodoMethodSpec}.
 *
 * Lanes (ADR 0901 §1.1, D1/D2):
 *  - `actor` — the run has an acting user (`scope.actingUserId`);
 *  - `cause` — no actor, but a member CAUSED the run (`scope.orgScopeSubject`:
 *    a trigger's author, a sub-workflow's parent person, an approval decider);
 *  - `system` — neither. Only the host starts such a run (the KickTodo
 *    daily-loop / reminder-loop / calendar-sync / session-reminder jobs), so its
 *    args are host-authored and keep tenant trust — EXCEPT for a method declared
 *    `personOnly`, which no host job calls and which is refused.
 *
 * On the person lanes (actor/cause), for the run's person:
 *  - a declared `subjectArg` may be omitted (it defaults to the person) or must
 *    EQUAL the person; anything else is `forbidden` (`subject_mismatch`) — never
 *    a silent substitution;
 *  - `authority: 'enrollment'` asks `hasKicktodoEnrollmentAuthority` — the
 *    predicate the enrollment routes call (`featureRoute.ts`); a refusal is a
 *    uniform `not_found`, exactly as the route answers;
 *  - `authority: 'manage'` asks `hasKicktodoManageAuthority` — the predicate
 *    `requireKicktodoManage` delegates to — plus the route's implicit
 *    personal-workspace-owner short-circuit (actor lane only, keyed on the
 *    request-stamped `personalTenant`, the run twin of `isOwnPersonalWorkspace`);
 *  - `authority: 'org-manage'` asks `assertRunScopeOrg(…, 'host:org:manage')` —
 *    the run-lane twin of the `authorizeOrgScope` the org report route calls,
 *    and the predicate the seam's `methodScopes` floor already applies;
 *  - `authority: 'relation'` asks the surface's own predicate (a relation the
 *    seam feature cannot import, e.g. accountability's circle owner).
 *  A coach/creator/buyer subject is otherwise checked by the SERVICE the
 *  surface calls, against the bound subject — the same call the HTTP route
 *  makes with `subjectOf(req)`.
 *
 * Toggle (ADR 0901 D5): `kicktodo-core.run-principal-binding`, per tenant, OFF
 * by default. OFF is SHADOW: the verdict is computed and a would-be refusal is
 * logged (`kicktodo_surface_unbound`: surface, method, lane, a closed `reasonCode` — never a
 * subject value), then today's code path runs with the ORIGINAL args. ON
 * enforces. A toggle read that fails falls back to shadow (today's posture),
 * logged, and is retried on the next call rather than remembered.
 */

import type { BundleScope, SurfaceArgs } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import type { ToggleConfig } from '../../host/featureToggles/types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { assertRunScopeOrg } from '../../host/accessControlService.js';
import { createLogger } from '../../observability/logger.js';
import { OpenwopError } from '../../types.js';
import { isPersonalTenantId } from '../../host/requestSubject.js';
import type { LogReasonCode } from '../../observability/logReasonCodes.js';
import { hasKicktodoEnrollmentAuthority, hasKicktodoManageAuthority, KICKTODO_MANAGE_SCOPE } from '../featureRoute.js';

const log = createLogger('kicktodo.surfaceBinding');

/** The per-tenant sub-toggle (ADR 0901 D5). */
export const KICKTODO_RUN_PRINCIPAL_BINDING_TOGGLE_ID = 'kicktodo-core.run-principal-binding';

/** Declared through `kicktodoCoreFeature.extraToggleDefaults`. User-facing copy:
 *  no ADR numbers and no default-state claims (`feature-copy-no-adr-refs`). */
export const KICKTODO_RUN_PRINCIPAL_BINDING_TOGGLE: ToggleConfig = {
  id: KICKTODO_RUN_PRINCIPAL_BINDING_TOGGLE_ID,
  label: 'KickTodo workflows act only for the person running them',
  description:
    'When on, KickTodo workflow steps act only for the person who started (or caused) the run: a step that names a different participant, or reads an enrollment, report or candidate that person may not open, is refused. When off, those steps run as before and each would-be refusal is recorded so the switch can be made safely.',
  category: 'KickTodo',
  status: 'off',
  bucketUnit: 'tenant',
  salt: 'kicktodo-core-run-principal-binding',
};

export type KicktodoLane = 'actor' | 'cause' | 'system';
export type KicktodoAuthority = 'none' | 'enrollment' | 'manage' | 'org-manage' | 'relation';

/** What one surface method declares to the binding (ADR 0901 D4). */
export interface KicktodoMethodSpec {
  /** The arg that names the person the method acts for. On a person lane it
   *  defaults to the person and must equal it. */
  subjectArg?: string;
  authority: KicktodoAuthority;
  /** For `enrollment`: the arg holding the enrollment id (default `enrollmentId`). */
  enrollmentArg?: string;
  /** For `org-manage`: the arg holding the org id (default `orgId`). */
  orgArg?: string;
  /** For `relation`: the surface's own predicate, asked with the run's person. */
  relation?: (tenantId: string, person: string, args: SurfaceArgs) => Promise<boolean>;
  /** No host job calls this method, so a system-lane call is refused. */
  personOnly?: boolean;
}

export type KicktodoSurfaceSpecs<K extends string = string> = Readonly<Record<K, KicktodoMethodSpec>>;

/** What a bound method's implementation learns about its call. */
export interface KicktodoBinding {
  lane: KicktodoLane;
  /** The run's person on a person lane; absent on the system lane. */
  person?: string;
  /** True when the toggle is ON for this tenant and the verdict was enforced. */
  enforced: boolean;
}

export type BoundSurfaceFn = (args: SurfaceArgs, binding: KicktodoBinding) => Promise<Record<string, unknown>>;

type Verdict =
  | { ok: true; args: SurfaceArgs }
  | { ok: false; reasonCode: LogReasonCode; error: OpenwopError };

export function kicktodoLaneOf(scope: Pick<BundleScope, 'actingUserId' | 'orgScopeSubject'>): { lane: KicktodoLane; person?: string } {
  if (scope.actingUserId) return { lane: 'actor', person: scope.actingUserId };
  if (scope.orgScopeSubject) return { lane: 'cause', person: scope.orgScopeSubject };
  return { lane: 'system' };
}

/** The tenant as a log field. A personal tenant id (`user:…`/`anon:…`) IS its
 *  owner's subject, and this module never logs a subject value, so it is
 *  reported by kind only. P3 reads the shared KickTodo workspace's log. */
const tenantField = (tenantId: string): string => (isPersonalTenantId(tenantId) ? 'personal' : tenantId);

const isAbsent = (v: unknown): boolean => v === undefined || v === null || v === '';

/** A refusal. `reasonCode` is the countable log field (ADR 0900 D2: a free
 *  `reason` log field is PII-hashed, so the closed vocabulary is what a P3
 *  shadow-log read can count); the error's `details.reason` is the shorter
 *  wire-side spelling. */
function deny(reasonCode: LogReasonCode, error: OpenwopError): Verdict {
  return { ok: false, reasonCode, error };
}

/** The verdict for one call. Never throws an `OpenwopError` refusal — refusals
 *  are returned, so shadow mode can log them; an unexpected fault (storage)
 *  propagates to the caller, which decides per mode. */
async function verdictFor(
  surfaceId: string,
  method: string,
  scope: BundleScope,
  lane: KicktodoLane,
  person: string | undefined,
  spec: KicktodoMethodSpec,
  raw: SurfaceArgs,
): Promise<Verdict> {
  const tenantId = scope.tenantId;
  if (lane === 'system' || !person) {
    if (spec.personOnly) {
      return deny('kicktodo_person_required', new OpenwopError('forbidden', `ctx.features['${surfaceId}'].${method} acts for a person, and this run has none.`, 403, { reason: 'person_required', surface: surfaceId, method }));
    }
    return { ok: true, args: raw };
  }

  const args: SurfaceArgs = { ...raw };
  if (spec.subjectArg) {
    const given = raw[spec.subjectArg];
    if (isAbsent(given)) args[spec.subjectArg] = person;
    else if (given !== person) {
      return deny('kicktodo_subject_mismatch', new OpenwopError('forbidden', `ctx.features['${surfaceId}'].${method} may only act for the person running this workflow.`, 403, { reason: 'subject_mismatch', surface: surfaceId, method, field: spec.subjectArg }));
    }
  }

  switch (spec.authority) {
    case 'none':
      return { ok: true, args };
    case 'enrollment': {
      const id = args[spec.enrollmentArg ?? 'enrollmentId'];
      if (typeof id === 'string' && await hasKicktodoEnrollmentAuthority(tenantId, id, person)) return { ok: true, args };
      // Uniform with the route: a foreign enrollment is indistinguishable from absent.
      return deny('kicktodo_enrollment_not_owned', new OpenwopError('not_found', 'Enrollment not found.', 404, { reason: 'enrollment_not_owned', surface: surfaceId, method }));
    }
    case 'manage': {
      // The route's `isOwnPersonalWorkspace(req)` short-circuit, run-lane form:
      // the actor's request-stamped personal tenant IS this tenant. Not for a
      // cause — a causing member is answered by the predicate alone.
      if (lane === 'actor' && scope.personalTenant && scope.personalTenant === tenantId) return { ok: true, args };
      if (await hasKicktodoManageAuthority(tenantId, person)) return { ok: true, args };
      return deny('kicktodo_manage_required', new OpenwopError('forbidden_scope', `Missing required scope: ${KICKTODO_MANAGE_SCOPE}`, 403, { requiredScope: KICKTODO_MANAGE_SCOPE, reason: 'manage_required', surface: surfaceId, method }));
    }
    case 'org-manage': {
      const orgId = args[spec.orgArg ?? 'orgId'];
      if (typeof orgId !== 'string' || orgId.length === 0) {
        return deny('kicktodo_org_required', new OpenwopError('validation_error', '`orgId` is required.', 400, { field: spec.orgArg ?? 'orgId', reason: 'org_required', surface: surfaceId, method }));
      }
      try {
        await assertRunScopeOrg(scope, orgId, 'host:org:manage');
        return { ok: true, args };
      } catch (err) {
        if (err instanceof OpenwopError) return deny('kicktodo_org_manage_required', err);
        throw err;
      }
    }
    case 'relation': {
      if (spec.relation && await spec.relation(tenantId, person, args)) return { ok: true, args };
      return deny('kicktodo_relation_denied', new OpenwopError('not_found', 'Not found.', 404, { reason: 'relation_denied', surface: surfaceId, method }));
    }
  }
}

/**
 * Wrap EVERY method of a KickTodo surface in the run-principal binding.
 *
 * `specs` must name exactly the methods `impl` has — the type requires a spec
 * for every impl key, and the build throws on a mismatch either way, so a new
 * method cannot ship unbound (ADR 0901 D4; `kicktodo-surface-run-principal.test.ts`
 * builds all nine surfaces to prove it).
 */
export function bindKicktodoSurface<I extends Record<string, BoundSurfaceFn>>(
  surfaceId: string,
  scope: BundleScope,
  impl: I,
  specs: NoInfer<{ readonly [K in keyof I]: KicktodoMethodSpec }>,
): FeatureSurface {
  const implKeys = Object.keys(impl).sort();
  const specKeys = Object.keys(specs).sort();
  const unbound = implKeys.filter((k) => !specKeys.includes(k));
  const stale = specKeys.filter((k) => !implKeys.includes(k));
  if (unbound.length || stale.length) {
    throw new Error(`kicktodo surface '${surfaceId}': every method needs exactly one run-principal spec (unbound: [${unbound.join(', ')}], no such method: [${stale.join(', ')}])`);
  }

  const { lane, person } = kicktodoLaneOf(scope);
  // One toggle read per surface per bundle (the executor builds a bundle per
  // node). Only a SUCCESSFUL read is remembered; a failure is retried.
  let enforcing: Promise<boolean> | undefined;
  const isEnforcing = (): Promise<boolean> => {
    if (!enforcing) {
      const attempt = resolveOne(KICKTODO_RUN_PRINCIPAL_BINDING_TOGGLE_ID, {
        tenantId: scope.tenantId,
        ...(scope.actingUserId ? { userId: scope.actingUserId } : {}),
      }).then((a) => !!a?.enabled);
      enforcing = attempt.catch((err: unknown) => {
        enforcing = undefined;
        log.warn('kicktodo_surface_binding_toggle_unresolved', {
          surface: surfaceId, tenant: tenantField(scope.tenantId), error: err instanceof Error ? err.message : String(err),
        });
        return false; // fail SAFE to shadow — today's posture
      });
    }
    return enforcing;
  };

  const out: FeatureSurface = {};
  for (const method of implKeys) {
    const fn = impl[method]!;
    const spec: KicktodoMethodSpec = specs[method as keyof I];
    out[method] = async (raw) => {
      const original: SurfaceArgs = { ...(raw ?? {}) };
      const enforce = await isEnforcing();
      let verdict: Verdict;
      try {
        verdict = await verdictFor(surfaceId, method, scope, lane, person, spec, original);
      } catch (err) {
        if (enforce) throw err;
        // Shadow mode must never change today's behaviour, not even on a fault
        // in the predicate's own reads.
        log.warn('kicktodo_surface_binding_unverified', {
          surface: surfaceId, method, lane, tenant: tenantField(scope.tenantId), error: err instanceof Error ? err.message : String(err),
          ...(scope.runId ? { runId: scope.runId } : {}),
        });
        return fn(original, { lane, ...(person ? { person } : {}), enforced: false });
      }
      if (!verdict.ok) {
        // A closed reason code only — never a subject value.
        log.info(enforce ? 'kicktodo_surface_refused' : 'kicktodo_surface_unbound', {
          surface: surfaceId, method, lane, reasonCode: verdict.reasonCode, tenant: tenantField(scope.tenantId),
          ...(scope.runId ? { runId: scope.runId } : {}),
        });
        if (enforce) throw verdict.error;
        return fn(original, { lane, ...(person ? { person } : {}), enforced: false });
      }
      if (lane === 'system') {
        // D2 — the system lane is a NAMED branch, not an implicit pass.
        log.debug('kicktodo_surface_system_lane', { surface: surfaceId, method, tenant: tenantField(scope.tenantId), ...(scope.runId ? { runId: scope.runId } : {}) });
      }
      return enforce
        ? fn(verdict.args, { lane, ...(person ? { person } : {}), enforced: true })
        : fn(original, { lane, ...(person ? { person } : {}), enforced: false });
    };
  }
  return out;
}
