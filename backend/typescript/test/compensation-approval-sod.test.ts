/**
 * ADR 0554 P2 / RFC 0151 §E — the compensation approval gate's separation of
 * duties.
 *
 * §G's external-audit scope names "authority escalation" and "manual override"
 * explicitly. The concrete failure this closes: the human whose run committed a
 * charge approving their own refund, with the approval card standing as the
 * only record that anyone reviewed it.
 *
 * The check is registered against `assertApprovalEligibility`, which is the ONE
 * choke every decide path funnels through — the generic `POST
 * /approvals/:id/claim`, the reviews-rail action, and decide-by-email alike.
 * Registering per-route would leave the other two open, which is exactly the
 * gap the assistant-action check was added to close (`features/assistant/
 * actionApproval.ts`).
 *
 * Tracker: TST-CGE-1. Red when (compensationRuntime.ts
 * `registerCompensationApprovalEligibility`): the requester-equals-decider check is
 * dropped (or honours `isPersonalOwner`); an unidentified decider is let through; the
 * wildcard-operator escape is removed; or the card's `compensationAction` grows a
 * field beyond the closed id/type-name set.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  APPROVAL_KINDS,
  assertApprovalEligibility,
  createCompensationApproval,
  getRegisteredApprovalRedactorKinds,
} from '../src/host/approvalService.js';
import { registerCompensationApprovalEligibility } from '../src/host/compensationRuntime.js';

const T = 'tenant-sod';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerCompensationApprovalEligibility();
});

async function gated(requestedBy?: string) {
  return createCompensationApproval({
    tenantId: T,
    runId: 'run-1',
    workflowId: 'wf.payments',
    compensationId: 'cmp_abc',
    nodeId: 'charge',
    compensationNodeTypeId: 'test.payment.refund',
    ...(requestedBy !== undefined ? { requestedBy } : {}),
    proposal: 'Undo the charge.',
  });
}

beforeEach(() => { registerCompensationApprovalEligibility(); });

describe('RFC 0151 §E — separation of duties on a compensation approval', () => {
  it('REFUSES the human whose run committed the effect', async () => {
    const approval = await gated('user:alice');
    await expect(
      assertApprovalEligibility(T, 'user:alice', approval),
    ).rejects.toMatchObject({ code: 'forbidden_scope', httpStatus: 403, message: expect.stringMatching(/separation of duties/i) });
  });

  it('allows a different human', async () => {
    const approval = await gated('user:alice');
    await expect(assertApprovalEligibility(T, 'user:bob', approval)).resolves.toBeUndefined();
  });

  it('REFUSES an unidentified approver — an inverse effect is a real effect', async () => {
    const approval = await gated('user:alice');
    await expect(
      assertApprovalEligibility(T, undefined, approval),
    ).rejects.toMatchObject({ code: 'forbidden_scope', httpStatus: 403, message: expect.stringMatching(/identified approver/i) });
  });

  it('honours the wildcard-OPERATOR escape the routes already grant', async () => {
    // Threaded, never re-derived — an eligibility check never sees a Request.
    // Without this the gate would REVOKE admin tooling's access rather than
    // close the self-approval hole, which is a different bug in the opposite
    // direction and one the assistant-action gate hit for real.
    const approval = await gated('user:alice');
    await expect(
      assertApprovalEligibility(T, 'user:alice', approval, { isOperator: true }),
    ).resolves.toBeUndefined();
  });

  it('does NOT honour isPersonalOwner, which would make the rule vacuous', async () => {
    // A personal workspace has exactly one human, so accepting that escape
    // would disable separation of duties precisely where it is the only
    // control left.
    const approval = await gated('user:alice');
    await expect(
      assertApprovalEligibility(T, 'user:alice', approval, { isPersonalOwner: true }),
    ).rejects.toMatchObject({ code: 'forbidden_scope', httpStatus: 403, message: expect.stringMatching(/separation of duties/i) });
  });
});

describe('APPR-5 — the new kind is fully wired', () => {
  it('compensation-action is a declared approval kind with a registered redactor', () => {
    expect(APPROVAL_KINDS).toContain('compensation-action');
    expect(getRegisteredApprovalRedactorKinds()).toContain('compensation-action');
  });

  it('the approval card is content-free — ids and type names only', async () => {
    const approval = await gated('user:alice');
    // §D/§G keep provider bodies and credentials off the durable compensation
    // path, and an approval row an operator reads is on that path. The card's
    // action block is a CLOSED set of ids and type names — asserted exactly, so a
    // field that could carry an effect payload cannot be added unnoticed. (A
    // marker grep over this fixture could not fail: its inputs carry no secret.)
    expect(approval.compensationAction).toEqual({
      runId: 'run-1',
      compensationId: 'cmp_abc',
      nodeId: 'charge',
      compensationNodeTypeId: 'test.payment.refund',
      requestedBy: 'user:alice',
    });
  });
});
