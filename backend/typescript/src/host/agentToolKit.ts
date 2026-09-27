/**
 * agentToolKit — the shared primitives every `features/*​/agentTools.ts` file
 * re-declared (CFPT-1 / CFPT-1b / CFPT-1c / CFPT-6). Extracting them into one
 * module removes ~40 hand-copied `toolError` / `str` / toggle-resolution /
 * org-scope-gate declarations and, critically, converges their DRIFT:
 *
 *  - CFPT-1b — the toggle subject is now ALWAYS the routes' subject shape
 *    `{ tenantId, userId? }` (via {@link resolveFeatureToggle}). Several files
 *    resolved TENANT-ONLY, so a `user`-bucketed / beta-cohort toggle read the
 *    wrong assignment for the acting user (forms + kicktodo-community among
 *    others). One helper, one subject shape.
 *  - CFPT-1c — the DISABLED-READ posture is unified on TYPED `feature_disabled`
 *    (the MAJORITY: dealers / cad / drawings / accessibility / priority-matrix
 *    and ~20 pinned test suites; forms / analytics / comments were the
 *    empty-note minority, now converged). A read tool with no acting user still
 *    fails EMPTY (the universal "no probe without a human" rule), but a read
 *    whose feature is OFF returns the typed `feature_disabled` error. See
 *    {@link resolveReadOrgScope}.
 *  - CFPT-6 — failures now emit ONE structured warn line via
 *    {@link toolFailLog} before returning the typed `tool_failed` result, so a
 *    tool that throws is observable instead of silently generic.
 *
 * These are the ONE canonical shapes; do not re-declare them in a feature file.
 */

import { resolveOne } from './featureToggles/service.js';
import type { ToggleSubject } from './featureToggles/types.js';
import type { BundleScope } from './inMemorySurfaces.js';
import { listOrgs, resolveEffectiveAccess, type Scope } from './accessControlService.js';
import type { Logger } from '../observability/logger.js';

/** The shape a `BuiltinTool.run` returns: a JSON string + an error flag the
 *  conversation loop surfaces verbatim to the model. */
export type ToolResult = { content: string; isError?: boolean };

/** Success — JSON-stringify the payload the tool read/produced. */
export const toolOk = (payload: unknown): ToolResult => ({ content: JSON.stringify(payload) });

/** Fail-EMPTY — the read-tool posture. Same wire shape as {@link toolOk}; the
 *  name marks intent (no acting user / feature off / no accessible scope ⇒ an
 *  annotated empty payload, never an error or a probe). */
export const toolEmpty = (payload: unknown): ToolResult => ({ content: JSON.stringify(payload) });

/** Typed failure — the action-tool posture. `code` is a stable machine token,
 *  `message` is the actionable line the model reads; `details` merges extra
 *  fields onto the payload. NEVER success-with-empty for invalid model input. */
export const toolError = (code: string, message: string, details?: Record<string, unknown>): ToolResult => ({
  content: JSON.stringify({ error: code, message, ...(details ?? {}) }),
  isError: true,
});

/** Coerce a model-supplied value to a trimmed non-empty string, else undefined.
 *  The canonical input-arg reader (25+ files used this exact shape). */
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Resolve a feature toggle for the ACTING SUBJECT (CFPT-1b). ALWAYS builds the
 *  routes' subject shape `{ tenantId, userId? }` so a `user`-bucketed / beta
 *  toggle resolves for the same principal the HTTP route would. Fail-closed:
 *  a resolver throw ⇒ `false` (feature treated as off). */
export async function resolveFeatureToggle(featureId: string, scope: BundleScope): Promise<boolean> {
  const subject: ToggleSubject = {
    tenantId: scope.tenantId,
    ...(scope.actingUserId ? { userId: scope.actingUserId } : {}),
  };
  const assignment = await resolveOne(featureId, subject).catch(() => null);
  return Boolean(assignment?.enabled);
}

