/**
 * ADR 0099 Phase 2 — per-agent LOSSY opt-in via agentProfile, frozen at run
 * creation (replay-safe), gated by the tenant toggle.
 *
 * Unique here: the agent is DERIVED from the run's attribution block at insert
 * (`runInsert.ts` `attribution?.rosterId`), `lossy:false` is not an opt-in, a
 * missing profile still stamps `lossless`, and the toggle beats an opted-in
 * profile. Sabotage that turns it red (wave 22): dropping the attribution
 * fallback reds the insert cases; `if (cfg.lossy !== undefined)` reds the
 * no-opt-in case; `if (!profile) return {}` reds the missing-profile case.
 *
 * Cut in wave 22 (redundant, cover confirmed red by the same sabotage):
 * "an opted-in agent freezes mode lossy with its head/tail" → residuals
 * "lossy agent carries minChars + exemptTools together"; "a run with no agent
 * stays lossless" → residuals "default carries NO minChars floor".
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetRunStartContributors, registerRunStartContributor } from '../src/host/runStartContext.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { extractRunAttribution } from '../src/host/agentRunActivityIndex.js';
import { readCompactionDecision } from '../src/executor/compaction.js';
import { resolveCompactionDecision } from '../src/features/tool-output-compaction/decision.js';
import { toolOutputCompactionFeature } from '../src/features/tool-output-compaction/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';

const TENANT = 'tenant-p2';
const ROSTER = 'roster-1';
const storage = openSqliteStorage(':memory:');

async function setToggle(status: 'on' | 'off'): Promise<void> {
  await saveConfig({ ...toolOutputCompactionFeature.toggleDefault!, status }, 'test');
}

async function setAgentLossy(opt: { lossy: boolean; head?: number; tail?: number }): Promise<void> {
  await upsertAgentProfile(TENANT, ROSTER, {
    roleKey: 'worker',
    configParameters: { compaction: opt },
    autonomy: { specLevel: 'draft-only' },
  });
}

/** An attributed run record (a heartbeat-style run carrying a rosterId block). */
function attributedRun(runId: string): Parameters<typeof insertRunWithStartContext>[1] {
  return {
    runId,
    workflowId: 'wf-1',
    tenantId: TENANT,
    status: 'pending',
    inputs: null,
    metadata: { heartbeat: { rosterId: ROSTER, agentId: 'agent-x' } },
    configurable: {},
    createdAt: '2026-06-20T00:00:00Z',
    updatedAt: '2026-06-20T00:00:00Z',
  };
}

beforeAll(() => initHostExtPersistence(storage));
afterAll(async () => storage.close());
beforeEach(async () => {
  initHostExtPersistence(storage);
  __resetRunStartContributors();
  await __clearToggleStore();
  registerToggleDefault(toolOutputCompactionFeature.toggleDefault!);
  await setToggle('on');
  registerRunStartContributor(resolveCompactionDecision);
});

describe('extractRunAttribution (shared convention reader)', () => {
  it('finds the rosterId/agentId from a heartbeat block', () => {
    expect(extractRunAttribution({ heartbeat: { rosterId: 'r', agentId: 'a' } })).toEqual({
      source: 'heartbeat',
      rosterId: 'r',
      agentId: 'a',
    });
  });
  it('returns undefined for a non-attributed run', () => {
    expect(extractRunAttribution({ source: 'api' })).toBeUndefined();
    expect(extractRunAttribution(null)).toBeUndefined();
  });
  it('returns undefined when the block lacks a rosterId', () => {
    expect(extractRunAttribution({ schedule: { note: 'x' } })).toBeUndefined();
  });
});

describe('per-agent lossy resolution', () => {
  it('an agent without the opt-in stays lossless', async () => {
    await setAgentLossy({ lossy: false });
    const patch = await resolveCompactionDecision({ tenantId: TENANT, agentId: ROSTER });
    expect(readCompactionDecision(patch)).toEqual({ mode: 'lossless' });
  });

  it('a missing profile fails open to lossless', async () => {
    const patch = await resolveCompactionDecision({ tenantId: TENANT, agentId: 'no-such-roster' });
    expect(readCompactionDecision(patch)).toEqual({ mode: 'lossless' });
  });

  it('toggle OFF stamps nothing even for an opted-in agent', async () => {
    await setAgentLossy({ lossy: true });
    await setToggle('off');
    const patch = await resolveCompactionDecision({ tenantId: TENANT, agentId: ROSTER });
    expect(patch).toEqual({});
  });
});

describe('insertRunWithStartContext derives the agent from attribution', () => {
  it('an attributed run of an opted-in agent freezes lossy', async () => {
    await setAgentLossy({ lossy: true, head: 3, tail: 2 });
    const run = attributedRun('run-p2-1');
    await insertRunWithStartContext(storage, run);
    const stored = await storage.getRun('run-p2-1');
    expect(readCompactionDecision(stored?.metadata)).toEqual({ mode: 'lossy', head: 3, tail: 2 });
  });

  it('replay-safe: editing the profile AFTER creation does not change the frozen decision', async () => {
    await setAgentLossy({ lossy: true, head: 3, tail: 2 });
    const run = attributedRun('run-p2-2');
    await insertRunWithStartContext(storage, run);

    // Agent later turns lossy OFF — the already-created run must be unaffected.
    await setAgentLossy({ lossy: false });
    // Non-vacuity: the edit LANDED — a run created now sees it and freezes lossless.
    await insertRunWithStartContext(storage, attributedRun('run-p2-3'));
    expect(readCompactionDecision((await storage.getRun('run-p2-3'))?.metadata)).toEqual({ mode: 'lossless' });
    // …while the earlier run keeps the decision it was born with. Honest ceiling:
    // nothing between insert and read re-resolves the profile, so this half is a
    // property of the stored row; the live replay invariant (a re-insert of a
    // COPIED blob) is witnessed on the real `:fork` route in
    // tool-output-compaction-fork-real-path.test.ts.
    const stored = await storage.getRun('run-p2-2');
    expect(readCompactionDecision(stored?.metadata)).toEqual({ mode: 'lossy', head: 3, tail: 2 });
  });
});
