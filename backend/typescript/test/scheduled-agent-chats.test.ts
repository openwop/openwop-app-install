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
import { createScheduledChat, setScheduledChatEnabled, deleteScheduledChat, getScheduledChat, listScheduledChatsWithStatus } from '../src/features/scheduled-agent-chats/scheduledChatService.js';
import { seedScheduledChatTurnWorkflow, SCHEDULED_CHAT_TURN_WORKFLOW_ID, SCHEDULED_CHAT_CREDENTIAL_REF } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';

const T = 'sc-tenant';
const ORG = 'org-sc';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-schedchat-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('scheduled agent chats', () => {
  it('create registers exactly one ScheduledJob bound to the config', async () => {
    const chat = await createScheduledChat(T, ORG, 'u1', { agentId: 'iris', prompt: 'daily digest', conversationId: 'conv-1', cronExpr: '0 9 * * *' });
    expect(chat.chatId).toBeTruthy();
    expect(chat.enabled).toBe(true);
    const job = await getJob(`schedchat-${chat.chatId}`);
    expect(job).not.toBeNull();
    expect(job!.tenantId).toBe(T);
    expect(job!.cronExpr).toBe('0 9 * * *');
    expect(job!.configurable).toMatchObject({ agentId: 'iris', prompt: 'daily digest', conversationId: 'conv-1' });
  });

  it('validates required fields', async () => {
    await expect(createScheduledChat(T, ORG, 'u1', { agentId: 'iris', prompt: 'x', conversationId: 'c' })).rejects.toMatchObject({ code: 'validation_error' }); // missing cronExpr
  });

  it('pause disables the job; resume re-enables', async () => {
    const chat = await createScheduledChat(T, ORG, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c2', cronExpr: '*/5 * * * *' });
    await setScheduledChatEnabled(T, ORG, chat.chatId, false);
    expect((await getJob(`schedchat-${chat.chatId}`))!.enabled).toBe(false);
    expect((await getScheduledChat(T, ORG, chat.chatId))!.enabled).toBe(false);
    await setScheduledChatEnabled(T, ORG, chat.chatId, true);
    expect((await getJob(`schedchat-${chat.chatId}`))!.enabled).toBe(true);
  });

  it('ADR 0125 Phase 2b — an explicit workflowId is honored; absent ⇒ defaults to the built-in turn-workflow (fires)', async () => {
    const wired = await createScheduledChat(T, ORG, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'cW', cronExpr: '0 0 * * *', workflowId: 'custom.turn' });
    const wiredJob = (await getJob(`schedchat-${wired.chatId}`))!;
    expect(wiredJob.workflowId).toBe('custom.turn');
    expect(wiredJob.enabled).toBe(true);

    // Phase 2b: no explicit workflowId now DEFAULTS to the built-in turn-workflow and
    // fires (superseding Phase 1's inert-until-wired stance), dispatching the agent on
    // the HOST-OWNED managed key with the prompt mapped to the agent-runner's `task`.
    const def = await createScheduledChat(T, ORG, 'u1', { agentId: 'iris', prompt: 'daily', conversationId: 'cI', cronExpr: '0 0 * * *' });
    expect(def.workflowId).toBe(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    const defJob = (await getJob(`schedchat-${def.chatId}`))!;
    expect(defJob.workflowId).toBe(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    expect(defJob.enabled).toBe(true);
    expect(defJob.configurable).toMatchObject({ agentId: 'iris', task: 'daily', credentialRef: SCHEDULED_CHAT_CREDENTIAL_REF });
  });

  it('Phase 2b — the built-in turn-workflow wires agent-runner inputs from run variables', () => {
    seedScheduledChatTurnWorkflow();
    const def = getRegisteredWorkflow(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    expect(def).toBeTruthy();
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

  it('Phase 3c — listScheduledChatsWithStatus joins the job nextRunAt', async () => {
    await createScheduledChat(T, ORG, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'cs', cronExpr: '0 9 * * *' });
    const withStatus = await listScheduledChatsWithStatus(T, ORG);
    expect(withStatus.length).toBeGreaterThanOrEqual(1);
    // The create registered a job with a computed nextFireAt → surfaced as an ISO string.
    expect(withStatus.every((c) => c.nextRunAt === undefined || typeof c.nextRunAt === 'string')).toBe(true);
    expect(withStatus.some((c) => typeof c.nextRunAt === 'string')).toBe(true);
  });

  it('delete deregisters the job', async () => {
    const chat = await createScheduledChat(T, ORG, 'u1', { agentId: 'iris', prompt: 'p', conversationId: 'c3', cronExpr: '0 0 * * *' });
    await deleteScheduledChat(T, ORG, chat.chatId);
    expect(await getJob(`schedchat-${chat.chatId}`)).toBeNull();
    expect(await getScheduledChat(T, ORG, chat.chatId)).toBeNull();
  });
});
