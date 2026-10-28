/**
 * RFC 0081 live-shadow eval for the Workforce demo (host-ext, deterministic seam).
 * A REAL eval — dispatches the supervisor agent over the embedded suite and
 * scores each task against the human baseline — vs the runs-derived `/shadow`
 * stand-in. Verifies the EvalSummary, the persisted eval run + `eval.*` events,
 * the content-free guarantee (no scenario prose in the events), and that the
 * deterministic suite lands at the designed 0.8.
 *
 * Sabotage that turns it red (wave 64 probes, all witnessed): the per-task
 * score (8fw5g2-wfe-pass-score), scenario prose in an event (-wfe-content-leak),
 * the eval run not completed (-wfe-run-completed), a non-derived runId
 * (-wfe-runid-determinism), the stamp dropped (-wfe-records-agent), and the
 * two ARWF-8 refusals (-wfe-no-suite, -wfe-supervisor-mismatch).
 *
 * Double guard (honest, by design): "records the supervisor it resolved" can
 * only fail on the stamp's presence. The mismatch refusal forces the resolved
 * supervisor to equal the suite's subject agent, so swapping `evalAgentId` for
 * that constant is a behavioural no-op on every path that reaches the stamp.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { EVAL_SUITE_ID, runWorkforceLiveShadowEval } from '../src/host/workforceEval.js';
import type { Storage } from '../src/storage/storage.js';
import type { AgentSpec } from '../src/host/workforce.js';

// The real seeded workforces, so the eval resolves its agent from the entity it
// is asked about (ADR 0775 P4 / ARWF-8), not from a constant.
type SeedWorkforce = { workforceId: string; agents: AgentSpec[] };
const WORKFORCES = JSON.parse(readFileSync('src/host/seed-data/workforces.json', 'utf8')) as SeedWorkforce[];
const byId = (id: string): SeedWorkforce => {
  const wf = WORKFORCES.find((w) => w.workforceId === id);
  if (!wf) throw new Error(`seed workforce ${id} missing`);
  return wf;
};
const HERO = byId('workforce.finance.invoice-exception');
const NOW = 1_750_000_000_000;

describe('workforce live-shadow eval (RFC 0081 §C, host-ext)', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = openSqliteStorage(':memory:');
    // ADR 0889 — eval events go through the event log (sequence, bus, closure), as in production.
    setEventLogBackend(storage);
  });

  it('dispatches the supervisor over the suite, scores it, and returns a spec-shaped EvalSummary', async () => {
    const s = await runWorkforceLiveShadowEval(storage, 'demo', HERO, NOW);
    expect(s.suiteId).toBe(EVAL_SUITE_ID);
    expect(s.suiteVersion).toBe('1.0.0');
    expect(s.workforceId).toBe(HERO.workforceId);
    expect(s.mode).toBe('live-shadow');
    expect(s.evaluatedModelClass).toBe('reasoning');
    expect(s.taskCount).toBe(5);
    // designed: 4/5 agree with baseline → 0.8, a credible pass (not a trivial 1.0).
    // Only `borderline-variance` (confidence 0.74 ≥ the 0.7 threshold, baseline
    // `escalated`) disagrees.
    expect(s.tasks).toEqual([
      { taskId: 'clean-po-match', score: 1, passed: true },
      { taskId: 'small-price-variance', score: 1, passed: true },
      { taskId: 'missing-receipt', score: 1, passed: true },
      { taskId: 'duplicate-suspect', score: 1, passed: true },
      { taskId: 'borderline-variance', score: 0, passed: false },
    ]);
    expect(s.passedCount).toBe(4);
    expect(s.aggregateScore).toBe(0.8);
    expect(s.passed).toBe(true);
  });

  it('persists a real eval run with eval.started / eval.scored×N / eval.completed events', async () => {
    const s = await runWorkforceLiveShadowEval(storage, 'demo', HERO, NOW);
    const events = await storage.listEvents(s.runId);
    const types = events.map((e) => e.type);
    expect(types).toContain('eval.started');
    expect(types.filter((t) => t === 'eval.scored')).toHaveLength(5);
    expect(types).toContain('eval.completed');

    const run = (await storage.listRuns({ tenantId: 'demo', limit: 100 })).find((r) => r.runId === s.runId);
    expect(run?.status).toBe('completed');
    expect(run?.metadata).toMatchObject({ mode: 'eval' });
  });

  it('is content-free (eval-summary-no-content-leak): no scenario prose in the events', async () => {
    const s = await runWorkforceLiveShadowEval(storage, 'demo', HERO, NOW);
    const events = await storage.listEvents(s.runId);
    const blob = JSON.stringify(events.map((e) => e.payload));
    // distinctive scenario phrases (never taskIds) must NOT appear
    expect(blob).not.toMatch(/tolerance|goods receipt|vendor master|already-posted|auto-clear band/i);
  });

  it('is deterministic — identical inputs reproduce the same scores', async () => {
    const a = await runWorkforceLiveShadowEval(storage, 'demo', HERO, NOW);
    // The second run gets its OWN storage AND its own event log (round 1 left the
    // event log on storage A, so b's events landed in a's store).
    const storageB = openSqliteStorage(':memory:');
    setEventLogBackend(storageB);
    const b = await runWorkforceLiveShadowEval(storageB, 'demo', HERO, NOW);
    expect(b.aggregateScore).toBe(a.aggregateScore);
    expect(b.tasks).toEqual(a.tasks);
    expect(b.runId).toBe(a.runId); // id derived from (tenant, workforce, nowMs)
    expect((await storageB.listEvents(b.runId)).map((e) => e.type)).toEqual((await storage.listEvents(a.runId)).map((e) => e.type));
  });

  // ADR 0775 P4 (ARWF-8) — before this, every workforce dispatched `host.priya`
  // over the invoice suite and reported that score under its own id.
  it('refuses a workforce that has no eval suite instead of scoring it on the invoice suite', async () => {
    const support = byId('workforce.support.escalation-triage');
    await expect(runWorkforceLiveShadowEval(storage, 'demo', support, NOW)).rejects.toMatchObject({
      httpStatus: 409,
      details: { reason: 'no_eval_suite', workforceId: support.workforceId },
    });
    expect(await storage.listRuns({ tenantId: 'demo', limit: 100 })).toEqual([]);
  });

  it('refuses when the workforce supervisor is not the agent the suite was written for', async () => {
    const swapped: SeedWorkforce = {
      ...HERO,
      agents: HERO.agents.map((a) => (a.role === 'supervisor' ? { ...a, agentRef: 'host.someone-else' } : a)),
    };
    await expect(runWorkforceLiveShadowEval(storage, 'demo', swapped, NOW)).rejects.toMatchObject({
      httpStatus: 409,
      details: { reason: 'supervisor_mismatch' },
    });
    expect(await storage.listRuns({ tenantId: 'demo', limit: 100 })).toEqual([]);
  });

  it('records the supervisor it resolved from the workforce on the eval run', async () => {
    const s = await runWorkforceLiveShadowEval(storage, 'demo', HERO, NOW);
    const run = await storage.getRun(s.runId);
    const supervisor = HERO.agents.find((a) => a.role === 'supervisor')!.agentRef;
    expect(run?.metadata).toMatchObject({ evalAgentId: supervisor, workforceId: HERO.workforceId });
  });
});
