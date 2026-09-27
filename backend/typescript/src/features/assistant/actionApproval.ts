/**
 * Assistant action ↔ approval-loop bridge (ADR 0023 §12 T4, the ADR 0025 §4
 * "no new approval store" pin made literal).
 *
 * - `enqueueActionWithApproval()` — the ONE enqueue path: writes the typed
 *   domain record (PendingAction), creates its PendingApproval on the host
 *   queue, back-links the two, and drops the Notifications-inbox item.
 * - `decideActionViaApproval()` — the ONE decision path, shared by
 *   `/v1/host/openwop-app/approvals/:id/{claim,reject}` (via the handler hook the
 *   feature registers at boot) and the assistant's own
 *   `/pending-actions/:id/{approve,reject}` routes: the CAS-guarded
 *   `resolveApproval` IS the decision; the PendingAction status is a
 *   projection of it. Execution on approve lands in T6 (runStarter + write
 *   scopes) — T4 records the decision only.
 */

import {
  createAssistantActionApproval,
  getApproval,
  resolveApproval,
  attachRunId,
  registerAssistantActionApprovalHandler,
  registerAssistantActionProjector,
  registerApprovalEligibility,
  reopenApproval,
  type AssistantActionDecision,
} from '../../host/approvalService.js';
import { OpenwopError } from '../../types.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { createHash } from 'node:crypto';
import { canonicalize } from '../../host/auditChainService.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import { stripSecretsFromPersisted } from '../../byok/ephemeralRunSecrets.js';
import { actionPolicyOf } from '../../host/governanceService.js';
import { getAgentProfile } from '../../host/agentProfileService.js';
import { resolveConnectionReadiness } from '../../host/connectionReadiness.js';
import { resolveAgentPolicy } from '../../host/agentPolicyResolver.js';
import type { StartRunDeps } from '../../host/runStarter.js';
import {
  decidePendingAction,
  reopenPendingAction,
  enqueuePendingAction,
  getPendingAction,
  listPendingActions,
  setPendingActionApproval,
  type PendingAction,
  type PendingActionKind,
} from './assistantService.js';
import { executeApprovedAction } from './actionExecution.js';
import { ensureAssistantAgent } from './capability.js';
import { onRosterMemberDeleted } from '../../host/rosterLifecycle.js';
import { ASSISTANT_WRITE_SCOPE, hasAssistantWriteAuthority } from './writeAuthority.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.assistant.approval');

function summarize(action: PendingAction): string {
  const to = Array.isArray((action.payload as { to?: unknown }).to)
    ? ((action.payload as { to: unknown[] }).to as string[]).join(', ')
    : typeof (action.payload as { to?: unknown }).to === 'string'
      ? String((action.payload as { to: unknown }).to)
      : undefined;
  const draftHead = action.draft.length > 80 ? `${action.draft.slice(0, 77)}…` : action.draft;
  return `${action.kind}: "${draftHead}"${to ? ` → ${to}` : ''}`;
}

