/**
 * WF-JS-2 (WORKFLOWS-ASSESSMENT § job-search) — career.apply runs TO THE GATE
 * through the REAL expanded chain.
 *
 * `apply-grant-commit-gate.test.ts` proves the gate's semantics at the service
 * layer by building session objects directly. What it cannot prove — and what
 * nearly stayed unprovable — is that a CHAIN-driven session ever carries the
 * apply context at all: the computer-use pack's `task` node dropped
 * `applyContext` on the floor (the same "read by the gate, set by nothing"
 * defect `StartTaskInput`'s docblock records, reintroduced one layer up), so
 * the chain's own description ("the commit gate consults your apply grant")
 * was false for every session the chain started. This suite pins the whole
 * lane: the RFC 0134 edge condition, the param plumbing, the context's
 * reachability, and the gate outcomes with and without a grant.
 */
import { beforeAll, beforeEach, describe, expect, it, afterAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { registerFeatureSurface, __clearFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  expandChain,
} from '../src/host/workflowChainPackLoader.js';
import { advance } from '../src/features/computer-use/computerUseService.js';
import { sessions, type CuSession } from '../src/features/computer-use/sessionStore.js';
import type { ComputerUseAdapter, CuAction } from '../src/features/computer-use/adapter.js';
import { createApplyGrant } from '../src/host/applyGrant.js';
import type { NodeModule, WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ADR 0734: registerFeatureSurface() mutates a module-level registry this file
// dirtied and never cleaned up. Hygiene — leave the registry as we found it.
// NOT a cross-file fix: vitest forks a fresh process per test file (measured),
// so this residue could never have reached another file. See the ADR's
// correction note before citing this as protection.
afterAll(() => { __clearFeatureSurfaces(); });

const jobSearchPackUrl = new URL('../../../packs/feature.job-search.nodes/index.mjs', import.meta.url).href;
const computerUsePackUrl = new URL('../../../packs/feature.computer-use.nodes/index.mjs', import.meta.url).href;

type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;

const T = 'user:t-apply-chain';
const ORIGIN = 'jobs.example.com';
const CTX = { subjectId: 'subj-apply', campaignId: 'camp-apply', tier: 'B' as const };

const storage = await openStorage('memory://');

beforeAll(async () => {
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-apply-gate-')) });
  for (const f of BACKEND_FEATURES) if (f.surface) registerFeatureSurface(f.surface.id, f.surface.build);

  const reg = getNodeRegistry();
  const js = ((await import(jobSearchPackUrl)) as { nodes: Record<string, NodeFn> }).nodes;
  const cu = ((await import(computerUsePackUrl)) as { nodes: Record<string, NodeFn> }).nodes;
  // The REAL pack fns, adapted the way the production tarball loader adapts them
  // (non-success → failure) — the chain-backed-flagship-e2e harness pattern.
  for (const [typeId, fn] of [
    ['feature.job-search.nodes.guard-rewrite', js['feature.job-search.nodes.guard-rewrite']!],
    ['feature.computer-use.nodes.task', cu['feature.computer-use.nodes.task']!],
  ] as const) {
    reg.register({
      typeId,
      version: '1.0.0',
      async execute(ctx) {
        const r = await fn(ctx as unknown as Record<string, unknown>);
        if (r.status === 'success' || r.status === 'suspended') return r as never;
        const err = (r as { error?: { code?: string; message?: string } }).error;
        return { status: 'failure', error: { code: err?.code ?? 'pack_node_error', message: err?.message ?? 'non-success' } } as never;
      },
    } as NodeModule);
  }
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
});

beforeEach(async () => {
  // One shared memory storage for the whole file (the executor + packs bind at
  // beforeAll), so per-test isolation is a PREFIX WIPE of the rows these legs
  // assert on — a reset/re-init alone re-binds to the same backing rows.
  for (const row of await sessions.listByPrefix(`${T}:`)) await sessions.delete(`${T}:${row.sessionId}`);
  const { applyGrants } = await import('../src/host/applyGrant.js');
  for (const g of await applyGrants.listByPrefix(`${T}:`)) await applyGrants.delete(`${T}:${g.grantId}`);
});

/** Expand career.apply with LAUNCH params (the from-chain shape) and run it. */
async function runApplyChain(params: Record<string, unknown>): Promise<{ run: RunRecord; def: WorkflowDefinition; status: string }> {
  const entry = getChain('career.apply');
  expect(entry, 'career.apply must load through the real loader').toBeTruthy();
  const def = expandChain(entry!.chain, { params });
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-apply-${Math.random().toString(36).slice(2)}`,
    workflowId: def.workflowId, tenantId: T, status: 'pending',
    inputs: {}, metadata: { actingUserId: 'user:apply-e2e' }, configurable: {},
    createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const result = await executeRun(storage, run, def);
  return { run, def, status: result.status };
}

const PARAMS = {
  original: 'Led the payments team at Acme for four years.',
  reworded: 'Led the payments team at Acme for four years.', // identical ⇒ guard ok
  allowedEmployers: ['Acme'],
  orgId: 'org-apply',
  applyUrl: `https://${ORIGIN}/postings/1`,
  allowedOrigins: [`https://${ORIGIN}`],
  applyContext: CTX,
};

const submitAction: CuAction = { actionId: 'act-apply', kind: 'submit', description: 'Submit application', url: `https://${ORIGIN}/apply` };

/** The gate suite's one-commit-action stub, verbatim in shape. */
function stubAdapter(action: CuAction): { adapter: ComputerUseAdapter; approvals: string[] } {
  const approvals: string[] = [];
  let served = false;
  const adapter: ComputerUseAdapter = {
    startSession: async () => ({ ok: true, value: { providerSessionId: 'psid-apply' } }),
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

async function chainSession(): Promise<CuSession> {
  const rows = (await sessions.listByPrefix(`${T}:`));
  expect(rows.length, 'the chain must have started exactly one session').toBe(1);
  return rows[0]!;
}

/** Re-arm a chain-started session for the gate legs. The in-test MOCK provider
 *  runs a session to completion instantly (it simulates a whole trajectory), so
 *  to drive the COMMIT GATE we rewind the lifecycle fields and advance with the
 *  gate suite's stub adapter. Everything the gate actually consults — tenant,
 *  requestHash, allowedOrigins and the CHAIN-CARRIED applyContext — is kept
 *  verbatim from the chain's own session; only status/psid/steps are re-armed. */
async function reArm(s: CuSession): Promise<CuSession> {
  const armed: CuSession = { ...s, status: 'running', providerSessionId: 'psid-apply', steps: [] };
  await sessions.put(armed);
  return armed;
}

describe('WF-JS-2 — career.apply to the gate, through the expanded chain', () => {
  it('carries applyContext INTO the session — the reachability the chain promises', async () => {
    const { status } = await runApplyChain(PARAMS);
    expect(status).toBe('completed'); // the chain STARTS the session; the gate lives in its lifecycle
    const s = await chainSession();
    expect(s.applyContext, 'the task node must forward the context — it used to drop it').toEqual(CTX);
    expect(s.startUrl).toBe(PARAMS.applyUrl);
    expect(s.allowedOrigins).toEqual([`https://${ORIGIN}`]);
  });

  it('a FAILED guard verdict stops the session node — the RFC 0134 edge condition, live', async () => {
    const { status } = await runApplyChain({
      ...PARAMS,
      reworded: 'Led the payments team at Acme for nine years, managing $40M.', // fabricated tenure + number
    });
    // The guard node SUCCEEDS (its output is the verdict); the equals-condition
    // edge does not fire, so the session node — the chain's only terminal —
    // never runs, and the executor fails the run rather than completing with
    // nothing produced. Failing CLOSED is the designed outcome for a fabricated
    // rewrite: the substance pinned here is that the browser is never reached.
    expect(status).toBe('failed');
    expect((await sessions.listByPrefix(`${T}:`)).length, 'a failed guard must never reach the browser').toBe(0);
  });

  it('without a grant, the chain-started session HALTS for a human at the commit', async () => {
    await runApplyChain(PARAMS);
    const s = await reArm(await chainSession());
    const { adapter, approvals } = stubAdapter(submitAction);
    const view = await advance(adapter, s);
    expect(view.status).toBe('awaiting_approval');
    expect(approvals, 'nothing may be auto-approved without a grant').toEqual([]);
  });

  it('with a matching grant, the SAME chain-started session proceeds — attributed to the grant', async () => {
    await createApplyGrant({
      tenantId: T, orgId: 'org-apply', subjectId: CTX.subjectId, grantedBy: 'user:granter',
      campaignId: CTX.campaignId, maxSubmits: 5, maxPrepared: 3, ratePerHour: 4,
      tiers: ['A', 'B'], origins: [ORIGIN], resumePolicy: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await runApplyChain(PARAMS);
    const s = await reArm(await chainSession());
    const { adapter, approvals } = stubAdapter(submitAction);
    await advance(adapter, s);
    expect(approvals).toEqual(['act-apply']);
    const stored = await sessions.get(`${T}:${s.sessionId}`);
    expect(stored?.steps.at(-1)?.decidedBy, 'a granted submission must be attributed to the grant').toBe('grant');
  });
});
