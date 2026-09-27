/**
 * ADR 0473 grade-code C1 — the proposal-hygiene sweep runs on the DEFAULT
 * host posture. The original wiring nested it inside the run-retention gate
 * (`OPENWOP_RUN_RETENTION_DAYS > 0`), which is OPT-IN — so on a default host
 * ignored proposals never resolved and permanently pinned the transient cap.
 * This pins the fix at the DAEMON TICK level (the layer the unit test missed).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  registerWorkflowProposeTool,
  registerComposedWorkflowDecisionHandler,
  lastProposalSweep,
  PROPOSE_TOOL_ID,
} from '../src/host/workflowComposeTool.js';
import { startRetentionSweepDaemon } from '../src/host/retentionSweepDaemon.js';
import { getApproval } from '../src/host/approvalService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { lifecycleOf } from '../src/host/workflowLifecycle.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { ensureSuspendManagerInstalled } from '../src/bootstrap/suspend.js';
import { ensureEventLogInstalled } from '../src/bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from '../src/bootstrap/invocationLog.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TENANT = 'org:sweep-tick-test';
let storage: Storage;
let daemon: { stop(): void; tickNow(): Promise<void> };
let runTool: (input: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // The DEFAULT posture under test: run retention DISABLED.
  delete process.env.OPENWOP_RUN_RETENTION_DAYS;
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-sweeptick-')) });
  ensureNodesRegistered();
  ensureSuspendManagerInstalled(storage);
  ensureEventLogInstalled(storage);
  ensureInvocationLogInstalled(storage);
  const hostSuite = createHostAdapterSuite({ storage });
  registerWorkflowProposeTool({ workflowCatalog: hostSuite.workflowCatalog });
  registerComposedWorkflowDecisionHandler({ storage, hostSuite });
  daemon = startRetentionSweepDaemon({ storage });
  const provider = createAgentToolProvider({ tenantId: TENANT, agentProfileId: 'sweep-agent' });
  runTool = async (input) => provider.executeTool({ name: PROPOSE_TOOL_ID, input });
});
afterAll(() => daemon.stop());

describe('proposal sweep on the daemon tick (default posture — run retention OFF)', () => {
  it('an expired proposal resolves + archives on tickNow() with OPENWOP_RUN_RETENTION_DAYS unset', async () => {
    process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS = '0.000000001';
    let body: Record<string, unknown>;
    try {
      const r = await runTool({ definition: { nodes: [{ nodeId: 'a', typeId: 'core.noop' }] } });
      body = JSON.parse(r.content) as Record<string, unknown>;
    } finally {
      delete process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS;
    }
    await new Promise((res) => setTimeout(res, 10));

    await daemon.tickNow();

    const approval = await getApproval(body.approvalId as string);
    expect(approval?.status).toBe('rejected');
    expect(approval?.note).toBe('expired');
    expect(lifecycleOf(getRegisteredWorkflow(body.workflowId as string)!).archivedAt).toBeTruthy();
    // The observability probe recorded the tick (grade-code C5).
    expect(lastProposalSweep()?.swept).toBeGreaterThanOrEqual(1);
  });
});
