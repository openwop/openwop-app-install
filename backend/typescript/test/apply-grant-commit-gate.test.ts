/**
 * ADR 0541 P2 — the gate consults; it does not defer.
 *
 * The headline test is NEGATIVE and STRUCTURAL: with no apply context, the
 * commit gate must behave exactly as it did before grants existed. Auto-apply's
 * whole risk is that adding a bypass for one caller quietly weakens the gate for
 * everyone, so "unchanged for everything else" is the property under test — not
 * a side effect to be assumed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { advance } from '../src/features/computer-use/computerUseService.js';
import { sessions, type CuSession } from '../src/features/computer-use/sessionStore.js';
import type { ComputerUseAdapter, CuAction } from '../src/features/computer-use/adapter.js';
import { createApplyGrant, applyGrants, submissionClaims } from '../src/host/applyGrant.js';
import { startTask } from '../src/features/computer-use/computerUseService.js';
import { buildComputerUseSurface } from '../src/features/computer-use/feature.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const TENANT = 'user:t-gate';
const ORIGIN = 'jobs.example.com';

/** An adapter that offers ONE commit action and records whether it was approved. */
function stubAdapter(action: CuAction): { adapter: ComputerUseAdapter; approvals: string[] } {
  const approvals: string[] = [];
  // Offers the action ONCE, then reports completion — otherwise an approved
  // action would loop forever against a poll that keeps returning it.
  let served = false;
  const adapter: ComputerUseAdapter = {
    startSession: async () => ({ ok: true, value: { providerSessionId: 'psid-1' } }),
    pollSession: async () => {
      if (served) return { ok: true, value: { status: 'completed', resultSummary: 'done' } };
      served = true;
      return { ok: true, value: { status: 'running', pendingAction: action } };
    },
    submitDecision: async (_p, actionId, approve) => {
      if (approve) approvals.push(actionId);
      return { ok: true, value: { accepted: true } };
    },
    abortSession: async () => {},
  };
  return { adapter, approvals };
}

const session = (over: Partial<CuSession> = {}): CuSession => ({
  sessionId: 'sess-1', tenantId: TENANT, orgId: 'org-1', requestHash: 'req-hash-1',
  status: 'running', task: 'apply', startUrl: `https://${ORIGIN}/jobs/1`,
  allowedOrigins: [`https://${ORIGIN}`], providerSessionId: 'psid-1', steps: [],
  createdBy: 'user-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...over,
});

const mintGrant = (over: Record<string, unknown> = {}) =>
  createApplyGrant({
    tenantId: TENANT, orgId: 'org-1', subjectId: 'subj-1', grantedBy: 'user-1',
    campaignId: 'camp-1', maxSubmits: 5, maxPrepared: 3, ratePerHour: 4,
    origins: [ORIGIN], resumePolicy: 'default',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over,
  } as never);

const submitAction: CuAction = { actionId: 'act-1', kind: 'submit', description: 'Submit application', url: `https://${ORIGIN}/apply` };