/** Enqueue a draft action onto the single approval loop. */
export async function enqueueActionWithApproval(
  tenantId: string,
  input: Parameters<typeof enqueuePendingAction>[1],
): Promise<PendingAction> {
  // ADR 0028 — a 'disabled' kind drafts nothing at all (the most restrictive
  // admin posture; 'draft-only' still enqueues, it just never executes — T6).
  if ((await actionPolicyOf(tenantId, input.kind)) === 'disabled') {
    throw Object.assign(
      new Error(`assistant action kind '${input.kind}' is disabled by workspace policy`),
      { code: 'forbidden', status: 403 },
    );
  }
  // Attribute the approval to the REAL assistant-capability agent, so it appears
  // in that roster member's "Waiting on me" lane as the agent itself, not a
  // phantom `rosterId:'assistant'`. The agent is resolved by the `assistant`
  // CAPABILITY (ADR 0023 corrected 2026-06-13), never by a hardcoded
  // `chief-of-staff` roleKey. Resolved BEFORE the enqueue so its agentProfile
  // policy can fail-closed before anything is drafted.
  const agent = await ensureAssistantAgent(tenantId);
  // ADR 0036 — agentProfile policy enforcement, composed with ADR 0033
  // readiness (most-restrictive wins). The acting agent is the assistant-
  // capability holder (profileId = its rosterId); the action class is the
  // action `kind` (e.g. `email.send`). A `deny` verdict (the kind is on the
  // agent's `permissions.never`) fails closed — nothing is drafted, enqueued,
  // or approvable. `hitl` / `auto`-off-allowlist verdicts resolve to `review`,
  // which is already this path's behavior (it ALWAYS proposes — execution waits
  // on a human approve in T6), so they need no extra branch here; the deny is
  // the load-bearing enforcement at this seam.
  const readiness = await resolveConnectionReadiness(tenantId, agent.rosterId);
  const profile = await getAgentProfile(tenantId, agent.rosterId);
  const policy = resolveAgentPolicy({ profile, actionClass: input.kind, readiness });
  if (policy.verdict === 'deny') {
    throw Object.assign(
      new Error(`assistant action kind '${input.kind}' is forbidden by the agent's policy (permissions.never)`),
      { code: 'forbidden', status: 403 },
    );
  }
  const action = await enqueuePendingAction(tenantId, input);
  const approval = await createAssistantActionApproval({
    tenantId,
    actionId: action.actionId,
    proposal: summarize(action),
    rosterId: agent.rosterId,
    persona: agent.persona,
  });
  await setPendingActionApproval(tenantId, action.actionId, approval.approvalId);
  // Notifications (ADR 0010) — the inbox/bell is how the principal learns
  // something waits on them. Best-effort, like every notification emit.
  try {
    await getNotificationEmitter().emit({
      tenantId,
      type: 'openwop-app.workflow.approval-needed',
      priority: action.derivedFromUntrusted || action.riskLevel === 'high' ? 'high' : 'normal',
      title: 'The assistant drafted an action for your approval',
      // notify.ts discipline: draft text may derive from untrusted connected
      // content (and free text can embed leaked credentials) — redact before
      // it is persisted + Web-Pushed.
      message: sanitizeFreeText(summarize(action)),
      // Deep-link to this specific pending approval on /inbox (ADR 0336 Rec
      // Phase 3): the emit carries the approvalId but not its own (not-yet-
      // issued) notificationId, so ?approval= is the resolvable key.
      actionUrl: `/inbox?approval=${encodeURIComponent(approval.approvalId)}`,
      metadata: stripSecretsFromPersisted({ actionId: action.actionId, approvalId: approval.approvalId, kind: action.kind }),
    });
  } catch (err) {
    // WF-COS-8 — best-effort, but NOT silent. THIS notification is how the
    // principal learns an action is waiting on them; losing it strands the draft
    // in the inbox with nobody told, which is invisible AND user-affecting.
    log.warn('assistant_approval_notification_failed', {
      tenantId,
      actionId: action.actionId,
      approvalId: approval.approvalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { ...action, approvalId: approval.approvalId };
}

/** Decide an assistant action THROUGH its approval act. Returns null when the
 *  approval/action is missing, `changed:false` when a concurrent decision won
 *  (the CAS in resolveApproval is the lock — exactly one winner). */
/**
 * ADR 0662 D2 — the bytes the approver saw.
 *
 * Hashes the CARD's payload projection plus the draft, via `auditChainService.canonicalize`
 * — the same function `host/definitionHash.ts` hashes with for ADR 0473's
 * `expectedDefinitionHash`. Deliberately NOT a second canonicaliser: four already exist in
 * this repo and their semantics (recursive key sort, arrays ordered, `undefined` ≡ absent)
 * are exactly what is wanted here.
 */
export function contentHashOf(a: PendingAction): string {
  const shown: Record<string, unknown> = {};
  const raw = a.payload as Record<string, unknown>;
  for (const { field } of cardFieldsFor(a.kind)) {
    if (raw[field] !== undefined) shown[field] = raw[field];
  }
  return createHash('sha256').update(canonicalize({ draft: a.draft, payload: shown }), 'utf8').digest('hex');
}

export async function decideActionViaApproval(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; expectedContentHash?: string } = {},
): Promise<AssistantActionDecision | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || !approval.actionId) return null;
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, action: null, changed: false };
  const action = await decidePendingAction(tenantId, approval.actionId, {
    status: outcome,
    ...(opts.decidedByUserId !== undefined ? { approvedByUserId: opts.decidedByUserId } : {}),
  });

  // §12 T6 — the winning APPROVE claim is the single dispatch site (the CAS
  // above is the exactly-once guarantee). Execution rides runStarter under
  // the approving human's identity; deps are bound at boot. Pre-T6 hosts
  // (no deps registered) keep the record-only posture.
  if (outcome === 'approved' && execDeps) {
    const row = await getPendingAction(tenantId, approval.actionId);
    // ADR 0662 D2 — the definitive integrity check sits HERE: after the CAS (so it cannot
    // race the lock, ADR 0473 F2/F3) and before execution. A mismatch means the action
    // changed between the render the human approved and now, so BOTH rows are restored —
    // reopening only the approval would leave the action marked `approved`, never executed
    // and never reporting failure, which is the lying state this whole decision targets.
    if (row && opts.expectedContentHash !== undefined) {
      const actual = contentHashOf(row);
      if (actual !== opts.expectedContentHash) {
        await reopenPendingAction(tenantId, approval.actionId);
        await reopenApproval(approvalId);
        throw new OpenwopError(
          'conflict',
          'This action changed since you reviewed it. Re-read it before approving.',
          409,
          { actionId: approval.actionId, contentHash: actual },
        );
      }
    }
    if (row) {
      const runId = await executeApprovedAction(execDeps, tenantId, row, opts.decidedByUserId);
      if (runId) await attachRunId(approvalId, runId);
      const after = await getPendingAction(tenantId, approval.actionId);
      return { approval: lock.approval, action: (after ?? action) as Record<string, unknown> | null, changed: true };
    }
  }
  return { approval: lock.approval, action: action as Record<string, unknown> | null, changed: true };
}

