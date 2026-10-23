/**
 * ADR 0910 D3/D5/D6/D7 — just-in-time `kicktodo-operator` activation for an
 * eligible (allowlisted) superadmin on a system-owned declared default workspace.
 *
 * The authority itself is decided at USE time by `operatorActivationLedger.ts`
 * (D4); this module owns the acts: activate (guards G1–G8), revoke, list, the
 * self-approval predicate (D5), the notices (D6), the sweep (D7) and the DSAR
 * eraser. Guards that read the REQUEST (G1–G5) live in the route; this module
 * takes their verified results and enforces the target, duration and audit-first
 * rules itself, so a second caller cannot skip them.
 */
import { randomUUID } from 'node:crypto';
import { appendAudit } from './auditChainService.js';
import { createMember, getWorkspace, isDeclaredDefaultWorkspace, isWorkspaceOrg, listMembers } from './accessControlService.js';
import { declaredDefaultWorkspaceTargets } from './workspaceJoinLedger.js';
import { listedSuperadminTenants } from './superadmin.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { getNotificationEmitter } from '../notifications/emitter.js';
import { runNoticeAudience } from '../notifications/runNoticeAudience.js';
import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';
import { isActivationLive, liveOperatorActivation, operatorActivations, type OperatorActivation } from './operatorActivationLedger.js';

const log = createLogger('host.operatorAccess');

export const OPERATOR_DEFAULT_MINUTES = 480;
export const OPERATOR_MAX_MINUTES = 480;
export const OPERATOR_MIN_MINUTES = 15;
export const OPERATOR_JUSTIFICATION_MIN = 10;
export const OPERATOR_JUSTIFICATION_MAX = 500;

const NOTICE_TYPE = 'security.operator-access';

/** G6 — the workspace an activation may target: a declared default workspace whose
 *  root org exists and was created by the SYSTEM. Anything else is a uniform 404,
 *  so a superadmin can never activate inside a customer's `ws:` workspace. */
export async function assertOperatorTarget(workspaceId: string): Promise<void> {
  const declared = declaredDefaultWorkspaceTargets().some((t) => t.tenantId === workspaceId);
  const org = declared && isDeclaredDefaultWorkspace(workspaceId) ? await getWorkspace(workspaceId) : null;
  if (!org || !isWorkspaceOrg(org) || org.createdBy !== 'system') {
    throw new OpenwopError('not_found', 'Not found.', 404);
  }
}

export interface ActivateInput {
  workspaceId: string;
  /** The member subject (`req.userId`), verified by the route (G2). */
  subject: string;
  /** The allowlisted PERSONAL tenant that made the caller eligible (G1). */
  eligibilityTenant: string;
  justification: unknown;
  durationMinutes?: unknown;
  /** Facts the route verified, recorded on the audit row. */
  ip?: string;
  authTime?: number;
}

/** G5 + G7 — validation that does not depend on the request. */
function validated(input: ActivateInput): { justification: string; minutes: number } {
  const j = typeof input.justification === 'string' ? input.justification.trim() : '';
  if (j.length < OPERATOR_JUSTIFICATION_MIN || j.length > OPERATOR_JUSTIFICATION_MAX) {
    throw new OpenwopError('validation_error', `A justification of ${OPERATOR_JUSTIFICATION_MIN}-${OPERATOR_JUSTIFICATION_MAX} characters is required.`, 400, { field: 'justification' });
  }
  const raw = input.durationMinutes === undefined ? OPERATOR_DEFAULT_MINUTES : input.durationMinutes;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < OPERATOR_MIN_MINUTES || raw > OPERATOR_MAX_MINUTES) {
    // Never clamped silently: a caller asking for more than the cap is told so.
    throw new OpenwopError('validation_error', `durationMinutes must be an integer from ${OPERATOR_MIN_MINUTES} to ${OPERATOR_MAX_MINUTES}.`, 400, { field: 'durationMinutes' });
  }
  return { justification: j, minutes: raw };
}

