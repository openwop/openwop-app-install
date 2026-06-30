/**
 * ADR 0125 Phase 4 — the scheduled-chat tick fires the turn-workflow ONCE, end-to-end
 * through the EXISTING scheduler daemon (no parallel scheduler). Generic fire-once /
 * claim-dedup / missed-window are covered by schedule-daemon.test.ts; this asserts the
 * scheduled-chat path specifically: a created chat dispatches its turn-workflow run on
 * the due tick, and does NOT re-fire the same slot.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { resetScheduling, getJob } from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { createScheduledChat } from '../src/features/scheduled-agent-chats/scheduledChatService.js';
import { seedScheduledChatTurnWorkflow, SCHEDULED_CHAT_TURN_WORKFLOW_ID } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let deps: StartRunDeps;

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-schedfire-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await resetScheduling();
  seedScheduledChatTurnWorkflow();
  deps = { storage, hostSuite };
});
afterEach(() => { __resetHostExtPersistence(); });

async function runsForJob(jobId: string) {
  return (await storage.listRuns({ limit: 100 })).filter((r) => {
    const b = (r.metadata as Record<string, unknown>)?.schedule as Record<string, unknown> | undefined;
    return b?.jobId === jobId;
  });
}

describe('scheduled-chat firing (ADR 0125 Phase 4)', () => {
  it('fires the turn-workflow ONCE on the due tick, then does not re-fire the same slot', async () => {
    const chat = await createScheduledChat('t1', 'o1', 'u1', { agentId: 'iris', prompt: 'digest', conversationId: 'c1', cronExpr: '0 * * * *' });
    const jobId = `schedchat-${chat.chatId}`;
    const due = (await getJob(jobId))!.nextFireAt!;
    expect(due).toBeGreaterThan(0);

    expect(await processDueSchedules(deps, due + 1000)).toBe(1);
    expect(await runsForJob(jobId)).toHaveLength(1);
    expect((await getJob(jobId))!.workflowId).toBe(SCHEDULED_CHAT_TURN_WORKFLOW_ID);

    // A second tick in the SAME slot: the job advanced nextFireAt past `due` on the
    // first fire, so it is no longer due ⇒ no second run (fire-once).
    expect(await processDueSchedules(deps, due + 2000)).toBe(0);
    expect(await runsForJob(jobId)).toHaveLength(1);
  });
});