let execDeps: StartRunDeps | null = null;

/** Host-shaped projection of a PendingAction for the approvals inbox ActionCard
 *  — the card fields only, internal columns (tenantId, createdBy) projected out.
 *  This is the ONE place the action's card shape is defined; the inbox consumes
 *  it verbatim. */
/**
 * ADR 0662 D1 — the fields an approver MUST see, per kind.
 *
 * Typed `Record<PendingActionKind, …>`, deliberately: the first draft of this decision
 * quantified over `EXEC_WORKFLOW_BY_KIND`, which is TYPED to exclude `servicedesk.reply`
 * — the kind that appends an outbound customer-facing message to a ticket thread. The
 * drift check would have been green on the one kind it most needed to fail on. A new kind
 * is now a COMPILE error here, not a test failure later.
 *
 * `mode` matters because a leaf-field allowlist is impossible for two of the five kinds:
 * `calendar.invite` sends `payload.event` VERBATIM as the provider POST body and
 * `calendar.reschedule` sends `payload.patch` verbatim as the PATCH body
 * (`packs/feature.assistant.nodes/index.mjs:592,600`). For those the field list is one
 * field, and rendering "that field" IS rendering the whole payload. Pretending otherwise
 * would keep the privacy property in name only, so `passthrough` says so out loud and
 * routes the object through the redaction seam instead.
 */
type CardField = { field: string; mode: 'scalar' | 'passthrough' };
const CARD_FIELDS: Record<PendingActionKind, readonly CardField[]> = {
  'email.send': [{ field: 'to', mode: 'scalar' }, { field: 'subject', mode: 'scalar' }],
  'calendar.invite': [{ field: 'to', mode: 'scalar' }, { field: 'event', mode: 'passthrough' }],
  'calendar.reschedule': [{ field: 'eventId', mode: 'scalar' }, { field: 'patch', mode: 'passthrough' }],
  'servicedesk.reply': [{ field: 'ticketId', mode: 'scalar' }],
  nudge: [{ field: 'to', mode: 'scalar' }],
};

