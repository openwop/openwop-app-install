/**
 * ADR 0975 D1 — the run-scoped approval grant. The KickTodo operator (ADR 0910)
 * carries `host:kicktodo:manage` + `host:byok:manage` only, so on kicktodo.com
 * (2026-10-25) the one person allowed to run the Challenge Factory in
 * `host-kicktodo` could not answer its outline gate: `POST /runs/:id/interrupts/
 * outline-approve` → `403 forbidden_scope (approvals:respond)`.
 *
 * Pins, through the two checks the node route makes (the entry gate
 * `loadOwnedRunForDecision` and the approval floor `requireInterruptDecider`) and
 * the KickTodo predicate itself:
 *  - a caller WITHOUT `approvals:respond` decides a Factory gate on a run THEY
 *    started while they hold KickTodo manage authority;
 *  - not someone else's Factory run, not without manage authority, and never a
 *    run of any other workflow (the grant is keyed by workflow id);
 *  - a grant that throws refuses; the entry gate's tenant check is unchanged
 *    (a non-scope refusal is never converted into a grant).
 *
 * Red when (sabotage-witnessed): `requireInterruptDecider` stops consulting the
 * grant; `loadOwnedRunForDecision` rethrows on `forbidden_scope` without asking
 * it, or asks it for a non-scope error; the predicate drops the initiator check
 * or the manage check; `holdsRunApprovalGrant` passes on a throwing grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { OpenwopError, type InterruptRecord, type RunRecord } from '../src/types.js';

const authz = vi.hoisted(() => ({
  holdsFloor: vi.fn<(req: unknown, tenantId: string, scope: string) => Promise<boolean>>(),
  manage: vi.fn<(tenantId: string, subject?: string) => Promise<boolean>>(),
  loadOwnedRun: vi.fn<(req: unknown, storage: unknown, runId: string, scope: string) => Promise<RunRecord>>(),
}));
vi.mock('../src/features/featureRoute.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/featureRoute.js')>()),
  callerHoldsTenantScope: authz.holdsFloor,
  hasKicktodoManageAuthority: authz.manage,
}));
vi.mock('../src/host/runAccess.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/runAccess.js')>()),
  loadOwnedRun: authz.loadOwnedRun,
}));
vi.mock('../src/host/accessControlService.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/accessControlService.js')>()),
  // A shared workspace with members, so the memberless-key arm never admits.
  listTenantMembers: async () => [{ subject: 'user:someone', roles: ['viewer'] }],
}));

import { loadOwnedRunForDecision, requireInterruptDecider } from '../src/routes/interrupts.js';
import { holdsRunApprovalGrant, registerRunApprovalGrant, resetRunApprovalGrantsForTests } from '../src/host/runApprovalGrant.js';
import { factoryRunApprovalGrant } from '../src/features/kicktodo-creator/routes.js';
import { CHALLENGE_FACTORY_WORKFLOW_ID, LESSON_BATCH_WORKFLOW_ID } from '../src/features/kicktodo-creator/builtinWorkflows.js';
import type { Storage } from '../src/storage/storage.js';

const TENANT = 'host-kicktodo';
const OPERATOR = 'user:operator';
const OTHER = 'user:other-author';

const runOf = (workflowId: string, actingUserId: string): RunRecord => ({
  runId: `${TENANT}/run-1`, workflowId, tenantId: TENANT, status: 'waiting-approval', inputs: {},
  metadata: { actingUserId }, configurable: {},
} as unknown as RunRecord);
const req = (userId: string): Request => ({ userId, tenantId: TENANT, principal: { principalId: userId } } as unknown as Request);
const gate = (runId: string): InterruptRecord => ({
  interruptId: 'i-1', runId, nodeId: 'outline-approve', kind: 'approval', data: { actions: ['accept', 'reject'] },
} as unknown as InterruptRecord);
const storageWith = (run: RunRecord): Storage => ({ getRun: async () => run } as unknown as Storage);
const scopeRefusal = () => new OpenwopError('forbidden_scope', 'Missing required scope: approvals:respond', 403, { requiredScope: 'approvals:respond' });

beforeEach(() => {
  resetRunApprovalGrantsForTests();
  registerRunApprovalGrant([CHALLENGE_FACTORY_WORKFLOW_ID, LESSON_BATCH_WORKFLOW_ID], factoryRunApprovalGrant);
  authz.holdsFloor.mockResolvedValue(false); // no tenant-wide approvals:respond
  authz.manage.mockImplementation(async (_t, subject) => subject === OPERATOR);
});
afterEach(() => { vi.resetAllMocks(); });

describe('ADR 0975 D1 — requireInterruptDecider (the approval floor)', () => {
  it('admits the operator on the Factory run THEY started, without approvals:respond', async () => {
    const run = runOf(CHALLENGE_FACTORY_WORKFLOW_ID, OPERATOR);
    await expect(requireInterruptDecider(req(OPERATOR), storageWith(run), gate(run.runId))).resolves.toBeUndefined();
    expect(authz.manage).toHaveBeenCalledWith(TENANT, OPERATOR);
  });

  it('refuses the same caller on SOMEONE ELSE\'s Factory run', async () => {
    const run = runOf(CHALLENGE_FACTORY_WORKFLOW_ID, OTHER);
    await expect(requireInterruptDecider(req(OPERATOR), storageWith(run), gate(run.runId))).rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('refuses the run\'s own initiator once manage authority is gone (an expired activation)', async () => {
    authz.manage.mockResolvedValue(false);
    const run = runOf(CHALLENGE_FACTORY_WORKFLOW_ID, OPERATOR);
    await expect(requireInterruptDecider(req(OPERATOR), storageWith(run), gate(run.runId))).rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('never admits on a run of any other workflow, however the caller relates to it', async () => {
    const run = runOf('openwop-app.kicktodo.daily-loop', OPERATOR);
    await expect(requireInterruptDecider(req(OPERATOR), storageWith(run), gate(run.runId))).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(authz.manage).not.toHaveBeenCalled();
  });

  it('the lesson-batch child is covered by the same grant', async () => {
    const run = runOf(LESSON_BATCH_WORKFLOW_ID, OPERATOR);
    await expect(requireInterruptDecider(req(OPERATOR), storageWith(run), gate(run.runId))).resolves.toBeUndefined();
  });
});

describe('ADR 0975 D1 — loadOwnedRunForDecision (the node route\'s entry gate)', () => {
  it('a missing approvals:respond is answered by the grant, the run re-read at runs:read', async () => {
    const run = runOf(CHALLENGE_FACTORY_WORKFLOW_ID, OPERATOR);
    authz.loadOwnedRun.mockImplementation(async (_r, _s, _id, scope) => { if (scope === 'approvals:respond') throw scopeRefusal(); return run; });
    await expect(loadOwnedRunForDecision(req(OPERATOR), storageWith(run), run.runId)).resolves.toBeUndefined();
    expect(authz.loadOwnedRun.mock.calls.map((c) => c[3])).toEqual(['approvals:respond', 'runs:read']);
  });

  it('without the grant the ORIGINAL scope refusal is what the caller sees', async () => {
    const run = runOf(CHALLENGE_FACTORY_WORKFLOW_ID, OTHER);
    const refusal = scopeRefusal();
    authz.loadOwnedRun.mockImplementation(async (_r, _s, _id, scope) => { if (scope === 'approvals:respond') throw refusal; return run; });
    await expect(loadOwnedRunForDecision(req(OPERATOR), storageWith(run), run.runId)).rejects.toBe(refusal);
  });

  it('a non-scope refusal (a cross-tenant run id ⇒ run_not_found) is never converted into a grant', async () => {
    const run = runOf(CHALLENGE_FACTORY_WORKFLOW_ID, OPERATOR);
    authz.loadOwnedRun.mockRejectedValue(new OpenwopError('run_not_found', 'run x not found', 404));
    await expect(loadOwnedRunForDecision(req(OPERATOR), storageWith(run), run.runId)).rejects.toMatchObject({ code: 'run_not_found' });
    expect(authz.loadOwnedRun).toHaveBeenCalledTimes(1);
  });
});

describe('ADR 0975 D1 — the grant registry', () => {
  it('a grant that throws is a refusal, never a pass', async () => {
    resetRunApprovalGrantsForTests();
    registerRunApprovalGrant(['wf.throws'], async () => { throw new Error('boom'); });
    expect(await holdsRunApprovalGrant(req(OPERATOR), runOf('wf.throws', OPERATOR))).toBe(false);
  });

  it('one owner per workflow id: a second, different predicate is a boot error', () => {
    expect(() => registerRunApprovalGrant([CHALLENGE_FACTORY_WORKFLOW_ID], async () => true)).toThrow(/already registered/);
    // Re-registering the SAME predicate (a second route registration) is fine.
    expect(() => registerRunApprovalGrant([CHALLENGE_FACTORY_WORKFLOW_ID], factoryRunApprovalGrant)).not.toThrow();
  });
});
