/**
 * ADR 0125 — scheduled agent chats bound to the EXISTING scheduler (no parallel one).
 *
 * Guards (each claim's witnessing sabotage, /grade-tests w25 g2):
 *  - P1: create registers exactly ONE job in the creating tenant (job `tenantId` → 'x' reds);
 *    pause/resume flips the job AND the row (`setJobEnabled(…, true)` / `c.enabled = false` red);
 *    delete deregisters (dropping `deleteJob` reds).
 *  - Required fields + ADR 0202 OQ-4: every missing field and a malformed cron are refused by
 *    the service's OWN guard (`details.field`) — `registerJob`'s cadence check is a second
 *    guard that answers with a different message/details, so asserting those keeps the first
 *    guard failable; no config row survives a refused create.
 *  - P2b/2c spend boundary: absent workflowId ⇒ the built-in turn-workflow on the HOST-OWNED
 *    managed credential (a BYOK ref reds); the chain pack wires agentId/task/conversationId.
 *  - ADR 0701: a param-less turn fails with the agent-runner's TYPED validation_error
 *    (cited by `seeded-chain-unfilled-params.test.ts`; `if (!agentId)` → `if (false)` reds).
 *  - P3c: the list joins the job's nextFireAt exactly (a skewed time reds).
 *  - ADR 0202 OQ-3 / SCHED-4: agent cleanup removes ONLY that agent's channel schedules and
 *    counts ACTUAL deletions, so a broadcast double-delivery totals exactly the row count.
 *  - SCC-1 (erasure, PII): see the second describe.
 * The boot-order claim (chain packs load before the feature seeds) lives where the boot is:
 * `scheduled-followup-tool.test.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { getJob } from '../src/host/schedulingService.js';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import type { NodeContext } from '../src/executor/types.js';
import { createScheduledChat, setScheduledChatEnabled, deleteScheduledChat, getScheduledChat, listScheduledChats, listScheduledChatsWithStatus, deleteScheduledChatsForAgent, eraseScheduledChatsSubject } from '../src/features/scheduled-agent-chats/scheduledChatService.js';
import { seedScheduledChatTurnWorkflow, SCHEDULED_CHAT_TURN_WORKFLOW_ID, SCHEDULED_CHAT_CREDENTIAL_REF } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';

const T = 'sc-tenant';
// ADR 0202 D3 — the service now takes a scope descriptor; org scope for these tests.
const SCOPE = { orgId: 'org-sc' } as const;

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-schedchat-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('scheduled agent chats', () => {
  it('create registers exactly one ScheduledJob bound to the config', async () => {
    const chat = await createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'daily digest', conversationId: 'conv-1', cronExpr: '0 9 * * *' });
    expect(chat.chatId).toBeTruthy();
    expect(chat.enabled).toBe(true);
    const job = await getJob(`schedchat-${chat.chatId}`);
    expect(job).not.toBeNull();
    expect(job!.tenantId).toBe(T);
    expect(job!.cronExpr).toBe('0 9 * * *');
    expect(job!.configurable).toMatchObject({ agentId: 'iris', prompt: 'daily digest', conversationId: 'conv-1' });
  });

  it('validates required fields', async () => {
    const full = { agentId: 'iris', prompt: 'x', conversationId: 'c', cronExpr: '0 9 * * *' };
    for (const field of ['agentId', 'prompt', 'conversationId', 'cronExpr'] as const) {
      const input: Record<string, unknown> = { ...full };
      delete input[field];
      await expect(createScheduledChat(T, SCOPE, 'u1', input), field).rejects.toMatchObject({
        code: 'validation_error', details: { field }, message: expect.stringContaining('is required'),
      });
    }
  });

  it('ADR 0202 OQ-4 — rejects a malformed cron (no silent dead schedule); accepts a composed one', async () => {
    // The service's own guard answers (field + message); without it `registerJob` would still
    // refuse, but with `details.code: 'invalid_cron'` after a put+rollback — so these pin the guard.
    const refused = { code: 'validation_error', details: { field: 'cronExpr' }, message: expect.stringContaining('Invalid schedule') };
    await expect(createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c-bad', cronExpr: 'not a cron' })).rejects.toMatchObject(refused);
    await expect(createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c-bad', cronExpr: '99 9 * * *' })).rejects.toMatchObject(refused); // minute out of range
    expect((await listScheduledChats(T, SCOPE)).filter((c) => c.conversationId === 'c-bad'), 'a refused create leaves no config row').toEqual([]);
    // A picker-composed cron (weekdays at 14:30) is well-formed and binds a live job.
    const ok = await createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c', cronExpr: '30 14 * * 1-5' });
    expect((await getJob(`schedchat-${ok.chatId}`))!.nextFireAt).toBeGreaterThan(0);
  });

  it('pause disables the job; resume re-enables', async () => {
    const chat = await createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c2', cronExpr: '*/5 * * * *' });
    await setScheduledChatEnabled(T, SCOPE, chat.chatId, false);
    expect((await getJob(`schedchat-${chat.chatId}`))!.enabled).toBe(false);
    expect((await getScheduledChat(T, SCOPE, chat.chatId))!.enabled).toBe(false);
    await setScheduledChatEnabled(T, SCOPE, chat.chatId, true);
    expect((await getJob(`schedchat-${chat.chatId}`))!.enabled).toBe(true);
    expect((await getScheduledChat(T, SCOPE, chat.chatId))!.enabled).toBe(true);
  });

  it('ADR 0125 Phase 2b — an explicit workflowId is honored; absent ⇒ defaults to the built-in turn-workflow (fires)', async () => {
    const wired = await createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'cW', cronExpr: '0 0 * * *', workflowId: 'custom.turn' });
    const wiredJob = (await getJob(`schedchat-${wired.chatId}`))!;
    expect(wiredJob.workflowId).toBe('custom.turn');
    expect(wiredJob.enabled).toBe(true);

    // Phase 2b: no explicit workflowId now DEFAULTS to the built-in turn-workflow and
    // fires (superseding Phase 1's inert-until-wired stance), dispatching the agent on
    // the HOST-OWNED managed key with the prompt mapped to the agent-runner's `task`.
    const def = await createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'daily', conversationId: 'cI', cronExpr: '0 0 * * *' });
    expect(def.workflowId).toBe(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    const defJob = (await getJob(`schedchat-${def.chatId}`))!;
    expect(defJob.workflowId).toBe(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    expect(defJob.enabled).toBe(true);
    expect(defJob.configurable).toMatchObject({ agentId: 'iris', task: 'daily', credentialRef: SCHEDULED_CHAT_CREDENTIAL_REF });
  });

  it('Phase 2b — the turn-workflow wires agent-runner inputs from run variables', async () => {
    // ADR 0701 — the graph moved from an in-tree `registerWorkflow(DEF)` to a CHAIN
    // PACK registered chain-backed under the SAME workflowId. Every assertion below is
    // unchanged (they pin the Phase-2b/2c WIRING invariant, not the registration
    // mechanism); only the READ moves, because chain-backed defs live in
    // `chainBackedWorkflows`' own registry — `host/index.ts` catalog source A — not in
    // `workflowsRegistry`.
    const { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } =
      await import('../src/host/workflowChainPackLoader.js');
    const { getChainBackedWorkflow } = await import('../src/host/chainBackedWorkflows.js');
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    seedScheduledChatTurnWorkflow();
    const def = getChainBackedWorkflow(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    expect(def, 'chain-backed registration resolved by id').toBeTruthy();
    expect(def!.nodes).toHaveLength(1);
    const node = def!.nodes[0]!;
    expect(node.typeId).toBe('local.openwop-app.agent-runner');
    // The node MUST map agentId/task from run variables (else resolveParams gets no
    // agentId and the run fails). This guards the Phase-2b wiring defect.
    expect(node.inputs?.['agentId']).toEqual({ type: 'variable', variableName: 'agentId' });
    expect(node.inputs?.['task']).toEqual({ type: 'variable', variableName: 'task' });
    // Phase 2c — conversationId MUST be mapped + declared so the reply posts into the
    // bound conversation (the agent-runner's conversationId-gated append).
    expect(node.inputs?.['conversationId']).toEqual({ type: 'variable', variableName: 'conversationId' });
    expect((def!.variables ?? []).map((v) => v.name)).toEqual(expect.arrayContaining(['agentId', 'task', 'credentialRef', 'conversationId']));
  });

  it('ADR 0701 — the unfilled-params ceiling rests on a TYPED refusal, pinned here', async () => {
    // Raising `seeded-chain-unfilled-params`'s CEILING 116 -> 117 for this chain is
    // justified on the kb.reindex guarantee: a param-less gallery copy cannot misfire
    // because the agent-runner refuses with a typed error NAMING the missing input,
    // rather than failing mid-run inside an opaque node. Pin the refusal by RUNNING the
    // node (it used to be a regex over the source — a spelling, not the behaviour).
    const ctx: NodeContext = {
      runId: 'run-unfilled', nodeId: 'run', tenantId: T, attempt: 1,
      inputs: {}, configurable: { task: 'a task with no agent' }, secrets: {},
      emit: async () => ({ eventId: 'e', sequence: 0 }),
    };
    expect(await agentRunnerNode.execute(ctx)).toEqual({
      status: 'failure',
      error: { code: 'validation_error', message: 'agent-runner node requires an `agentId`.' },
    });
  });

  it('Phase 3c — listScheduledChatsWithStatus joins the job nextRunAt', async () => {
    const chat = await createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'cs', cronExpr: '0 9 * * *' });
    const job = (await getJob(`schedchat-${chat.chatId}`))!;
    expect(job.nextFireAt).toBeGreaterThan(0);
    // Scoped to THIS chat (the shared tenant holds other cases' rows): the create
    // registered a job with a computed nextFireAt → surfaced as exactly that ISO instant.
    const mine = (await listScheduledChatsWithStatus(T, SCOPE)).find((c) => c.chatId === chat.chatId);
    expect(mine?.nextRunAt).toBe(new Date(job.nextFireAt!).toISOString());
  });

  it('ADR 0202 OQ-3 — deleteScheduledChatsForAgent removes ONLY that agent’s channel schedules + jobs', async () => {
    const CH = { channelId: 'chan-oq3' } as const;
    const a1 = await createScheduledChat(T, CH, 'u1', { agentId: 'agentA', prompt: 'p', conversationId: 'chan-oq3', cronExpr: '0 9 * * *' });
    const a2 = await createScheduledChat(T, CH, 'u1', { agentId: 'agentA', prompt: 'p2', conversationId: 'chan-oq3', cronExpr: '0 10 * * *' });
    const b1 = await createScheduledChat(T, CH, 'u1', { agentId: 'agentB', prompt: 'p3', conversationId: 'chan-oq3', cronExpr: '0 11 * * *' });
    const removed = await deleteScheduledChatsForAgent(T, 'chan-oq3', 'agentA');
    expect(removed).toBe(2);
    expect(await getJob(`schedchat-${a1.chatId}`)).toBeNull();
    expect(await getJob(`schedchat-${a2.chatId}`)).toBeNull();
    expect(await getScheduledChat(T, CH, a1.chatId)).toBeNull();
    // agentB untouched.
    expect(await getJob(`schedchat-${b1.chatId}`)).not.toBeNull();
    expect(await getScheduledChat(T, CH, b1.chatId)).not.toBeNull();
  });

  it('ADR 0202 OQ-3 — concurrent cleanups (multi-instance broadcast) are idempotent: no throw, all removed', async () => {
    const CH = { channelId: 'chan-oq3c' } as const;
    const a1 = await createScheduledChat(T, CH, 'u1', { agentId: 'agentD', prompt: 'p', conversationId: 'chan-oq3c', cronExpr: '0 9 * * *' });
    const a2 = await createScheduledChat(T, CH, 'u1', { agentId: 'agentD', prompt: 'p2', conversationId: 'chan-oq3c', cronExpr: '0 10 * * *' });
    // Two handlers fire for the same removal (LISTEN/NOTIFY broadcasts to every
    // instance). Neither must throw on the already-deleted row, and both schedules
    // end up gone — the per-item not_found skip makes the loop idempotent.
    const [r1, r2] = await Promise.all([
      deleteScheduledChatsForAgent(T, 'chan-oq3c', 'agentD'),
      deleteScheduledChatsForAgent(T, 'chan-oq3c', 'agentD'),
    ]);
    // SCHED-4 — only the racer that ACTUALLY deleted a row counts it, so the two handlers
    // together report exactly the two rows (an unconditional `removed++` makes this 4).
    expect(r1 + r2).toBe(2);
    expect(await getScheduledChat(T, CH, a1.chatId)).toBeNull();
    expect(await getScheduledChat(T, CH, a2.chatId)).toBeNull();
    expect(await getJob(`schedchat-${a1.chatId}`)).toBeNull();
    expect(await getJob(`schedchat-${a2.chatId}`)).toBeNull();
  });

  it('delete deregisters the job', async () => {
    const chat = await createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c3', cronExpr: '0 0 * * *' });
    await deleteScheduledChat(T, SCOPE, chat.chatId);
    expect(await getJob(`schedchat-${chat.chatId}`)).toBeNull();
    expect(await getScheduledChat(T, SCOPE, chat.chatId)).toBeNull();
  });
});

