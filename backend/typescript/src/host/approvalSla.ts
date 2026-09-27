/**
 * ADR 0478 §1 — the approval SLA/escalation ladder. The `service-desk/sla.ts`
 * pattern over approvals, with one structural improvement: NO create/resolve
 * hooks. The sweep walks tenants that HAVE an enabled policy (the policy
 * store is the small set), lists that tenant's PENDING approvals through the
 * existing (tenant,status) index, and keeps per-approval rung state on a
 * lazy ladder row — CAS-advanced so each rung fires EXACTLY ONCE across
 * instances (the ADR 0477 HIGH-1 lesson applied up front).
 *
 * Rungs (each optional; policy disabled ⇒ today's behavior exactly):
 *   remind   → re-notify the addressed approvers ("awaiting your review").
 *   escalate → notify the approvers' ACTIVE DELEGATES (ADR 0198); the rung
 *              only NOTIFIES — decide authority is unchanged (delegates
 *              already held it). No delegates ⇒ a high-priority broadcast.
 *   expire   → resolveApproval(rejected, 'sla_expired') — fail-closed, opt-in.
 * Every fire is a governance-visible notification + audit row via the
 * emitter/resolve seams it composes.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { getNotificationEmitter } from '../notifications/emitter.js';
import { runNoticeAudience } from '../notifications/runNoticeAudience.js';
import { listApprovals, resolveApproval, type PendingApproval } from './approvalService.js';
import { activeDelegations } from './approvalDelegations.js';
import { kindHasRejectSideEffects } from './approvalDecision.js';
import { approvalRecipients } from './approvalAudience.js';
import { OpenwopError } from '../types.js';

const log = createLogger('host.approvalSla');

/* ── policy ─────────────────────────────────────────────────────────────── */

export interface ApprovalSlaPolicy {
  tenantId: string;
  enabled: boolean;
  /** Rung 1 — re-notify after this age (ms). Absent = rung off. */
  remindAfterMs?: number;
  /** Rung 2 — notify delegates/broadcast after this age (ms). */
  escalateAfterMs?: number;
  /** Rung 3 — auto-reject after this age (ms). Off by default (OQ2). */
  expireAfterMs?: number;
  updatedAt: string;
  updatedBy?: string;
}

const policies = new DurableCollection<ApprovalSlaPolicy>(
  'approval:sla-policy',
  (p) => p.tenantId,
  undefined,
  (p) => p.tenantId,
);

const MIN_RUNG_MS = 60_000;          // a rung below the sweep cadence is a lie
const MAX_RUNG_MS = 90 * 24 * 3_600_000;

function validRungMs(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < MIN_RUNG_MS || v > MAX_RUNG_MS) {
    throw new OpenwopError('validation_error', `${name} must be ${MIN_RUNG_MS}..${MAX_RUNG_MS} ms.`, 400, {});
  }
  return Math.floor(v);
}

export async function getApprovalSlaPolicy(tenantId: string): Promise<ApprovalSlaPolicy | null> {
  return policies.get(tenantId);
}

export async function setApprovalSlaPolicy(input: {
  tenantId: string; enabled: boolean;
  remindAfterMs?: unknown; escalateAfterMs?: unknown; expireAfterMs?: unknown;
  updatedBy?: string;
}): Promise<ApprovalSlaPolicy> {
  const remind = validRungMs(input.remindAfterMs, 'remindAfterMs');
  const escalate = validRungMs(input.escalateAfterMs, 'escalateAfterMs');
  const expire = validRungMs(input.expireAfterMs, 'expireAfterMs');
  if (input.enabled && remind === undefined && escalate === undefined && expire === undefined) {
    throw new OpenwopError('validation_error', 'An enabled policy needs at least one rung.', 400, {});
  }
  // Rungs must be ordered when co-present (a reminder after expiry is noise).
  const ordered = [remind, escalate, expire].filter((v): v is number => v !== undefined);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]! <= ordered[i - 1]!) {
      throw new OpenwopError('validation_error', 'Rungs must be strictly increasing: remind < escalate < expire.', 400, {});
    }
  }
  const row: ApprovalSlaPolicy = {
    tenantId: input.tenantId,
    enabled: input.enabled === true,
    ...(remind !== undefined ? { remindAfterMs: remind } : {}),
    ...(escalate !== undefined ? { escalateAfterMs: escalate } : {}),
    ...(expire !== undefined ? { expireAfterMs: expire } : {}),
    updatedAt: new Date().toISOString(),
    ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
  };
  await policies.put(row);
  return row;
}

/* ── ladder state ───────────────────────────────────────────────────────── */

type Rung = 'remind' | 'escalate' | 'expire';

interface ApprovalLadderRow {
  /** `${tenantId}:${approvalId}` */
  key: string;
  tenantId: string;
  approvalId: string;
  firedRungs: Rung[];
}

