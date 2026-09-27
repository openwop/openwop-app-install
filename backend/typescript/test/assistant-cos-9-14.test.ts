/**
 * Born-red witnesses for two Assistant Improvements
 * (docs/steward/CODEBASE-ASSESSMENT.md):
 *
 *   COS-9  — the SURFACE lane validates a node-supplied action `kind` against the
 *            ONE allowlist (`ENQUEUEABLE_ACTION_KINDS`) and rejects an unknown kind
 *            as a typed failure BEFORE storing a row (it used to be a bare cast
 *            `str(args.kind) as 'email.send'` that stored anything and only failed
 *            closed later as `action_execution_workflow_missing`).
 *   COS-14 — a `/reviews` projection of an `assistant-action` carries the ADR 0027
 *            safety signals (taint banner, risk chip, recipient diff) and a summary
 *            refreshed from the LIVE (possibly edited) draft — the branch that did
 *            not exist alongside the composed / anon-surface-write ones.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import { buildAssistantSurface } from '../src/features/assistant/surface.js';
import {
  __resetAssistantStore,
  enqueuePendingAction,
  editPendingAction,
  getPendingAction,
  setPendingActionApproval,
  listPendingActions,
} from '../src/features/assistant/assistantService.js';
import { createAssistantActionApproval, registerAssistantActionProjector } from '../src/host/approvalService.js';
import { getReview } from '../src/host/reviewProjection.js';

const TENANT = 't:cos-9-14';
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // The real projector reads the typed PendingAction (the shape the feature
  // registers at boot); registered here so `getReview` can enrich the row.
  registerAssistantActionProjector(async (t, id) => {
    const a = await getPendingAction(t, id);
    if (!a) return null;
    return {
      actionId: a.actionId,
      kind: a.kind,
      draft: a.draft,
      status: a.status,
      payload: { ...(a.payload as { to?: unknown }).to !== undefined ? { to: (a.payload as { to?: unknown }).to } : {} },
      ...(a.riskLevel !== undefined ? { riskLevel: a.riskLevel } : {}),
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      ...(a.recipientDiff !== undefined ? { recipientDiff: a.recipientDiff } : {}),
      ...(a.derivedFromUntrusted !== undefined ? { derivedFromUntrusted: a.derivedFromUntrusted } : {}),
      ...(a.editedAt !== undefined ? { editedAt: a.editedAt } : {}),
    };
  });
});
beforeEach(async () => { await __resetAssistantStore(); });

describe('COS-9 — the surface validates action `kind` at the ONE surface owner', () => {
  it('rejects an unknown kind as a typed validation_error and stores NO row', async () => {
    const surf = buildAssistantSurface({ tenantId: TENANT });
    await expect(
      surf.enqueueAction!({ kind: 'totally.bogus', draft: 'hello', payload: { to: 'a@b.com' } }),
    ).rejects.toMatchObject({ code: 'validation_error', httpStatus: 400 });
    // The defect was a stored row (cast to `email.send`) that failed CLOSED later.
    expect(await listPendingActions(TENANT)).toHaveLength(0);
  });

  it('a valid kind passes the kind guard (the negative control)', async () => {
    // Prove the guard rejects the KIND, not everything: a valid kind is not
    // rejected with `validation_error` for `kind`. (It reaches the enqueue path;
    // whatever happens next, it is not a kind-validation failure.)
    const surf = buildAssistantSurface({ tenantId: TENANT });
    const err = await surf
      .enqueueAction!({ kind: 'nudge', draft: 'ping', payload: {} })
      .then(() => null, (e: unknown) => e as { code?: string; details?: { field?: string } });
    if (err) {
      expect(err.details?.field).not.toBe('kind');
    }
  });
});

describe('COS-14 — /reviews surfaces the ADR 0027 safety signals for an assistant-action', () => {
  it('projects a taint banner, a risk chip, a recipient diff, and a live-draft summary', async () => {
    const action = await enqueuePendingAction(TENANT, {
      kind: 'email.send',
      draft: 'Original snapshot draft',
      payload: { to: ['a@x.test'] },
      riskLevel: 'high',
      derivedFromUntrusted: true,
      recipientDiff: { before: ['a@x.test'], after: ['dana@acme.test'] },
    });
    const approval = await createAssistantActionApproval({
      tenantId: TENANT,
      actionId: action.actionId,
      proposal: 'email.send: "Original snapshot draft"',
      rosterId: 'r:cos',
      persona: 'Chief of Staff',
    });
    await setPendingActionApproval(TENANT, action.actionId, approval.approvalId);
    // The approver edits the draft — the frozen enqueue summary must not remain.
    await editPendingAction(TENANT, action.actionId, { draft: 'Edited body facing the approver again' });

    const review = await getReview(storage, { tenantId: TENANT }, `approval:${approval.approvalId}`);
    expect(review).toBeTruthy();
    // Risk chip (from the per-kind riskLevel).
    expect(review!.risk?.level).toBe('high');
    // Taint banner (ADR 0027).
    expect(review!.risk?.reasons).toContain('Derived from untrusted connected content');
    // Recipient diff.
    expect(review!.risk?.reasons.some((r) => r.includes('Recipients changed') && r.includes('dana@acme.test'))).toBe(true);
    // Edited-since-proposed signal (the docblock's "faces the approver again").
    expect(review!.risk?.reasons).toContain('Draft edited since it was proposed');
    // Summary refreshed from the LIVE (edited) draft, not the frozen snapshot.
    expect(review!.summary).toContain('Edited body facing the approver again');
    // The current draft body surfaced as an inline asset (approve-what-you-see).
    expect(review!.assets?.some((a) => a.content === 'Edited body facing the approver again')).toBe(true);
  });
});
