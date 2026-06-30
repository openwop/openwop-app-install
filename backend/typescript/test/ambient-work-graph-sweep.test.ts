/**
 * ADR 0137 Phase 2 — the run-store sweep + suggestion upsert (status-preserving) +
 * processDueSweeps (always-on since the 2026-06-24 graduation; daemon stays env-gated).
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { sweepTenant, processDueSweeps } from '../src/features/ambient-work-graph/workGraphSweep.js';
import { listSuggestions, setSuggestionStatus } from '../src/features/ambient-work-graph/suggestionStore.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://'); initHostExtPersistence(storage);
});

function runRec(runId: string, tenantId: string): RunRecord {
  return {
    runId, workflowId: 'wf', tenantId, status: 'completed', inputs: {}, metadata: {}, configurable: {},
    createdAt: '2026-06-24T00:00:00Z', updatedAt: '2026-06-24T00:00:00Z',
  };
}
async function seedRun(runId: string, tenantId: string, tools: string[]): Promise<void> {
  await storage.insertRun(runRec(runId, tenantId));
  await storage.updateRun(runId, { status: 'completed' });
  for (const [i, name] of tools.entries()) {
    await storage.appendEvent({ eventId: `${runId}-e${i}`, runId, type: 'agent.toolCalled', payload: { toolName: name, agentId: 'researcher' }, timestamp: '2026-06-24T00:00:00Z' });
  }
}

describe('sweepTenant + upsert (ADR 0137 P2)', () => {
  it('detects a recurring pattern (≥3) and persists a suggestion', async () => {
    for (const i of [1, 2, 3]) await seedRun(`det${i}`, 'twg-det', ['kb.search', 'email.send']);
    await seedRun('det-rare', 'twg-det', ['kb.search']); // once → below threshold
    const n = await sweepTenant({ storage }, 'twg-det');
    expect(n).toBe(1);
    const sugs = await listSuggestions('twg-det');
    expect(sugs).toHaveLength(1);
    expect(sugs[0]).toMatchObject({ count: 3, toolSequence: ['kb.search', 'email.send'], status: 'suggested' });
  });

  it('re-sweep PRESERVES a dismissed status (no resurrection)', async () => {
    for (const i of [1, 2, 3]) await seedRun(`dis${i}`, 'twg-dis', ['kb.search', 'email.send']);
    await sweepTenant({ storage }, 'twg-dis');
    const sug = (await listSuggestions('twg-dis'))[0]!;
    await setSuggestionStatus(sug.suggestionId, 'dismissed');
    await sweepTenant({ storage }, 'twg-dis'); // re-detect
    const after = (await listSuggestions('twg-dis')).find((s) => s.suggestionId === sug.suggestionId)!;
    expect(after.status).toBe('dismissed'); // stayed dismissed
    expect(after.count).toBe(3); // evidence still refreshed
  });
});

describe('processDueSweeps (always-on; daemon env-gated)', () => {
  it('sweeps every listed tenant (no per-tenant toggle gate anymore)', async () => {
    for (const i of [1, 2, 3]) await seedRun(`pds${i}`, 'twg-on', ['kb.search', 'email.send']);
    await processDueSweeps({ storage }, async () => ['twg-on'], Date.parse('2026-06-24T10:00:00Z'));
    expect((await listSuggestions('twg-on')).length).toBeGreaterThanOrEqual(1);
  });
});