/** The fields the card renders for a kind — exported so the drift test and any second
 *  renderer read the SAME list rather than re-deriving one that can drift. */
export function cardFieldsFor(kind: PendingActionKind): readonly CardField[] {
  return CARD_FIELDS[kind] ?? [];
}

function projectActionCard(a: PendingAction): Record<string, unknown> {
  // ADR 0662 D1 — this allowlist used to be `{to}` for every kind, while
  // `executeApprovedAction` dispatched the WHOLE payload. Its intent was right (keep a
  // future kind from leaking secrets onto the approval row) and its effect was that a
  // human approved a calendar invite without ever seeing its time, attendees or
  // location. A privacy control became an accountability hole. The allowlist stays —
  // it is now per-kind and REQUIRED to cover what the executor consumes.
  const raw = a.payload as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const { field, mode } of cardFieldsFor(a.kind)) {
    const v = raw[field];
    if (v === undefined) continue;
    if (mode === 'scalar') {
      payload[field] = typeof v === 'string' ? sanitizeFreeText(v) : v;
    } else {
      // Passthrough: the provider gets these bytes verbatim, so the approver must too —
      // through the same redaction the persisted row already gets.
      payload[field] = stripSecretsFromPersisted(v) as unknown;
    }
  }
  return {
    actionId: a.actionId,
    kind: a.kind,
    draft: a.draft,
    status: a.status,
    // ADR 0662 D2 — the approver returns this with their decision, and a mismatch refuses.
    // It covers the PROJECTED card, so a deploy that changes `CARD_FIELDS` invalidates every
    // in-flight card: correct, because the approver's view genuinely changed.
    contentHash: contentHashOf(a),
    payload,
    ...(a.riskLevel !== undefined ? { riskLevel: a.riskLevel } : {}),
    ...(a.requiredScopes !== undefined ? { requiredScopes: a.requiredScopes } : {}),
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    ...(a.sourceRefs !== undefined ? { sourceRefs: a.sourceRefs } : {}),
    ...(a.recipientDiff !== undefined ? { recipientDiff: a.recipientDiff } : {}),
    ...(a.derivedFromUntrusted !== undefined ? { derivedFromUntrusted: a.derivedFromUntrusted } : {}),
    ...(a.editedAt !== undefined ? { editedAt: a.editedAt } : {}),
  };
}

/** Boot hook — lets the core approvals routes decide assistant actions
 *  without importing the feature (direction: feature → core only), binds the
 *  runStarter deps the T6 execution dispatch needs, and registers the projector
 *  the approvals LIST route uses to embed each action's card metadata. */