/** Org-scope READ gate — the read-tool sibling of the routes' `authorizeOrgScope`
 *  / `resolveEffectiveAccess(requiredScope)`, in the MAJORITY three-way shape
 *  (the dealers precedent). Branches:
 *   - no acting user ⇒ `{ kind: 'empty' }` — the caller returns its own empty
 *     payload (no probe from a system/scheduled turn);
 *   - feature OFF ⇒ `{ kind: 'error' }` carrying the TYPED `feature_disabled`
 *     result (CFPT-1c majority posture);
 *   - ambiguous org (>1, none passed) ⇒ TYPED `org_required`;
 *   - unknown org / missing scope ⇒ `{ kind: 'empty' }` (fail-closed, silent);
 *   - else ⇒ `{ kind: 'ok', orgId }`.
 *  `requiredScope` defaults to `workspace:read`. */
export type OrgReadResolve =
  | { kind: 'ok'; orgId: string }
  | { kind: 'empty'; note: string }
  | { kind: 'error'; result: ToolResult };
export async function resolveReadOrgScope(
  scope: BundleScope,
  opts: { featureId: string; featureLabel: string; requiredScope?: Scope },
  orgIdInput?: string,
): Promise<OrgReadResolve> {
  const requiredScope: Scope = opts.requiredScope ?? 'workspace:read';
  if (!scope.actingUserId) return { kind: 'empty', note: 'This tool only reads from a human-initiated turn.' };
  if (!(await resolveFeatureToggle(opts.featureId, scope))) {
    return { kind: 'error', result: toolError('feature_disabled', `The ${opts.featureLabel} feature is not enabled for this workspace.`) };
  }
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return { kind: 'error', result: toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\`.`) };
  if (!orgs.some((o) => o.orgId === orgId)) return { kind: 'empty', note: 'Organization not found in this workspace.' };
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: scope.actingUserId, orgId });
  if (!access.scopes.includes(requiredScope)) return { kind: 'empty', note: 'You do not have read access to that organization.' };
  return { kind: 'ok', orgId };
}

/** Org-scope ACTION gate — the write-tool sibling. Same resolution as
 *  {@link resolveReadOrgScope} but FAILS TYPED (returns a `toolError` result the
 *  caller returns directly) so an action never silently no-ops. `requiredScope`
 *  defaults to `workspace:write`. */
export type OrgActionResolve = { orgId: string; actingUserId: string } | { error: ToolResult };
export async function resolveActionOrgScope(
  scope: BundleScope,
  opts: { featureId: string; featureLabel: string; requiredScope?: Scope },
  orgIdInput?: string,
): Promise<OrgActionResolve> {
  const requiredScope: Scope = opts.requiredScope ?? 'workspace:write';
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return { error: toolError('acting_user_required', 'This tool needs a human-initiated turn.') };
  if (!(await resolveFeatureToggle(opts.featureId, scope))) {
    return { error: toolError('feature_disabled', `The ${opts.featureLabel} feature is not enabled for this workspace.`) };
  }
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return { error: toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\`.`) };
  if (!orgs.some((o) => o.orgId === orgId)) return { error: toolError('org_not_found', 'Organization not found in this workspace.') };
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes(requiredScope)) {
    return { error: toolError('forbidden', 'You do not have write access to that organization.') };
  }
  return { orgId, actingUserId };
}

/** CFPT-6 — emit ONE structured warn line for a tool failure, then return the
 *  typed `tool_failed` result. Makes a thrown tool observable (which tool, what
 *  error) instead of a bare generic message. Pass `message` to override the
 *  model-facing line. */
export function toolFailLog(logger: Logger, toolId: string, err: unknown, message?: string): ToolResult {
  logger.warn('agent_tool_failed', {
    toolId,
    error: err instanceof Error ? err.message : String(err),
  });
  return toolError('tool_failed', message ?? 'The tool failed to complete. Try again or narrow the request.');
}
