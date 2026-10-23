/**
 * ADR 0473 grade-code C1 — the proposal-hygiene sweep runs on the DEFAULT
 * host posture. The original wiring nested it inside the run-retention gate
 * (`OPENWOP_RUN_RETENTION_DAYS > 0`), which is OPT-IN — so on a default host
 * ignored proposals never resolved and permanently pinned the transient cap.
 * This pins the fix at the DAEMON TICK level (the layer the unit test missed).
 *
 * DOUBLE GUARD, named: the expired draft is archived by the sweep itself AND, if
 * the sweep resolved the approval but did not archive, by the same tick's
 * crash-window reconcile pass (grade-data D3). So `archivedAt` alone cannot show
 * WHICH pass archived it — round 1 of /grade-tests 8f w1 probed "the sweep skips
 * its archive" vacuous. The case therefore asserts the tick's exact counters:
 * `swept: 1, reconciled: 0` means the sweep archived it and the reconcile had
 * nothing left to do.
 *
 * Time: `Date` (only) is faked and advanced to 1 s past the default 7-day TTL
 * (no real-clock wait, no sub-millisecond TTL env), so an expiry check that is
 * off by even a minute stays unexpired and reds the case.
 *
 * Sabotages it is red against (probed): the sweep nested back under the
 * retention gate, the expiry compared with a margin, the sweep's archive removed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
    delete process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS; // the default 7-day TTL
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now());
      const r = await runTool({ definition: { nodes: [{ nodeId: 'a', typeId: 'core.noop' }] } });
      const body = JSON.parse(r.content) as { approvalId: string; workflowId: string };
      expect((await getApproval(body.approvalId))?.status).toBe('pending');

      vi.setSystemTime(Date.now() + 7 * 86_400_000 + 1_000); // 1 s past expiry
      await daemon.tickNow();

      const approval = await getApproval(body.approvalId);
      expect(approval?.status).toBe('rejected');
      expect(approval?.note).toBe('expired');
      expect(lifecycleOf(getRegisteredWorkflow(body.workflowId)!).archivedAt).toBeTruthy();
      // The observability probe recorded the tick (grade-code C5) — and the SWEEP,
      // not the reconcile pass, archived the draft (the double guard, above).
      expect(lastProposalSweep()).toMatchObject({ swept: 1, scanned: 1, reconciled: 0 });
    } finally { vi.useRealTimers(); }
  });
});