/**
 * SCC-1 — subject erasure. A scheduled chat runs on its creator's behalf, so erasing
 * the creator must DISABLE the schedule (+ its firing job) and tombstone `createdBy`,
 * never leave it firing under an erased identity — and must touch ONLY that creator's
 * rows. Uses a dedicated tenant so the tenant-prefixed scan is isolated from the
 * shared-`T` rows above.
 */
describe('SCC-1 — eraseScheduledChatsSubject', () => {
  const TE = 'sc-erase-tenant';
  const S = { orgId: 'org-erase' } as const;

  it('disables the schedule + job and tombstones createdBy for the erased subject ONLY', async () => {
    const alice = await createScheduledChat(TE, S, 'user:alice', { agentId: 'iris', prompt: 'a', conversationId: 'ca', cronExpr: '0 9 * * *' });
    const bob = await createScheduledChat(TE, S, 'user:bob', { agentId: 'iris', prompt: 'b', conversationId: 'cb', cronExpr: '0 9 * * *' });
    // Both start enabled with a live job (positive baseline).
    expect((await getJob(`schedchat-${alice.chatId}`))!.enabled).toBe(true);
    expect((await getJob(`schedchat-${bob.chatId}`))!.enabled).toBe(true);

    const report = await eraseScheduledChatsSubject(TE, 'user:alice');
    expect(report.rowsTouched).toBe(1); // ONLY alice's row — not bob's, not other tenants'

    // Alice: schedule disabled, job disabled, actor tombstoned — but the row survives (paused, not deleted).
    const aliceRow = (await getScheduledChat(TE, S, alice.chatId))!;
    expect(aliceRow.enabled).toBe(false);
    expect(aliceRow.createdBy).toBe('erased:subject');
    expect(aliceRow.prompt).toBe('a'); // authored content preserved
    expect((await getJob(`schedchat-${alice.chatId}`))!.enabled).toBe(false);

    // Bob: completely untouched (the erase is per-actor, not per-tenant).
    const bobRow = (await getScheduledChat(TE, S, bob.chatId))!;
    expect(bobRow.enabled).toBe(true);
    expect(bobRow.createdBy).toBe('user:bob');
    expect((await getJob(`schedchat-${bob.chatId}`))!.enabled).toBe(true);
  });

  it('is idempotent — a second erase of the same subject touches nothing (the actor is already tombstoned)', async () => {
    await createScheduledChat(TE, S, 'user:carol', { agentId: 'iris', prompt: 'c', conversationId: 'cc', cronExpr: '0 9 * * *' });
    expect((await eraseScheduledChatsSubject(TE, 'user:carol')).rowsTouched).toBe(1);
    expect((await eraseScheduledChatsSubject(TE, 'user:carol')).rowsTouched).toBe(0);
  });

  it('a blank subject or tenant is a no-op', async () => {
    // A row whose actor is BLANK is what a blank-subject erase could wrongly match
    // (`subjectKeyForms('')` contains ''), so the guard has something to protect.
    const blank = await createScheduledChat(TE, S, '', { agentId: 'iris', prompt: 'z', conversationId: 'cz', cronExpr: '0 9 * * *' });
    expect((await eraseScheduledChatsSubject(TE, '')).rowsTouched).toBe(0);
    expect((await eraseScheduledChatsSubject('', 'user:alice')).rowsTouched).toBe(0);
    expect((await getScheduledChat(TE, S, blank.chatId))!.enabled).toBe(true);
    expect((await getJob(`schedchat-${blank.chatId}`))!.enabled).toBe(true);
  });

  // Production `createScheduledChat` stores the RAW `user.userId` in `createdBy`
  // (routes.ts), while a DSAR key may arrive `user:`-scoped. This pins that the raw
  // stored form is matched by the scoped erasure key (guards against a regression
  // narrowing the match to `createdBy === subjectKey`, which the alice cases above
  // — stored already-scoped — would NOT catch).
  it('erases a row stored with a BARE createdBy when the DSAR key is user:-scoped', async () => {
    const bare = await createScheduledChat(TE, S, 'u-bare-42', { agentId: 'iris', prompt: 'r', conversationId: 'cr', cronExpr: '0 9 * * *' });
    expect((await eraseScheduledChatsSubject(TE, 'user:u-bare-42')).rowsTouched).toBe(1);
    const row = (await getScheduledChat(TE, S, bare.chatId))!;
    expect(row.enabled).toBe(false);
    expect(row.createdBy).toBe('erased:subject');
    expect((await getJob(`schedchat-${bare.chatId}`))!.enabled).toBe(false);
  });
});