export function registerAssistantActionApproval(deps?: StartRunDeps): void {
  if (deps) execDeps = deps;
  // UX_UPGRADE-assistant R2 (AST2-B1) — the write gate must live on the KIND,
  // not on one route. `routes.ts` wraps its own approve/reject in
  // `workspace:write` with a comment naming the reason ("approve/reject which
  // can trigger real email sends… a viewer-role member could act"), but that
  // same approval is decidable from two OTHER surfaces that never learned it:
  // `POST /approvals/:id/claim` and `POST /reviews/:id/actions/approve`. The
  // generic lane delegates authorization to `assertApprovalEligibility`, which
  // is an opt-in registry and a NO-OP for kinds that register nothing — and
  // `assistant-action` registered nothing, so a viewer could approve an
  // outbound send on a workspace-scoped connection.
  //
  // Registering here covers all three paths at once, because they all funnel
  // through the same check. `hasAssistantWriteAuthority` is the SAME predicate
  // the route and the agent tools already use — one helper, three callers, per
  // the ADR 0458 route↔tool parity rule extended to route↔ROUTE.
  registerApprovalEligibility('assistant-action', async (tenantId, decidedBy, approval, opts) => {
    // The wildcard-operator / superadmin escape the ROUTES already grant
    // (`requireTenantScope` returns early on `principal.tenants:['*']`). It has
    // to be honoured here too, or this gate would REVOKE admin tooling's access
    // rather than close the viewer hole — the opposite defect, and one the
    // existing inbox-claim test caught immediately.
    // The two REQUEST-level exits `requireTenantScope` grants, threaded rather
    // than re-derived (an eligibility check never sees a Request):
    //  - the wildcard-operator principal — admin tooling / the conformance
    //    harness. NOT `isSuperadmin`, which is wider and would let a viewer in
    //    an `OPENWOP_SUPERADMIN_TENANTS`-listed workspace through this gate.
    //  - the caller acting in their OWN personal/anon workspace, which is what
    //    keeps the solo-user and demo-sandbox Approve buttons working.
    if (opts?.isOperator || opts?.isPersonalOwner) return;
    if (!decidedBy || !(await hasAssistantWriteAuthority(tenantId, decidedBy))) {
      throw new OpenwopError(
        'forbidden_scope',
        'Deciding an assistant action requires write access in this workspace — it can send a real message.',
        403,
        { requiredScope: ASSISTANT_WRITE_SCOPE, actionId: approval.actionId },
      );
    }
  });
  // UX_UPGRADE-assistant R2 (AST2-M2) — deleting the assistant agent used to
  // STRAND every action waiting on it. `deleteRosterMemberCascade` hard-deletes
  // that roster's approvals (pending AND resolved), but the assistant's own
  // `PendingAction` rows survive with `status:'pending'` and a now-dangling
  // `approvalId`. Every decide path then 404s (`decideActionViaApproval`
  // returns null on a missing approval), there is no delete route for a pending
  // action, and no reopen — so the ghosts are undecidable FOREVER while still
  // counting in the briefing ("N awaiting your approval") and in health.
  //
  // Every other approval-owning feature already listens on this seam
  // (kicktodo-core, advisory-board, chat-widget, scheduled-agent-chats); the
  // assistant was the one that did not. Rejecting rather than deleting keeps
  // the audit trail: the action was drafted, and it was never sent.
  // Keyed on the INVARIANT, not on the deleted rosterId: by the time this runs
  // the member is already off the roster, so "was this the assistant?" is no
  // longer answerable — and it is the wrong question anyway. What makes an
  // action undecidable is that ITS OWN approval is gone. So: reject exactly the
  // pending actions whose approval no longer resolves, and leave every other
  // one alone. That is precise under a multi-agent tenant (deleting agent B
  // must not cancel work drafted by agent A) and self-correcting if the cascade
  // ever changes which approvals it removes.
  onRosterMemberDeleted('assistant-pending-actions', async ({ tenantId }) => {
    for (const action of await listPendingActions(tenantId, 'pending')) {
      // An action with NO `approvalId` is not the stranded-ghost case. Two
      // populations have none, and the first cut of this listener rejected both:
      //  - the DEMO SEED, which calls `enqueuePendingAction` directly, so
      //    deleting any unrelated roster member permanently emptied the demo
      //    "waiting on me" queue (the seeder's idempotence guard has no status
      //    filter, so the rows are never re-created);
      //  - a live enqueue caught mid-flight, between writing the action and
      //    back-linking its approval — silently rejecting a real user's draft.
      // Skipping them also closes that race. The case this exists for still
      // fires: a stranded action DOES carry an approvalId, pointing at a row
      // the roster cascade deleted.
      if (!action.approvalId) continue;
      if (await getApproval(action.approvalId)) continue;
      // `rejected`, not deleted — the audit trail is the point: this action
      // WAS drafted, and it was never sent.
      await decidePendingAction(tenantId, action.actionId, { status: 'rejected' });
    }
  });
  registerAssistantActionApprovalHandler(decideActionViaApproval);
  registerAssistantActionProjector(async (tenantId, actionId) => {
    const action = await getPendingAction(tenantId, actionId);
    return action ? projectActionCard(action) : null;
  });
}