/** D3 — activate. G6–G8 enforced here; the route enforces G1–G5 first. */
export async function activateOperatorAccess(input: ActivateInput, now = new Date()): Promise<OperatorActivation> {
  await assertOperatorTarget(input.workspaceId);
  const { justification, minutes } = validated(input);
  const key = `${input.workspaceId}::${input.subject}`;
  const prior = await operatorActivations.get(key);
  if (isActivationLive(prior, now.getTime())) {
    throw new OpenwopError('conflict', 'An operator activation is already live.', 409, { code: 'already_active', expiresAt: prior.expiresAt });
  }
  const activation: OperatorActivation = {
    activationId: `opa_${randomUUID()}`,
    workspaceId: input.workspaceId,
    subject: input.subject,
    eligibilityTenant: input.eligibilityTenant,
    justification,
    activatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
  };
  // G8 — audit FIRST: a failed append means no activation (the caller gets 500).
  await appendAudit(input.workspaceId, 'security.operator-access-activated', {
    activationId: activation.activationId,
    subject: input.subject,
    justification,
    expiresAt: activation.expiresAt,
    mfa: true,
    ...(input.ip ? { ip: input.ip } : {}),
    ...(input.authTime !== undefined ? { authTime: input.authTime } : {}),
  });
  // The participant floor, so the operator can switch in. An existing root row is
  // NOT touched (`createMember` returns it unchanged for a root relationship).
  await createMember({ tenantId: input.workspaceId, orgId: input.workspaceId, displayName: 'Operator', subject: input.subject, roles: ['viewer'] });
  // Replaces an expired/revoked prior row; a racing live activation is refused.
  if (!(await operatorActivations.compareAndSwap(prior ?? null, activation))) {
    throw new OpenwopError('conflict', 'An operator activation is already live.', 409, { code: 'already_active' });
  }
  await notifyOtherSuperadmins(input.eligibilityTenant, 'activated', activation);
  log.info('operator_access_activated', { workspaceId: input.workspaceId, activationId: activation.activationId, expiresAt: activation.expiresAt });
  return activation;
}