const ladders = new DurableCollection<ApprovalLadderRow>(
  'approval:sla-ladder',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

/* ── the sweep ──────────────────────────────────────────────────────────── */

/** One pass — exported for tests; the interval calls it. Returns rung fires. */
export async function sweepApprovalSla(now = new Date()): Promise<number> {
  const allPolicies = await policies.list();
  // Review MEDIUM-2 — a tenant that DISABLED its policy still gets ladder-row
  // hygiene (rows must not linger forever behind a switched-off policy).
  for (const p of allPolicies.filter((x) => !x.enabled)) {
    for (const l of await ladders.listByPrefix(`${p.tenantId}:`)) await ladders.delete(l.key);
  }
  const activePolicies = allPolicies.filter((p) => p.enabled);
  let fires = 0;
  for (const policy of activePolicies) {
    const pending = await listApprovals(policy.tenantId, 'pending');
    const laddersByKey = new Map(
      (await ladders.listByPrefix(`${policy.tenantId}:`)).map((l) => [l.key, l]),
    );
    // Opportunistic hygiene: drop ladder rows whose approval is no longer pending.
    const pendingIds = new Set(pending.map((a) => a.approvalId));
    for (const l of laddersByKey.values()) {
      if (!pendingIds.has(l.approvalId)) await ladders.delete(l.key);
    }
    for (const approval of pending) {
      const ageMs = now.getTime() - Date.parse(approval.createdAt);
      if (!Number.isFinite(ageMs) || ageMs <= 0) continue;
      const key = `${policy.tenantId}:${approval.approvalId}`;
      const row = laddersByKey.get(key) ?? { key, tenantId: policy.tenantId, approvalId: approval.approvalId, firedRungs: [] as Rung[] };
      const due: Rung[] = [];
      if (policy.remindAfterMs !== undefined && ageMs >= policy.remindAfterMs && !row.firedRungs.includes('remind')) due.push('remind');
      if (policy.escalateAfterMs !== undefined && ageMs >= policy.escalateAfterMs && !row.firedRungs.includes('escalate')) due.push('escalate');
      if (policy.expireAfterMs !== undefined && ageMs >= policy.expireAfterMs && !row.firedRungs.includes('expire')) due.push('expire');
      if (due.length === 0) continue;
      // Exactly-once across instances: CAS the ladder row FIRST; the loser of
      // the race skips (the winner executes the rungs).
      const next: ApprovalLadderRow = { ...row, firedRungs: [...row.firedRungs, ...due] };
      const existing = laddersByKey.get(key) ?? null;
      const won = await ladders.compareAndSwap(existing, next);
      if (!won) continue; // another instance advanced this ladder — it fires
      let advanced = next;
      for (const rung of due) {
        fires += 1;
        try {
          await fireRung(rung, policy, approval);
        } catch (err) {
          log.warn('approval_sla_rung_failed', { approvalId: approval.approvalId, rung, error: err instanceof Error ? err.message : String(err) });
          // Grade-code M6 — a thrown fire after the CAS win was permanently
          // LOST (at-most-once): the rung stayed recorded as fired. CAS it
          // back out so the next sweep retries. Best-effort: a lost CAS here
          // means another instance advanced the row — leave theirs standing
          // (a duplicate reminder beats a silently missed expire).
          const rolledBack: ApprovalLadderRow = { ...advanced, firedRungs: advanced.firedRungs.filter((r) => r !== rung) };
          if (await ladders.compareAndSwap(advanced, rolledBack)) advanced = rolledBack;
        }
      }
    }
  }
  return fires;
}

async function fireRung(rung: Rung, policy: ApprovalSlaPolicy, approval: PendingApproval): Promise<void> {
  const { refs: audienceRefs, redact } = await audienceForRung(approval);
  const title = rungTitle(approval, redact);
  if (rung === 'remind') {
    await notifyRefs(policy.tenantId, audienceRefs, {
      type: 'approval.sla-reminder',
      priority: 'high',
      title: 'Still awaiting your review',
      message: `“${title}” has been waiting since ${approval.createdAt}.`,
      approvalId: approval.approvalId,
    });
    return;
  }
  if (rung === 'escalate') {
    const refs = audienceRefs;
    const { byPrincipal } = await activeDelegations(policy.tenantId);
    const delegates = new Set<string>();
    for (const ref of refs) {
      for (const delegate of byPrincipal.get(ref) ?? []) delegates.add(delegate);
    }
    if (delegates.size > 0) {
      await notifyRefs(policy.tenantId, [...delegates], {
        type: 'approval.sla-escalated',
        priority: 'high',
        title: 'Escalated to you (delegation)',
        message: `“${title}” passed its escalation deadline; you are an active delegate for an approver.`,
        approvalId: approval.approvalId,
      });
    } else {
      // ADR correction (implementation): the admin-lookup fallback is an
      // org-scoped complexity this rung doesn't need — an UNADDRESSED
      // high-priority broadcast reaches the tenant's inbox surface.
      await notifyRefs(policy.tenantId, [], {
        type: 'approval.sla-escalated',
        priority: 'high',
        title: 'Approval overdue — no delegate available',
        message: `“${title}” passed its escalation deadline and none of its approvers has an active delegation.`,
        approvalId: approval.approvalId,
      });
    }
    return;
  }
  // expire — the fail-closed deadline (opt-in).
  // Review HIGH-3 — kinds whose reject runs FEATURE side effects (page
  // transitions, merges, draft archival) must never be raw-rejected by a
  // system actor: the row would flip while the feature state wedges. Those
  // get a LOUD overdue notification instead of a forced decision.
  if (kindHasRejectSideEffects(approval.kind)) {
    await notifyRefs(policy.tenantId, audienceRefs, {
      type: 'approval.sla-expired',
      priority: 'high',
      title: 'Approval past its deadline — needs a human decision',
      message: `“${title}” passed the expiry deadline, but this approval kind requires a human decision (auto-reject would strand its feature state).`,
      approvalId: approval.approvalId,
    });
    return;
  }
  const lock = await resolveApproval(approval.approvalId, { status: 'rejected', note: 'sla_expired', decidedBy: 'system:sla-expiry' });
  // Review MEDIUM-1 — a human may have decided seconds before the sweep: the
  // CAS tells the truth; never announce an auto-reject that didn't happen.
  if (!lock?.changed) return;
  await notifyRefs(policy.tenantId, audienceRefs, {
    type: 'approval.sla-expired',
    priority: 'high',
    title: 'Approval expired unanswered',
    message: `“${title}” was auto-rejected after its SLA deadline (policy rung 3).`,
    approvalId: approval.approvalId,
  });
}

/**
 * ADR 0672 D1 (`CMSAWF-11`) — who this rung addresses, and what it is allowed to say.
 *
 * This used to be `approval.policy?.approverRefs ?? []`. **No CMS lane sets `policy`**, so
 * for every content-publish row the list was empty — and an empty list means `notifyRefs`
 * emits with NO `recipientUserId`, which is a true broadcast on FOUR lanes: the inbox
 * (`recipient_user_id IS NULL`), the SSE stream, **Web Push — putting the page title on
 * every device's lock screen** — and, correctly excluded, email/Teams. Two other surfaces
 * spend code hiding that exact row from members who cannot manage its org.
 *
 * `refs` non-empty ⇒ address them. `refs` EMPTY for an audience-ruled kind ⇒ we could not
 * name a recipient, so the rung falls back to a tenant-wide emit with the proposal
 * **REDACTED** to a kind-generic string: existence without content. That case is reachable
 * today — `SYSTEM_SITE_ORG` is created with no members (`host/systemSite.ts:167-169`) and
 * `kindHasRejectSideEffects('content-publish')` is true, so the expire rung never
 * auto-closes such a row. Emitting nothing would strand it silently forever.
 */
async function audienceForRung(approval: PendingApproval): Promise<{ refs: string[]; redact: boolean }> {
  const { addressed, refs } = await approvalRecipients(approval.tenantId, approval);
  if (!addressed) return { refs: [], redact: false };  // genuinely tenant-scoped kind
  return { refs, redact: refs.length === 0 };
}

/** The title a rung may use: the real proposal, or a kind-generic stand-in when the row has
 *  an audience we could not resolve to anyone. */
function rungTitle(approval: PendingApproval, redact: boolean): string {
  if (redact) return `a pending ${approval.kind ?? 'run-proposal'} review`;
  return approval.proposal.length > 80 ? `${approval.proposal.slice(0, 77)}…` : approval.proposal;
}

async function notifyRefs(
  tenantId: string,
  refs: string[],
  n: { type: string; priority: 'high'; title: string; message: string; approvalId: string },
): Promise<void> {
  // ADR 0710 — the conditional spread below USED to be the whole story: absent
  // recipient, no address, tenant-wide broadcast on four lanes including Web Push.
  // An absent recipient is now an OPERATOR notice, not a broadcast. This is the
  // "conditionally addressed" shape the ADR calls the sharpest of the eleven: it
  // reads as targeted at a glance and fails open only on the branch nobody tests.
  const fallback = runNoticeAudience({ tenantId });
  const emit = (recipientUserId?: string) =>
    getNotificationEmitter().emit({
      tenantId,
      ...(recipientUserId
        ? { recipientUserId }
        : (fallback.recipientRole ? { recipientRole: fallback.recipientRole } : {})),
      type: n.type,
      priority: n.priority,
      title: n.title,
      message: n.message,
      actionUrl: `/inbox?approval=${encodeURIComponent(n.approvalId)}`,
      metadata: { approvalId: n.approvalId, kind: n.type },
    });
  if (refs.length === 0) {
    await emit();
    return;
  }
  for (const ref of refs) {
    try {
      await emit(ref);
    } catch (err) {
      log.debug('approval_sla_notify_failed', { ref, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/* ── boot ───────────────────────────────────────────────────────────────── */

let handle: ReturnType<typeof setInterval> | null = null;

/** Boot the sweep interval (idempotent; own 60s cadence — the sla.ts rule:
 *  an SLA must fire within a minute of breach, not on retention cadence). */
export function startApprovalSlaSweep(): void {
  if (handle) return;
  const intervalMs = Number(process.env.OPENWOP_APPROVAL_SLA_SWEEP_MS) || 60_000;
  handle = setInterval(() => {
    void sweepApprovalSla().catch((err) => log.warn('approval_sla_sweep_failed', { error: String(err) }));
  }, intervalMs);
  handle.unref?.();
}
