/**
 * ADR 0125 Phase 1 — scheduled-chat config bound to the EXISTING scheduler.
 * Create registers exactly one ScheduledJob; pause disables it; delete deregisters.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { getJob } from '../src/host/schedulingService.js';
import { createScheduledChat, setScheduledChatEnabled, deleteScheduledChat, getScheduledChat, listScheduledChatsWithStatus, deleteScheduledChatsForAgent, eraseScheduledChatsSubject } from '../src/features/scheduled-agent-chats/scheduledChatService.js';
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
    await expect(createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'x', conversationId: 'c' })).rejects.toMatchObject({ code: 'validation_error' }); // missing cronExpr
  });

  it('ADR 0202 OQ-4 — rejects a malformed cron (no silent dead schedule); accepts a composed one', async () => {
    await expect(createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c', cronExpr: 'not a cron' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c', cronExpr: '99 9 * * *' })).rejects.toMatchObject({ code: 'validation_error' }); // minute out of range
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
    // rather than failing mid-run inside an opaque node. That justification is only as
    // good as the refusal, so pin the refusal — otherwise the ceiling rests on prose.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'agentRunnerNode.ts'), 'utf8');
    expect(src, 'a MISSING agentId must be a typed validation_error, not a mid-run surprise')
      .toMatch(/code: 'validation_error'[^}]*agent-runner node requires an/);
  });

  it('ADR 0701 — seeding BEFORE the chain packs load fails SILENTLY, so boot order is pinned', async () => {
    // `registerChainBackedWorkflow` swallows a missing chain into a logged error
    // (chainBackedWorkflows.ts `catch` → `chain_backed_registration_failed`), so a boot
    // reorder would leave this feature registered-with-nothing and no test would care.
    // Production order is correct — `loadWorkflowChainPacks` (index.ts:529) precedes
    // `registerAllRoutes` (:780), which is what calls `seedScheduledChatTurnWorkflow`.
    // This leg pins that dependency so a reorder is a red test, not a dead schedule.
    // Self-contained: assert the PROPERTY on a chainId that was never loaded, rather
    // than trying to un-register the real one. (My first version reset the CHAIN
    // registry and expected the seed to no-op — but `_resetChainRegistryForTest`
    // resets the loader's registry, NOT `chainBackedWorkflows`' own one, so the
    // earlier test's registration survived and the idempotence guard short-circuited.
    // The premise was wrong, not the code.)
    const { registerChainBackedWorkflow, getChainBackedWorkflow } =
      await import('../src/host/chainBackedWorkflows.js');
    const ABSENT = 'openwop-app.scheduled-chat.turn.__never-loaded__';
    expect(() => registerChainBackedWorkflow(ABSENT), 'it does NOT throw — that is the hazard').not.toThrow();
    expect(
      getChainBackedWorkflow(ABSENT),
      'a missing chain registers NOTHING and only logs — hence the boot-order requirement',
    ).toBeFalsy();
  });

  it('Phase 3c — listScheduledChatsWithStatus joins the job nextRunAt', async () => {
    await createScheduledChat(T, SCOPE, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'cs', cronExpr: '0 9 * * *' });
    const withStatus = await listScheduledChatsWithStatus(T, SCOPE);
    expect(withStatus.length).toBeGreaterThanOrEqual(1);
    // The create registered a job with a computed nextFireAt → surfaced as an ISO string.
    expect(withStatus.every((c) => c.nextRunAt === undefined || typeof c.nextRunAt === 'string')).toBe(true);
    expect(withStatus.some((c) => typeof c.nextRunAt === 'string')).toBe(true);
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
    expect(r1 + r2).toBeGreaterThanOrEqual(2); // both covered (may double-count under a race; never throws)
    expect(await getScheduledChat(T, CH, a1.chatId)).toBeNull();
    expect(await getScheduledChat(T, CH, a2.chatId)).toBeNull();
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
    expect((await eraseScheduledChatsSubject(TE, '')).rowsTouched).toBe(0);
    expect((await eraseScheduledChatsSubject('', 'user:alice')).rowsTouched).toBe(0);
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