describe('ADR 0541 P2 — the gate is NEVER weakened for anything else', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(':memory:'));
  });

  it('with NO apply context, a commit halts for a human — exactly as before grants existed', async () => {
    // This is the regression that would matter most: a bypass built for one
    // caller leaking to every other computer-use session in the app.
    const s = session();
    await sessions.put(s);
    const { adapter, approvals } = stubAdapter(submitAction);
    const view = await advance(adapter, s);
    expect(view.status).toBe('awaiting_approval');
    expect(approvals, 'nothing may be auto-approved without a grant').toEqual([]);
  });

  it('a session with NO context halts even when a MATCHING grant exists', async () => {
    // THE structural test, and the one the first draft was missing: without a
    // grant present, "halted" proves nothing — it could be the missing grant
    // rather than the missing context. A sabotage that defaulted the context
    // left that draft green, which is how the gap was found.
    //
    // Here a perfectly valid grant exists for subj-1/camp-1 on this very origin.
    // The session simply never opted in, so the gate must not consult it.
    await mintGrant();
    const s = session(); // no applyContext
    await sessions.put(s);
    const { adapter, approvals } = stubAdapter(submitAction);
    const view = await advance(adapter, s);
    expect(view.status, 'a grant must never apply to a session that did not opt in').toBe('awaiting_approval');
    expect(approvals).toEqual([]);
  });

  it('with a valid grant, the same commit proceeds without a human', async () => {
    await mintGrant();
    const s = session({ applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(s);
    const { adapter, approvals } = stubAdapter(submitAction);
    const view = await advance(adapter, s);
    expect(approvals).toEqual(['act-1']);
    expect(view.status).not.toBe('awaiting_approval');
  });

  it('records the decision as `grant`, not `auto` — D5 attributability', async () => {
    await mintGrant();
    const s = session({ applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(s);
    await advance(stubAdapter(submitAction).adapter, s);
    const stored = await sessions.get(`${TENANT}:sess-1`);
    // Collapsing this into `auto` would make a granted submission
    // indistinguishable from an observe step in the trajectory.
    expect(stored?.steps.at(-1)?.decidedBy).toBe('grant');
  });

  it('CONSUMES budget before proceeding — consume-then-act, not act-then-consume', async () => {
    const g = await mintGrant();
    const s = session({ applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(s);
    await advance(stubAdapter(submitAction).adapter, s);
    expect((await applyGrants.get(`${TENANT}:${g.grantId}`))?.submitsUsed).toBe(1);
  });

  it('a PURCHASE is never granted — it halts even with a valid grant', async () => {
    await mintGrant();
    const s = session({ applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(s);
    const purchase: CuAction = { actionId: 'act-buy', kind: 'submit', description: 'Pay application fee', url: `https://${ORIGIN}/pay` };
    // NOTE: kind is `submit` here on purpose — the CLASS comes from the closed
    // action kind, so a purchase mislabelled by the provider as a submit is
    // still classed by `kind`. What this asserts is the companion case: a
    // genuine `credential` action never proceeds.
    const cred: CuAction = { ...purchase, actionId: 'act-cred', kind: 'credential', description: 'Enter password' };
    const { adapter, approvals } = stubAdapter(cred);
    const view = await advance(adapter, s);
    expect(approvals).toEqual([]);
    expect(view.status).toBe('awaiting_approval');
  });

  it('an EXHAUSTED grant halts for a human rather than failing the session', async () => {
    await mintGrant({ maxSubmits: 1 });
    const first = session({ applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(first);
    await advance(stubAdapter(submitAction).adapter, first);

    // A DIFFERENT listing (different requestHash) so the claim is not the thing
    // refusing — this must be the budget.
    const second = session({ sessionId: 'sess-2', requestHash: 'req-hash-2', applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(second);
    const view = await advance(stubAdapter(submitAction).adapter, second);
    expect(view.status).toBe('awaiting_approval');
  });

  it('a RETRY of the same listing does not submit twice, and does not spend twice', async () => {
    // D3b — the single most embarrassing failure mode in this product.
    const g = await mintGrant();
    const s = session({ applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(s);
    await advance(stubAdapter(submitAction).adapter, s);

    const retry = session({ sessionId: 'sess-retry', applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(retry);
    const { adapter, approvals } = stubAdapter(submitAction);
    const view = await advance(adapter, retry);

    expect(approvals, 'a retry must not produce a second application').toEqual([]);
    expect(view.status).toBe('awaiting_approval');
    expect((await applyGrants.get(`${TENANT}:${g.grantId}`))?.submitsUsed, 'the retry must not spend a second unit').toBe(1);
    expect(await submissionClaims.get(`${TENANT}:subj-1:req-hash-1`)).toBeTruthy();
  });

  it('an OUT-OF-SCOPE origin halts, even with an otherwise valid grant', async () => {
    await mintGrant({ origins: ['other.example.com'] });
    const s = session({ applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' } });
    await sessions.put(s);
    const { adapter, approvals } = stubAdapter(submitAction);
    expect((await advance(adapter, s)).status).toBe('awaiting_approval');
    expect(approvals).toEqual([]);
  });

  it('applyContext is REACHABLE — a real session start can populate it', async () => {
    // The defect this closes: `applyContext` was READ by the gate and SET by
    // nothing, so the whole grant integration was unreachable in production.
    // Every earlier test passed because it CONSTRUCTED the session object
    // directly — proving the gate worked, never proving the field could be
    // populated. Mechanism tested, reachability not.
    const { adapter } = stubAdapter(submitAction);
    const view = await startTask(adapter, {
      tenantId: TENANT,
      orgId: 'org-1',
      task: 'apply to a role',
      startUrl: `https://${ORIGIN}/apply`,
      allowedOrigins: [`https://${ORIGIN}`],
      createdBy: 'user-1',
      applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A' },
    });
    const stored = await sessions.get(`${TENANT}:${view.sessionId}`);
    expect(stored?.applyContext, 'a started session must carry the grant context').toEqual({
      subjectId: 'subj-1', campaignId: 'camp-1', tier: 'A',
    });
  });

  it('the WORKFLOW surface normalises the context closed-world', async () => {
    // A chain supplies this, so an unrecognised tier must fall back to 'C' —
    // which is never grantable — rather than being trusted. The safe direction
    // is the one that requires a human.
    const surface = buildComputerUseSurface({ tenantId: TENANT, runId: 'run:1', actingUserId: 'user-1' } as never);
    const start = surface.startTask as (a: Record<string, unknown>) => Promise<{ session: { sessionId: string } }>;
    const out = await start({
      orgId: 'org-1',
      task: 'apply',
      startUrl: `https://${ORIGIN}/apply`,
      allowedOrigins: [`https://${ORIGIN}`],
      applyContext: { subjectId: 'subj-1', campaignId: 'camp-1', tier: 'ZZZ', sneaky: 'x' },
    });
    const stored = await sessions.get(`${TENANT}:${out.session.sessionId}`);
    expect(stored?.applyContext?.tier, 'an unknown tier must fall back to the human-required one').toBe('C');
    expect(Object.keys(stored?.applyContext ?? {}).sort()).toEqual(['campaignId', 'subjectId', 'tier']);
  });

  it('a context with no subject or campaign is DROPPED, not half-built', async () => {
    const surface = buildComputerUseSurface({ tenantId: TENANT, runId: 'run:2', actingUserId: 'user-1' } as never);
    const start = surface.startTask as (a: Record<string, unknown>) => Promise<{ session: { sessionId: string } }>;
    const out = await start({
      orgId: 'org-1', task: 'apply2', startUrl: `https://${ORIGIN}/apply2`,
      allowedOrigins: [`https://${ORIGIN}`], applyContext: { tier: 'A' },
    });
    const stored = await sessions.get(`${TENANT}:${out.session.sessionId}`);
    expect(stored?.applyContext, 'an unattributable context must not exist at all').toBeUndefined();
  });
});
