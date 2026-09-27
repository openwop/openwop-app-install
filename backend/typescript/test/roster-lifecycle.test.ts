/**
 * ADR 0288 roster-lifecycle seam (grade-data AGT-1) — deleting a roster member
 * reaches the feature-owned refs the host cascade cannot: scheduled chats bound
 * to the agent PAUSE (job disabled, config survives), public widgets DISABLE
 * (credential stops serving, config survives), advisory boards PRUNE the member
 * from advisors[] and clear a matching moderator (board survives). Bystander
 * agents' configs untouched. Full app boot so the REAL registrations serve.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { deleteRosterMemberCascade } from '../src/host/rosterCascade.js';
import { createScheduledChat, listScheduledChats } from '../src/features/scheduled-agent-chats/scheduledChatService.js';
import { provisionWidget, getWidget } from '../src/features/chat-widget/widgetService.js';
import { createBoard, getBoard } from '../src/features/advisory-board/service.js';
import { createOrg } from '../src/host/accessControlService.js';
import type { Storage } from '../src/storage/storage.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

const T = 'roster-lc-t1';

let server: Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('roster deletion reaches feature-owned refs (ADR 0288)', () => {
  it('pauses scheduled chats, disables widgets, prunes advisory membership; bystanders intact', async () => {
    const org = await createOrg({ tenantId: T, createdBy: 'test', name: 'Lifecycle Org' });
    const doomed = await createRosterEntry({ tenantId: T, persona: 'Doomed Twin', agentRef: { agentId: `user.${T}.doomed` } });
    const keeper = await createRosterEntry({ tenantId: T, persona: 'Keeper Twin', agentRef: { agentId: `user.${T}.keeper` } });
    const scope = { orgId: org.orgId };

    const chatDoomed = await createScheduledChat(T, scope, 'test', { agentId: doomed.rosterId, prompt: 'daily digest', conversationId: 'conv-1', cronExpr: '0 9 * * *' });
    const chatKeeper = await createScheduledChat(T, scope, 'test', { agentId: keeper.rosterId, prompt: 'weekly digest', conversationId: 'conv-2', cronExpr: '0 9 * * 1' });
    const widgetDoomed = await provisionWidget(T, org.orgId, 'test', { agentId: doomed.agentRef.agentId, allowedDomains: ['example.com'] });
    const widgetKeeper = await provisionWidget(T, org.orgId, 'test', { agentId: keeper.agentRef.agentId, allowedDomains: ['example.com'] });
    const board = await createBoard(T, org.orgId, 'test', {
      name: 'GTM Board', advisors: [doomed.rosterId, keeper.rosterId], moderatorRosterId: doomed.rosterId,
      personaKind: 'fictional', livingPersonaAck: true,
    });

    await deleteRosterMemberCascade(T, __hostExtStorage() as Storage, doomed.rosterId);

    // Scheduled chats: doomed PAUSED (config survives), keeper untouched.
    const chats = await listScheduledChats(T, scope);
    expect(chats.find((c) => c.chatId === chatDoomed.chatId)?.enabled).toBe(false);
    expect(chats.find((c) => c.chatId === chatKeeper.chatId)?.enabled).toBe(true);

    // Widgets: doomed DISABLED (row survives), keeper untouched.
    expect((await getWidget(T, org.orgId, widgetDoomed.widgetId))?.enabled).toBe(false);
    expect((await getWidget(T, org.orgId, widgetKeeper.widgetId))?.enabled).toBe(true);

    // Advisory board: doomed pruned from advisors + moderator cleared; board survives.
    const boardAfter = await getBoard(T, 'test', board.boardId);
    expect(boardAfter.advisors).toEqual([keeper.rosterId]);
    expect(boardAfter.moderatorRosterId).toBeUndefined();
  });
});

/**
 * ADR 0664 D1 — deleting an agent must delete its VECTOR memory too.
 *
 * Born red: the cascade cleared the profile, the durable notes and the in-memory recall
 * scope, and left the vector rows. `rosterId` is `host:${slugify(persona)}`
 * (`rosterService.ts:145`) — deterministic — and the duplicate-persona 409 fires only while
 * the row exists, so re-creating an agent under the same name reuses the same namespace.
 * `subjectMemory`'s read returns `md.content` from the vector path IN PREFERENCE to recency
 * (`:139-157`), so the re-created agent's first recall served the DELETED agent's notes.
 *
 * The witness runs on the **memory port directly**, which is what the dispatch lane reads
 * (`agentDispatch.ts:633`). It deliberately does NOT go through `resolveAgentKnowledgeRetrieve`:
 * that requires the `knowledge` capability, and `deleteAgentProfile` removes the profile, so a
 * witness on that lane would pass whether or not this fix shipped — green for the wrong reason.
 */
describe('ADR 0664 D1 — a deleted agent leaves no recallable memory', () => {
  it('re-creating the same persona does not recall the deleted agent’s notes', async () => {
    const { createAgentMemoryPort, agentMemoryScope } = await import('../src/host/agentMemoryAdapter.js');
    const tenantId = `t-adr0664-${Date.now()}`;
    const persona = 'Vector Ghost';

    const first = await createRosterEntry({ tenantId, persona, agentRef: { agentId: 'agent:ghost' }, roleKey: 'kb-agent' });
    const port = createAgentMemoryPort(tenantId);
    const scope = agentMemoryScope(first.rosterId);
    await port.write(scope, { content: 'The merger codename is bluebird.' });

    // Non-vacuity FIRST: the note really is recallable before the delete, so an empty
    // result afterwards means "deleted", not "never written".
    const before = await port.read(scope, 'codename');
    expect(JSON.stringify(before), 'non-vacuity: the note is recallable before deletion').toContain('bluebird');

    await deleteRosterMemberCascade(tenantId, __hostExtStorage()!, first.rosterId);

    // The re-created agent gets the SAME rosterId, hence the same namespace — that is the
    // whole hazard, so assert it rather than assuming it.
    const second = await createRosterEntry({ tenantId, persona, agentRef: { agentId: 'agent:ghost' }, roleKey: 'kb-agent' });
    expect(second.rosterId, 'the persona-derived id is deterministic — this is why the leak was reachable').toBe(first.rosterId);

    const after = await createAgentMemoryPort(tenantId).read(agentMemoryScope(second.rosterId), 'codename');
    expect(JSON.stringify(after), 'the re-created agent must not recall the deleted one’s notes').not.toContain('bluebird');
  });
});
