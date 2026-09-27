/**
 * COS-8 — an action allowed under a NON-`approval-required` policy is not a
 * human approval and must not be reported (or counted) as one.
 *
 * Before this fix, `executeApprovedAction` returned without touching `status`
 * when the per-kind policy was anything other than `approval-required`, so the
 * row sat at `approved` forever — a state `health.ts` counted as *accepted* and
 * the model's `list-pending-actions` reads as en-route. Under `draft-only` the
 * human decision is recorded but NOTHING egresses, so `approved` was a triple
 * lie: it implied a send that never happened, it inflated `approvalRate`, and it
 * put a non-human-gated action in the human-oversight denominator.
 *
 * The honest terminal status is `suppressed` — "allowed without a human approval
 * gate; policy blocked egress, no send happened." It is excluded from BOTH the
 * numerator (accepted) and denominator (decided) of the oversight metrics.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetAssistantStore,
  getPendingAction,
} from '../src/features/assistant/assistantService.js';
import { enqueueActionWithApproval, decideActionViaApproval } from '../src/features/assistant/actionApproval.js';
import { setGovernancePolicy, __resetGovernanceStore } from '../src/host/governanceService.js';
import { buildAssistantHealth } from '../src/features/assistant/health.js';

const TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18991, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

beforeEach(async () => {
  await __clearToggleStore();
  await __resetAssistantStore();
  await __resetGovernanceStore();
});

describe('COS-8 — honest status under a non-approval-required policy', () => {
  it('stamps `suppressed`, NOT `approved`, when the kind is draft-only', async () => {
    // `nudge` executes internally, so the ONLY thing keeping it from sending is
    // the policy skip — the cleanest isolation of the COS-8 lane.
    await setGovernancePolicy(TENANT, { actionPolicy: { nudge: 'draft-only' } });

    const a = await enqueueActionWithApproval(TENANT, { kind: 'nudge', payload: {}, draft: 'draft-only nudge' });
    await decideActionViaApproval(TENANT, a.approvalId!, 'approved', { decidedByUserId: 'u1' });

    const row = await getPendingAction(TENANT, a.actionId);
    // Was `approved` (the lie); must now be the honest terminal status.
    expect(row?.status).toBe('suppressed');
  });

  it('excludes suppressed actions from approvalRate — a policy-suppressed action is neither a human accept nor a human decision', async () => {
    // draft-only nudge → suppressed (a human clicked, but the gate was a no-op).
    await setGovernancePolicy(TENANT, { actionPolicy: { nudge: 'draft-only' } });
    const suppressed = await enqueueActionWithApproval(TENANT, { kind: 'nudge', payload: {}, draft: 'suppressed' });
    await decideActionViaApproval(TENANT, suppressed.approvalId!, 'approved', { decidedByUserId: 'u1' });

    // A real human-gated approval (approval-required nudge sends internally → sent)
    // and a real human rejection — these ARE human decisions and DO count.
    await setGovernancePolicy(TENANT, { actionPolicy: { nudge: 'approval-required' } });
    const sent = await enqueueActionWithApproval(TENANT, { kind: 'nudge', payload: {}, draft: 'sent' });
    await decideActionViaApproval(TENANT, sent.approvalId!, 'approved', { decidedByUserId: 'u1' });
    const rejected = await enqueueActionWithApproval(TENANT, { kind: 'nudge', payload: {}, draft: 'rejected' });
    await decideActionViaApproval(TENANT, rejected.approvalId!, 'rejected', {});

    expect((await getPendingAction(TENANT, suppressed.actionId))?.status).toBe('suppressed');
    expect((await getPendingAction(TENANT, sent.actionId))?.status).toBe('sent');
    expect((await getPendingAction(TENANT, rejected.actionId))?.status).toBe('rejected');

    const health = await buildAssistantHealth(TENANT);
    // The new honest count is surfaced.
    expect(health.actions.suppressed).toBe(1);
    // decided = {sent, rejected} (suppressed excluded); accepted = {sent}.
    // → 1/2 = 0.5. Before the fix the suppressed row read `approved`, so it was
    // BOTH accepted and decided → 2/3 ≈ 0.67. The suppressed row must not move it.
    expect(health.actions.approvalRate).toBe(0.5);
  });

  it('reads approvalRate:null (zero human decisions) when every action was policy-suppressed', async () => {
    await setGovernancePolicy(TENANT, { actionPolicy: { nudge: 'draft-only' } });
    const a = await enqueueActionWithApproval(TENANT, { kind: 'nudge', payload: {}, draft: 'only suppressed' });
    await decideActionViaApproval(TENANT, a.approvalId!, 'approved', { decidedByUserId: 'u1' });

    const health = await buildAssistantHealth(TENANT);
    expect(health.actions.suppressed).toBe(1);
    // NOT 1.0 (which the `approved` conflation produced): there were zero human
    // oversight decisions, so the rate is undefined, not "100% accepted".
    expect(health.actions.approvalRate).toBeNull();
  });
});