/** D7.1 — revoke (self, or another eligible superadmin). Authority ends at the next resolution. */
export async function revokeOperatorAccess(workspaceId: string, subject: string, by: string, byEligibilityTenant: string): Promise<boolean> {
  await assertOperatorTarget(workspaceId);
  const key = `${workspaceId}::${subject}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await operatorActivations.get(key);
    if (!current || current.revokedAt || current.retiredAt) return false;
    const revoked: OperatorActivation = { ...current, revokedAt: new Date().toISOString(), revokedBy: by };
    if (!(await operatorActivations.compareAndSwap(current, revoked))) continue;
    // Revocation REMOVES authority, so it lands first and is audited after (an
    // audit failure must not leave a live activation behind).
    await appendAudit(workspaceId, 'security.operator-access-revoked', { activationId: current.activationId, subject, by });
    await notifyOtherSuperadmins(byEligibilityTenant, 'revoked', revoked);
    return true;
  }
  throw new OpenwopError('conflict', 'The activation kept changing; retry.', 409);
}

/** D3 GET — every ledger row for the workspace (current activations, live or not). */
export async function listOperatorActivations(workspaceId: string): Promise<OperatorActivation[]> {
  await assertOperatorTarget(workspaceId);
  return (await operatorActivations.listForTenantIndexed(workspaceId))
    .filter((a) => a.workspaceId === workspaceId && !a.retiredAt)
    .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));
}

/**
 * D5 — the ONE self-approval predicate: the activation id when (workspace, subject)
 * holds a LIVE activation AND still holds the root membership, else null. Asked at
 * BOTH separation sites (decide eligibility and `completePublication`).
 */
export async function operatorSelfApprovalActivation(tenantId: string, subject: string): Promise<string | null> {
  if (!isDeclaredDefaultWorkspace(tenantId)) return null;
  const live = await liveOperatorActivation(tenantId, subject);
  if (!live) return null;
  const root = (await listMembers(tenantId, tenantId)).some((m) => m.subject === subject);
  return root ? live.activationId : null;
}

/** D6 — notify the OTHER listed superadmins only (never the participant roster). */
async function notifyOtherSuperadmins(actorEligibilityTenant: string, event: 'activated' | 'revoked' | 'expired', a: OperatorActivation): Promise<void> {
  const recipients = listedSuperadminTenants().filter((t) => !t.startsWith('anon:') && t !== actorEligibilityTenant);
  const verb = event === 'activated' ? 'activated' : event === 'revoked' ? 'was revoked' : 'expired';
  for (const tenantId of recipients) {
    const audience = runNoticeAudience({ tenantId });
    try {
      await getNotificationEmitter().emit({
        tenantId,
        ...(audience.recipientRole ? { recipientRole: audience.recipientRole } : {}),
        type: NOTICE_TYPE,
        priority: 'normal',
        title: `Operator access ${verb} on ${a.workspaceId}`,
        message: `An operator activation on ${a.workspaceId} ${verb}. It ${event === 'activated' ? 'expires' : 'was due to expire'} at ${a.expiresAt}.`,
        metadata: { kind: NOTICE_TYPE, event, workspaceId: a.workspaceId, activationId: a.activationId, expiresAt: a.expiresAt },
      });
    } catch (err) {
      log.warn('operator_access_notice_failed', { event, workspaceId: a.workspaceId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export interface OperatorSweepOutcome { expired: number; delisted: number; memberless: number; cleaned: number }

/**
 * ADR 0910 D7.3 — the boot pass and hourly sweep. For each ledger row that is
 * expired, de-listed, member-less or already revoked: write the matching audit row
 * before retiring the exact reviewed row (a revoked row was already audited).
 * Only the CAS winner notifies other listed superadmins (D6). Retained inactive
 * markers prevent a stale sweep deleting a replacement activation. Bounded: it
 * lists the ledger, never the roster. It decides NO authority — D4 already refuses every such row at use time;
 * this is the access review and the expiry record.
 */
export async function sweepOperatorActivations(now = new Date()): Promise<OperatorSweepOutcome> {
  const out: OperatorSweepOutcome = { expired: 0, delisted: 0, memberless: 0, cleaned: 0 };
  for (const a of await operatorActivations.list()) {
    if (a.retiredAt) continue;
    if (a.revokedAt) {
      if (!(await operatorActivations.compareAndSwap(a, { ...a, retiredAt: now.toISOString() }))) continue;
      out.cleaned += 1;
      continue;
    }
    let event: 'expired' | 'delisted' | 'memberless' | null = null;
    if (Date.parse(a.expiresAt) <= now.getTime()) event = 'expired';
    else if (!isActivationLive(a, now.getTime())) event = 'delisted';
    else if (!(await listMembers(a.workspaceId, a.workspaceId)).some((m) => m.subject === a.subject)) event = 'memberless';
    if (!event) continue;
    if (event === 'expired') {
      await appendAudit(a.workspaceId, 'security.operator-access-expired', { activationId: a.activationId, subject: a.subject, expiresAt: a.expiresAt });
    } else {
      await appendAudit(a.workspaceId, 'security.operator-access-revoked', {
        activationId: a.activationId, subject: a.subject, by: event === 'delisted' ? 'eligibility-review' : 'membership-removed',
      });
    }
    // Audit first keeps an audit failure retryable. Racing sweeps may record
    // the same ended activation more than once, but only one retires/notifies;
    // none may remove a newly activated replacement at this key.
    if (!(await operatorActivations.compareAndSwap(a, { ...a, retiredAt: now.toISOString() }))) continue;
    await notifyOtherSuperadmins(a.eligibilityTenant, event === 'expired' ? 'expired' : 'revoked', a);
    out[event] += 1;
  }
  if (out.expired + out.delisted + out.memberless + out.cleaned > 0) log.info('operator_access_swept', { ...out });
  return out;
}

export interface OperatorSweepDaemon { stop: () => void }
const SWEEP_INTERVAL_MS = 60 * 60_000;

/** The hourly sweep (the `startFunnelWeeklySummaryDaemon` shape: ±20% jitter,
 *  unref'd, re-entrancy guarded). The boot pass is the caller's first `sweep`. */
export function startOperatorAccessSweepDaemon(): OperatorSweepDaemon {
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try { await sweepOperatorActivations(); } catch (err) {
      log.warn('operator_access_sweep_error', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const schedule = (): void => {
    timer = setTimeout(() => { void tick().finally(() => { if (!stopped) schedule(); }); }, SWEEP_INTERVAL_MS * (0.8 + Math.random() * 0.4));
    timer.unref?.();
  };
  void tick().finally(() => { if (!stopped) schedule(); }); // the boot pass (D7.3)
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

/** ADR 0910 D10 — counts for KickTodo readiness. */
export async function operatorAccessCounts(workspaceId: string): Promise<{ eligible: number; live: number }> {
  const rows = await operatorActivations.listForTenantIndexed(workspaceId);
  return {
    eligible: listedSuperadminTenants().filter((t) => !t.startsWith('anon:')).length,
    live: rows.filter((a) => a.workspaceId === workspaceId && isActivationLive(a)).length,
  };
}

/** DSAR — point-delete the subject's activation rows; the audit chain keeps the
 *  history under ADR 0464's audit rules. */
async function eraseSubjectOperatorActivations(tenantId: string, subjectKey: string): Promise<void> {
  await operatorActivations.delete(`${tenantId}::${subjectKey}`);
}

/** Register the DSAR eraser (host-erasers boot step). */
export function registerOperatorAccessErasure(): void {
  registerSubjectEraser(eraseSubjectOperatorActivations);
}
