/**
 * ADR 0125 Phase 4 — the scheduled-chat tick fires the turn-workflow ONCE, end-to-end
 * through the EXISTING scheduler daemon (no parallel scheduler). Generic fire-once /
 * claim-dedup / missed-window are covered by schedule-daemon.test.ts; this asserts the
 * scheduled-chat path specifically: a created chat dispatches ONE run of its
 * turn-workflow, in the creating tenant, carrying the chat's agent/prompt/conversation
 * and the HOST-OWNED managed credential (never BYOK — an autonomous tick has no user),
 * gated by the feature toggle (ADR 0820 §8.2), and does NOT re-fire the same slot.
 *
 * Witnessing sabotages (/grade-tests w25 g2): inverting the daemon's toggle gate, or
 * stamping a foreign featureId on the job, fires nothing; dropping the daemon's
 * `configurable` spread loses the credential. The "same slot" leg is an honest TRIPLE
 * guard (claimOnce + the nextFireAt advance + claimDueSlot's slot fence) — removing any
 * one stays green; that generic property is schedule-daemon.test.ts's to witness.
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
import { createScheduledChat, listScheduledChatsWithStatus } from '../src/features/scheduled-agent-chats/scheduledChatService.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { scheduledAgentChatsFeature } from '../src/features/scheduled-agent-chats/feature.js';
import { seedScheduledChatTurnWorkflow, SCHEDULED_CHAT_TURN_WORKFLOW_ID, SCHEDULED_CHAT_CREDENTIAL_REF } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';

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
  // Chain packs are not loaded here (the stub catalog resolves any id), so this registers
  // no definition — what it does record is the workflow's owning feature (the funnel gate).
  seedScheduledChatTurnWorkflow();
  // ADR 0820 §8.2 — the job carries `featureId`, so the daemon resolves the toggle at
  // fire time; register its default (ON) the way boot does.
  registerToggleDefault(scheduledAgentChatsFeature.toggleDefault!);
  deps = { storage, hostSuite };
});
afterEach(() => { __resetHostExtPersistence(); });

async function runsForJob(jobId: string) {
  return (await storage.listRuns({ limit: 100 })).filter((r) => {
    const schedule: unknown = r.metadata['schedule'];
    return typeof schedule === 'object' && schedule !== null && 'jobId' in schedule && schedule.jobId === jobId;
  });
}

describe('scheduled-chat firing (ADR 0125 Phase 4)', () => {
  it('fires the turn-workflow ONCE on the due tick, then does not re-fire the same slot', async () => {
    const chat = await createScheduledChat('t1', { orgId: 'o1' }, 'u1', { agentId: 'iris', prompt: 'digest', conversationId: 'c1', cronExpr: '0 * * * *' });
    const jobId = `schedchat-${chat.chatId}`;
    const due = (await getJob(jobId))!.nextFireAt!;
    expect(due).toBeGreaterThan(0);

    expect(await processDueSchedules(deps, due + 1000)).toBe(1);
    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.workflowId).toBe(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    expect(run.tenantId).toBe('t1');
    expect(run.configurable).toMatchObject({ agentId: 'iris', task: 'digest', conversationId: 'c1', credentialRef: SCHEDULED_CHAT_CREDENTIAL_REF });
    expect(run.metadata).toMatchObject({ kind: 'scheduled-agent-chat', chatId: chat.chatId, schedule: { jobId, trigger: 'schedule' } });

    // A second tick in the SAME slot: the job advanced nextFireAt past `due` on the
    // first fire, so it is no longer due ⇒ no second run (fire-once).
    expect(await processDueSchedules(deps, due + 2000)).toBe(0);
    expect(await runsForJob(jobId)).toHaveLength(1);
  });

  // ADR 0879 D7 (team-lead decision) — a schedule never fails silently. When its
  // reply may not be posted (the agent-runner's `conversation_write_refused`, e.g. a
  // pre-0879 org schedule whose channel the creator can no longer post to), the run
  // fails TYPED and the owner's schedule list carries the reason.
  it('surfaces the last run\'s failure on the schedule (never a silent drop)', async () => {
    const chat = await createScheduledChat('t1', { orgId: 'o1' }, 'u1', { agentId: 'iris', prompt: 'digest', conversationId: 'c1', cronExpr: '0 * * * *' });
    const jobId = `schedchat-${chat.chatId}`;
    const due = (await getJob(jobId))!.nextFireAt!;
    expect(await processDueSchedules(deps, due + 1000)).toBe(1);
    expect((await listScheduledChatsWithStatus('t1', { orgId: 'o1' }))[0]!.lastError).toBeUndefined();
    const run = (await runsForJob(jobId))[0]!;
    await storage.updateRun(run.runId, { status: 'failed', error: { code: 'conversation_write_refused', message: 'The reply was not posted to this conversation (cannot_post).' } });
    const [listed] = await listScheduledChatsWithStatus('t1', { orgId: 'o1' });
    expect(listed!.lastError).toEqual({ code: 'conversation_write_refused', message: 'The reply was not posted to this conversation (cannot_post).' });
    // Another tenant's listing never sees it.
    expect(await listScheduledChatsWithStatus('t2', { orgId: 'o1' })).toEqual([]);
  });
});
