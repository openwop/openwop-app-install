/**
 * ADR 0862 (grade-code) — an assistant action's CARD is read only by who may send it.
 *
 * COS-11 put the assistant's own queue (`/assistant/pending-actions`) behind write
 * authority: "a viewer must not read a draft they cannot send". The approvals inbox and
 * the unified reviews list reached the SAME draft, recipients and event body through the
 * card projector, which never asked who was reading — and this branch's D3 widened the
 * reviews lane to the full payload. One gate, in the projector both lanes call.
 *
 * Sabotages that turn it red (grade-tests w11): the projector's withhold gate removed; its
 * operator or personal-owner exit removed; the list or get path letting quorum eligibility
 * override `canDecide:false`; each "unavailable" guard in `withAssistantActionView`
 * (no projector / no action / no actionId) returning the un-gated review.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore } from '../src/features/assistant/assistantService.js';
import { enqueueActionWithApproval } from '../src/features/assistant/actionApproval.js';
import { getApproval, getAssistantActionProjector } from '../src/host/approvalService.js';
import * as approvalService from '../src/host/approvalService.js';
import { getReview, listReviews, type ReviewAuthCtx } from '../src/host/reviewProjection.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import type { Storage } from '../src/storage/storage.js';

const TENANT = 'org:assistant-card-read';
let storage: Storage;
afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 18996, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await __clearToggleStore();
  await __resetAssistantStore();
  const org = await createOrg({ tenantId: TENANT, name: 'Acme', createdBy: 'u:owner' });
  await createMember({ tenantId: TENANT, orgId: org.orgId, subject: 'u:viewer', displayName: 'V', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: org.orgId, subject: 'u:editor', displayName: 'E', roles: ['editor'] });
});

async function drafted() {
  return enqueueActionWithApproval(TENANT, {
    kind: 'email.send',
    draft: 'Hi Dana — the confidential numbers.',
    payload: { to: ['dana@acme.test'], subject: 'Q3 confidential' },
  });
}

/** Both read paths must preserve the same decision gate. */
async function readBoth(approvalId: string, ctx: ReviewAuthCtx) {
  const id = `approval:${approvalId}`;
  const listed = (await listReviews(storage, ctx, { status: 'pending' })).find((r) => r.reviewId === id);
  const single = await getReview(storage, ctx, id);
  expect(listed).toBeTruthy();
  expect(single).toBeTruthy();
  return [listed!, single!];
}

describe('the card projector withholds the draft from a reader who cannot send it', () => {
  it('a viewer gets a withheld stub; an editor gets the card', async () => {
    const action = await drafted();
    const projector = getAssistantActionProjector()!;
    const forViewer = await projector(TENANT, action.actionId, { subject: 'u:viewer' });
    expect(forViewer).toMatchObject({ actionId: action.actionId, withheld: true });
    expect(JSON.stringify(forViewer)).not.toContain('confidential');
    const forEditor = await projector(TENANT, action.actionId, { subject: 'u:editor' });
    expect(forEditor?.draft).toBe('Hi Dana — the confidential numbers.');
    expect(typeof forEditor?.contentHash).toBe('string');
  });

  it('the two request-level exits read the card (operator, own personal workspace)', async () => {
    const action = await drafted();
    const projector = getAssistantActionProjector()!;
    expect((await projector(TENANT, action.actionId, { subject: 'u:nobody', isOperator: true }))?.withheld).toBeUndefined();
    expect((await projector(TENANT, action.actionId, { subject: 'session:x', isPersonalOwner: true }))?.withheld).toBeUndefined();
  });

  it('the reviews lane: a viewer sees the review, never its draft or fields', async () => {
    const action = await drafted();
    for (const asViewer of await readBoth(action.approvalId!, { tenantId: TENANT, subjectRef: 'u:viewer' })) {
      expect(asViewer.assistantAction).toBeUndefined();
      expect(asViewer.canDecide).toBe(false);
      expect((asViewer.assets ?? []).some((x) => x.label === 'Draft')).toBe(false);
    }
    // STATED RESIDUAL (COS2C-6): the approval's frozen `proposal` summary — the kind, a
    // 77-character draft head and the recipient — is still tenant-visible, on this lane and
    // on `/approvals`, because it is written onto the approval row at enqueue.
    const asEditor = await getReview(storage, { tenantId: TENANT, subjectRef: 'u:editor' }, `approval:${action.approvalId}`);
    expect(asEditor?.assistantAction?.payload).toMatchObject({ subject: 'Q3 confidential' });
  });

  it('eligible quorum membership never overrides a withheld card, on list or get', async () => {
    const action = await drafted();
    const approval = (await getApproval(action.approvalId!))!;
    // A historical/operator-authored quorum row: both readers are named approvers,
    // but only the editor has the action's write authority.
    await storage.kvSet(`hostext:approval:${approval.approvalId}`, JSON.stringify({
      ...approval, policy: { requiredApprovals: 2, approverRefs: ['u:viewer', 'u:editor'] },
    }));
    for (const subjectRef of ['u:viewer', 'u:editor']) {
      const reviews = await readBoth(approval.approvalId, {
        tenantId: TENANT, subjectRef, decider: { holdsRespond: true, reviewerRef: subjectRef },
      });
      for (const review of reviews) {
        expect(review.canDecide).toBe(subjectRef === 'u:editor');
        expect(!!review.assistantAction).toBe(subjectRef === 'u:editor');
      }
    }
  });

  for (const missing of ['projector', 'action', 'actionId'] as const) {
    it(`a pending review with no ${missing} is read-only on list and get`, async () => {
      const action = await drafted();
      if (missing === 'projector') vi.spyOn(approvalService, 'getAssistantActionProjector').mockReturnValue(null);
      if (missing === 'action') await __resetAssistantStore();
      if (missing === 'actionId') {
        const approval = (await getApproval(action.approvalId!))!;
        const { actionId: _removed, ...withoutActionId } = approval;
        await storage.kvSet(`hostext:approval:${approval.approvalId}`, JSON.stringify(withoutActionId));
      }
      for (const review of await readBoth(action.approvalId!, { tenantId: TENANT, subjectRef: 'u:editor' })) {
        expect(review.canDecide).toBe(false);
        expect(review.assistantAction).toBeUndefined();
        expect((review.assets ?? []).some((x) => x.label === 'Draft')).toBe(false);
      }
    });
  }
});
