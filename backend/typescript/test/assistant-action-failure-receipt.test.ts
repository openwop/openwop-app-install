/**
 * AST-UX-1 — a FAILED outbound execution must reach the person who approved it.
 *
 * The defect: approving toasts "Approved — {{persona}} will carry it out", the
 * row leaves the inbox, and execution runs asynchronously. Every `failed`
 * branch of `executeApprovedAction` stamped the action row and logged, and told
 * the approver nothing — the only human-visible `failed` signal was the
 * superadmin-gated health tile on a different page.
 *
 * WHAT THIS FILE DOES *NOT* CLAIM. The generic run-failure notification
 * (`executor/executor.ts` → `emitRunFailureNotification`) already fired for the
 * two workflow-backed kinds, tenant-wide and titled "Workflow failed:
 * assistant.action.email-send". So the assertions below are written against the
 * ADDRESSED receipt specifically — `recipientUserId === the approver` — because
 * an assertion that merely counted `workflow.failed` rows would have passed
 * before the fix.
 *
 * Sabotages that turn it red (grade-tests w11): the receipt not addressed to the approver
 * (`recipientUserId` dropped); its message reduced to the bare reason (no kind/recipient);
 * the run link dropped; the terminal-projection receipt removed; a receipt emitted on a
 * SUCCESSFUL nudge. The REJECTED case is a negative control: no single-line sabotage
 * reaches it without first making the decide itself throw.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore, getPendingAction } from '../src/features/assistant/assistantService.js';
import { enqueueActionWithApproval, decideActionViaApproval, contentHashOf } from '../src/features/assistant/actionApproval.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import type { NotificationRecord } from '../src/types.js';
import { upsertOAuthConnection } from '../src/features/connections/connectionsService.js';

const TENANT = 'default';
const APPROVER = 'u-approver-receipt';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18991, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
  // A send-capable (fake-token) connection, so the run DISPATCHES and fails at the
  // provider: the receipt under test is the run-terminal one, which links the run.
  // The no-connection refusal happens before any run and is pinned in
  // assistant-send-credential-precheck.test.ts.
  await upsertOAuthConnection({ tenantId: TENANT, provider: 'google', userId: APPROVER, tokens: { accessToken: 'at-fake', refreshToken: 'rt-fake', scopes: ['https://www.googleapis.com/auth/gmail.send'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as never });
});

/** Condition polls on the real state: the terminal projection and the receipt are written
 *  by an in-process `onRunTerminal` listener with no awaitable hook (the honest ceiling).
 *  A timeout falls through to the caller's assertion, which prints what was observed. */
async function waitForStatus(actionId: string, statuses: string[], timeoutMs = 20_000): Promise<string> {
  await vi.waitFor(async () => {
    expect(statuses).toContain((await getPendingAction(TENANT, actionId))?.status);
  }, { timeout: timeoutMs, interval: 50 }).catch(() => undefined);
  return (await getPendingAction(TENANT, actionId))?.status ?? 'missing';
}

/** The receipt, and ONLY the receipt: addressed rows for this approver. The
 *  tenant-wide "Workflow failed" row the executor emits has no
 *  `recipientUserId`, so it cannot satisfy this filter — which is what makes
 *  the assertions non-vacuous against the pre-fix behaviour. */
async function addressedReceipts(actionId: string): Promise<NotificationRecord[]> {
  const rows = await __hostExtStorage()!.listNotifications({ tenantId: TENANT, limit: 200 });
  return rows.filter(
    (n) => n.recipientUserId === APPROVER && (n.metadata as { actionId?: string } | undefined)?.actionId === actionId,
  );
}

async function waitForReceipt(actionId: string, timeoutMs = 10_000): Promise<NotificationRecord[]> {
  await vi.waitFor(async () => {
    expect((await addressedReceipts(actionId)).length).toBeGreaterThan(0);
  }, { timeout: timeoutMs, interval: 50 }).catch(() => undefined);
  return addressedReceipts(actionId);
}

describe('AST-UX-1 — the approver is told when their approved action does not go out', () => {
  it('a failed email.send produces an addressed receipt that names the action and links the run', async () => {
    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: ['dana@example.com'] },
      draft: 'Hi Dana — the Q3 numbers.',
    });
    const decided = await decideActionViaApproval(TENANT, action.approvalId!, 'approved', { expectedContentHash: contentHashOf(action), decidedByUserId: APPROVER });
    expect(decided?.changed).toBe(true);

    // The fake token is refused at the provider and the
    // `confirm-action-send` verdict gate fails the run — the same lane
    // `assistant-action-execution.test.ts` already pins.
    expect(await waitForStatus(action.actionId, ['sent', 'failed'])).toBe('failed');

    const receipts = await waitForReceipt(action.actionId);
    expect(receipts.length, 'the approver must get exactly one addressed failure receipt').toBe(1);
    const r = receipts[0]!;
    expect(r.type).toBe('workflow.failed');
    expect(r.priority).toBe('high');
    // It names WHAT failed — the kind and the recipient the human approved —
    // not just "a workflow".
    expect(r.message).toContain('email.send');
    expect(r.message).toContain('dana@example.com');
    // …and it is inspectable: the run row is the evidence, and the
    // `workflow.failed` action label is literally "View run", so the link must
    // be a run URL or none at all.
    const row = await getPendingAction(TENANT, action.actionId);
    expect(r.actionUrl).toBe(`/runs/${row!.executionRunId}`);
    expect(r.runId).toBe(row!.executionRunId);
  }, 40_000);

  it('a SUCCESSFUL decision path emits no receipt (the receipt is not a decision echo)', async () => {
    // Non-vacuity in the other direction: a nudge executes internally and
    // lands `sent`, so nothing addressed may appear. Without this, an
    // implementation that notified on EVERY decision would pass the case above.
    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'nudge',
      payload: {},
      draft: 'You have not spoken with Alex in 3 weeks.',
    });
    await decideActionViaApproval(TENANT, action.approvalId!, 'approved', { expectedContentHash: contentHashOf(action), decidedByUserId: APPROVER });
    expect(await waitForStatus(action.actionId, ['sent', 'failed'])).toBe('sent');
    expect(await addressedReceipts(action.actionId)).toEqual([]);
  }, 20_000);

  it('a REJECTED action emits no receipt — rejecting is not a failure', async () => {
    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: ['dana@example.com'] },
      draft: 'Should never send.',
    });
    await decideActionViaApproval(TENANT, action.approvalId!, 'rejected', { decidedByUserId: APPROVER });
    expect((await getPendingAction(TENANT, action.actionId))?.status).toBe('rejected');
    expect(await addressedReceipts(action.actionId)).toEqual([]);
  }, 20_000);
});
