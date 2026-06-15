/**
 * ADR 0036 — agentProfile policy enforcement at the heartbeat pick seam
 * (`runHeartbeatOnce`). The pick's action class is the card's workflow id.
 *
 *   - permissions.never ⊇ workflowId → the card is SKIPPED (neither run nor
 *     proposed; fail-closed);
 *   - hitl ⊇ workflowId → a proposal is queued (never auto-run);
 *   - auto + withinPolicyActions allowlist → an allowlisted workflow runs; an
 *     off-list workflow is proposed;
 *   - composition with ADR 0033 readiness: an un-ready required connection
 *     forces a proposal even for an allowlisted auto workflow (most-restrictive).
 *
 * @see docs/adr/0036-agent-profile-policy-enforcement.md
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createRosterEntry, updateRosterEntry, getRosterEntry, __resetRosterStore, type RosterEntry } from '../src/host/rosterService.js';
import { createBoard, createCard, __resetKanbanStore } from '../src/host/kanbanService.js';
import { runHeartbeatOnce } from '../src/host/heartbeatService.js';
import { upsertAgentProfile, __resetAgentProfileStore } from '../src/host/agentProfileService.js';
import { createSecretConnection, __resetConnectionsStore } from '../src/features/connections/connectionsService.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let deps: StartRunDeps;

const TENANT = 't1';
const WF = 'wf-triage';

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // BYOK resolver — createSecretConnection encrypts the secret through it.
  configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'owp-adr0036-')) });
  await __resetRosterStore();
  await __resetKanbanStore();
  await __resetAgentProfileStore();
  await __resetConnectionsStore();
  deps = { storage, hostSuite };
});
afterEach(() => {
  __resetHostExtPersistence();
});

/** A member (default autonomy = `auto`) with a board carrying one To Do card
 *  whose pick triggers `WF`. Card priority overridable. */
async function makeAgentWithTask(over: { priority?: 'low' | 'normal' | 'high' } = {}): Promise<RosterEntry> {
  const entry = await createRosterEntry({
    tenantId: TENANT,
    persona: 'Ivy',
    agentRef: { agentId: 'host:it-service-desk' },
    workflows: [WF],
  });
  const board = await createBoard({ tenantId: TENANT, name: 'Ivy board', rosterId: entry.rosterId, triggerWorkflowId: WF });
  const todo = board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do')!;
  await createCard({ boardId: board.id, columnId: todo.id, title: 'New ticket', ...(over.priority ? { priority: over.priority } : {}) });
  return entry;
}

describe('runHeartbeatOnce — agentProfile policy enforcement (ADR 0036)', () => {
  it('SKIPS a card whose workflow is on permissions.never (neither runs nor proposes)', async () => {
    const entry = await makeAgentWithTask();
    await upsertAgentProfile(TENANT, entry.rosterId, {
      roleKey: 'it-service-desk',
      permissions: { read: [], write: [], never: [WF] },
      autonomy: { specLevel: 'autonomous-within-policy', withinPolicyActions: [WF] },
    });
    const res = await runHeartbeatOnce(deps, entry);
    expect(res.picked).toBe(false);
    expect(res.runId).toBeUndefined();
    expect(res.proposed).toBeUndefined();
  });

  it('PROPOSES (never auto-runs) a card whose workflow is on hitl', async () => {
    const entry = await makeAgentWithTask();
    await upsertAgentProfile(TENANT, entry.rosterId, {
      roleKey: 'it-service-desk',
      hitl: [WF],
      // auto + on the allowlist — hitl still forces a proposal.
      autonomy: { specLevel: 'autonomous-within-policy', withinPolicyActions: [WF] },
    });
    const res = await runHeartbeatOnce(deps, entry);
    expect(res.picked).toBe(true);
    expect(res.proposed).toBe(true);
    expect(res.approvalId).toBeTruthy();
    expect(res.runId).toBeUndefined();
  });

  it('auto + allowlist: RUNS an allowlisted workflow', async () => {
    const entry = await makeAgentWithTask();
    await upsertAgentProfile(TENANT, entry.rosterId, {
      roleKey: 'it-service-desk',
      autonomy: { specLevel: 'autonomous-within-policy', withinPolicyActions: [WF] },
    });
    const res = await runHeartbeatOnce(deps, entry);
    expect(res.picked).toBe(true);
    expect(res.proposed).toBeUndefined();
    expect(res.runId).toBeTruthy();
  });

  it('auto + allowlist: PROPOSES an off-list workflow (autonomous within policy is honest)', async () => {
    const entry = await makeAgentWithTask();
    await upsertAgentProfile(TENANT, entry.rosterId, {
      roleKey: 'it-service-desk',
      autonomy: { specLevel: 'autonomous-within-policy', withinPolicyActions: ['some.other.workflow'] },
    });
    const res = await runHeartbeatOnce(deps, entry);
    expect(res.picked).toBe(true);
    expect(res.proposed).toBe(true);
    expect(res.runId).toBeUndefined();
  });

  it('composition: an un-ready required connection forces a proposal even for an allowlisted auto workflow', async () => {
    const entry = await makeAgentWithTask();
    await upsertAgentProfile(TENANT, entry.rosterId, {
      roleKey: 'it-service-desk',
      requiredConnections: ['servicenow'],
      autonomy: { specLevel: 'autonomous-within-policy', withinPolicyActions: [WF] },
    });
    // No connection configured → fail-closed → propose.
    const held = await runHeartbeatOnce(deps, entry);
    expect(held.picked).toBe(true);
    expect(held.proposed).toBe(true);
    expect(held.runId).toBeUndefined();
  });

  it('composition: once the required connection is active, the allowlisted auto workflow RUNS', async () => {
    const entry = await makeAgentWithTask();
    await upsertAgentProfile(TENANT, entry.rosterId, {
      roleKey: 'it-service-desk',
      requiredConnections: ['servicenow'],
      autonomy: { specLevel: 'autonomous-within-policy', withinPolicyActions: [WF] },
    });
    await createSecretConnection({ tenantId: TENANT, provider: 'servicenow', kind: 'api_key', secret: 'sn-key', scope: 'workspace' });
    const res = await runHeartbeatOnce(deps, entry);
    expect(res.picked).toBe(true);
    expect(res.proposed).toBeUndefined();
    expect(res.runId).toBeTruthy();
  });

  it('guided: proposes HIGH-priority picks, runs routine ones', async () => {
    // guided agent, on-readiness, not forbidden/hitl. Re-fetch the entry AFTER
    // the level update — the heartbeat reads `autonomyOf(entry)` off the entry.
    const high = await makeAgentWithTask({ priority: 'high' });
    await updateRosterEntry(high.rosterId, { autonomyLevel: 'guided' });
    await upsertAgentProfile(TENANT, high.rosterId, {
      roleKey: 'it-service-desk',
      autonomy: { specLevel: 'execute-with-approval' },
    });
    const hi = await runHeartbeatOnce(deps, (await getRosterEntry(high.rosterId))!);
    expect(hi.proposed).toBe(true);

    const routine = await makeAgentWithTask({ priority: 'normal' });
    await updateRosterEntry(routine.rosterId, { autonomyLevel: 'guided' });
    await upsertAgentProfile(TENANT, routine.rosterId, {
      roleKey: 'it-service-desk',
      autonomy: { specLevel: 'execute-with-approval' },
    });
    const lo = await runHeartbeatOnce(deps, (await getRosterEntry(routine.rosterId))!);
    expect(lo.proposed).toBeUndefined();
    expect(lo.runId).toBeTruthy();
  });
});
