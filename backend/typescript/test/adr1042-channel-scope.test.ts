/**
 * ADR 1042 D9 — "Owner full, others narrow" (user decision, 2026-11-03).
 *
 * The owner's own linked account gets the agent's usual tools; everyone else (an
 * approved outside sender, any group, a relay contact) gets only the lane's
 * configured agent's explicit allowlist, read-only, and nothing by default.
 *
 * Covered:
 *  - the allowlist a turn compiles from: a narrow turn is offered a tool only if
 *    the agent allowlists it AND the reviewed `CHANNEL_SAFE_READ_TOOLS` lists it
 *    (EMPTY today), so a CRM read the agent allowlists is still refused; never a
 *    side-effect tool even when listed; a self/full turn keeps the agent's tools;
 *  - a narrow turn composes no agent memory or twin recall (`suppressRecall`);
 *  - the wiring, end to end on the real app: the exchange hands the tool loop a
 *    narrow scope for an outside DM, for a group (even from the owner's self
 *    sender), and for a relay contact; no scope for the owner's self sender and
 *    for a relay from-me message (the loop itself is stubbed at its seam);
 *  - only the approval's owner can mark a sender as self; never a group; at most
 *    one per owner per lane.
 *
 * Red when: the narrow list keeps a tool absent from the allowlist, or a write
 * tool; the full list loses the agent's tools; the exchange drops `toolScope`;
 * ingress marks a group or a relay contact self, or misses the owner's self
 * sender; a non-owner can mark self; a group can be self; two self rows coexist.
 * Sabotage-witnessed 2026-11-03, one at a time: removing the safe-list check
 * and removing the `effect === 'read'` condition (allowlist cases); dropping
 * `toolScope` from the exchange's loop call (both wiring cases); dropping the
 * `!msg.isGroup` guard on self (hosted case: a group row carrying `self`);
 * removing the owner check and the one-self-per-lane clearing (marking case);
 * dropping `suppressRecall` from the exchange (hosted case). Each turned red.
 * Delta review (N1): dropping the scope from the thread key (same-chat case),
 * reading `suppressRecall` from the per-turn scope only (in-app turn case),
 * returning no scope for a narrow run in `effectiveTurnScope` (unit case),
 * letting any from-me message be self (relay case), and not detecting WhatsApp
 * `@g.us` groups (detection case) each turned red.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const calls: Array<{ toolScope?: { mode: string; allowlist: readonly string[] } }> = [];
const composed: Array<boolean | undefined> = [];
vi.mock('../src/host/chatContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/chatContext.js')>();
  return {
    ...actual,
    composeChatContext: vi.fn(async (tenantId: string, input: Parameters<typeof actual.composeChatContext>[1]) => {
      composed.push(input.suppressRecall);
      return actual.composeChatContext(tenantId, input);
    }),
  };
});
vi.mock('../src/host/conversationToolLoop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/conversationToolLoop.js')>();
  return {
    ...actual,
    conversationToolTurnEligible: () => true,
    runConversationAgentToolTurn: vi.fn(async (p: { toolScope?: { mode: string; allowlist: readonly string[] } }) => {
      calls.push({ ...(p.toolScope ? { toolScope: p.toolScope } : {}) });
      return { text: 'stubbed reply', events: [] };
    }),
  };
});

const { bootChannelHarness, CONN, field, text } = await import('./support/channelCoreHarness.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { registerReplyTransport } = await import('../src/features/connections/messagingOutbound.js');
const { turnToolAllowlist, narrowChannelToolIds, CHANNEL_SAFE_READ_TOOLS, effectiveTurnScope } = await import('../src/host/conversationToolLoop.js');
const { isRelayGroup } = await import('../src/messaging/groupDetection.js');
const { builtinAgentTool } = await import('../src/host/agentToolProvider.js');
const { registerCrmAgentTools, CRM_LIST_COMPANIES_TOOL_ID } = await import('../src/features/crm/agentTools.js');
const { approveSender, putChannelSettings, setSenderSelf } = await import('../src/features/channel-ingress/stores.js');
const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
type Harness = Awaited<ReturnType<typeof bootChannelHarness>>;

const KANBAN_ADD_TODO = 'openwop:kanban.add-todo'; // a write builtin
const AGENT = 'test.c1042.channel-agent';
const AGENT_TOOLS = [CRM_LIST_COMPANIES_TOOL_ID, KANBAN_ADD_TODO];

describe('the allowlist a channel turn compiles from', () => {
  beforeAll(() => { registerCrmAgentTools(); });

  it('narrow with no configured allowlist offers nothing, not even a workspace read', () => {
    expect(turnToolAllowlist([CRM_LIST_COMPANIES_TOOL_ID], undefined, { mode: 'narrow', allowlist: [] })).toEqual([]);
  });

  it('the reviewed channel-safe list is the gate: a tool declaring effect "read" but not listed is refused', () => {
    expect(builtinAgentTool(CRM_LIST_COMPANIES_TOOL_ID)?.effect).toBe('read'); // non-vacuity
    expect(CHANNEL_SAFE_READ_TOOLS.has(CRM_LIST_COMPANIES_TOOL_ID)).toBe(false);
    expect(turnToolAllowlist(undefined, undefined, { mode: 'narrow', allowlist: [CRM_LIST_COMPANIES_TOOL_ID] })).toEqual([]);
  });

  it('a listed tool must ALSO be on the agent allowlist, and a listed side-effect tool is still dropped', () => {
    const safe = new Set([CRM_LIST_COMPANIES_TOOL_ID, KANBAN_ADD_TODO]);
    expect(narrowChannelToolIds([CRM_LIST_COMPANIES_TOOL_ID, KANBAN_ADD_TODO, 'mcp:unknown.tool'], safe)).toEqual([CRM_LIST_COMPANIES_TOOL_ID]);
    expect(narrowChannelToolIds([], safe)).toEqual([]);
  });

  it('a full (self) turn keeps the agent\'s tools, the workspace read included', () => {
    const full = turnToolAllowlist([CRM_LIST_COMPANIES_TOOL_ID], undefined, undefined);
    expect(full).toContain(CRM_LIST_COMPANIES_TOOL_ID);
    expect(full).toContain(KANBAN_ADD_TODO); // the ADR 0315 default-on baseline
  });
});

describe('review N1 — a narrow conversation is narrow for every turn', () => {
  it('a channel turn\'s narrow list comes from the SERVED agent (ADR 1014), not a registry read by the ingress', () => {
    // The ingress sends `{ mode: 'narrow' }`; the loop fills the list from the agent the
    // exchange served (its override, else its manifest) — a pinned or deployed version's
    // own list, whatever the head says.
    const served = ['openwop:served.v1.read'];
    expect(effectiveTurnScope({ metadata: {} }, { mode: 'narrow' }, undefined, served)).toEqual({ mode: 'narrow', allowlist: served });
    expect(effectiveTurnScope({ metadata: {} }, { mode: 'narrow' }, ['openwop:override.read'], served)).toEqual({ mode: 'narrow', allowlist: ['openwop:override.read'] });
  });

  it('a turn with no per-turn scope in a narrow channel run is narrow on the agent\'s own explicit list', () => {
    const narrowRun = { metadata: { channelIngress: { lane: 'conn:x', scope: 'narrow' } } };
    const selfRun = { metadata: { channelIngress: { lane: 'conn:x', scope: 'self' } } };
    expect(effectiveTurnScope(narrowRun, undefined, undefined, AGENT_TOOLS)).toEqual({ mode: 'narrow', allowlist: AGENT_TOOLS });
    expect(effectiveTurnScope(narrowRun, undefined, [CRM_LIST_COMPANIES_TOOL_ID], AGENT_TOOLS)).toEqual({ mode: 'narrow', allowlist: [CRM_LIST_COMPANIES_TOOL_ID] });
    expect(effectiveTurnScope(selfRun, undefined, undefined, AGENT_TOOLS)).toBeUndefined();
    expect(effectiveTurnScope({ metadata: {} }, undefined, undefined, AGENT_TOOLS)).toBeUndefined();
  });
});

describe('review N1 — explicit relay group detection', () => {
  it('names a group per channel', () => {
    expect(isRelayGroup('whatsapp', { conversationId: '120363012345@g.us' })).toBe(true);
    expect(isRelayGroup('whatsapp', { conversationId: '15550001111@s.whatsapp.net' })).toBe(false);
    expect(isRelayGroup('signal', { conversationId: '+15550001111', channelMeta: { groupId: 'abc==' } })).toBe(true);
    expect(isRelayGroup('signal', { conversationId: '+15550001111' })).toBe(false);
    expect(isRelayGroup('imessage', { conversationId: 'iMessage;+;chat123456' })).toBe(true);
    expect(isRelayGroup('imessage', { conversationId: 'iMessage;-;+15550001111' })).toBe(false);
    expect(isRelayGroup('discord', { conversationId: '123', channelMeta: { guildId: 'g1' } })).toBe(true);
    expect(isRelayGroup('signal', { conversationId: 'x', channelMeta: { isGroup: true } })).toBe(true);
  });
});

describe('ingress hands each turn its scope (real app, loop stubbed)', () => {
  let h: Harness;
  const TG = 'tg-scope-secret-0123456789';
  const sent: string[] = [];
  beforeAll(async () => {
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '10000';
    h = await bootChannelHarness('c1042sc');
    getAgentRegistry().register({
      agentId: AGENT, persona: 'Channel agent', modelClass: 'general', systemPrompt: 'You help.',
      packName: 'core.openwop.test', packVersion: '0', toolAllowlist: [...AGENT_TOOLS],
    });
    registerReplyTransport('telegram', async (r) => { sent.push(r.chatId); return { sent: true, providerRef: 'x' }; });
    registerReplyTransport('relay', async (r) => { sent.push(r.chatId); return { sent: true, providerRef: 'x' }; });
    const d = getToggleDefault('channel-ingress');
    await saveConfig({ ...d!, status: 'on' }, 'test');
  }, 120_000);
  afterAll(async () => {
    const d = getToggleDefault('channel-ingress');
    await saveConfig({ ...d!, status: 'off' }, 'test');
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    delete process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN;
    await h?.close();
  });

  async function waitForCall(n: number): Promise<(typeof calls)[number]> {
    const end = Date.now() + 45_000;
    while (calls.length < n) {
      if (Date.now() > end) throw new Error(`expected ${n} loop calls, saw ${calls.length}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return calls[n - 1]!;
  }

  async function connection(cookie: string): Promise<string> {
    const created = await h.call(CONN, cookie, 'POST', { provider: 'telegram', kind: 'bearer', secret: '9:tok' });
    const id = text(field(created.body, 'connectionId'));
    expect((await h.call(`${CONN}/${encodeURIComponent(id)}/inbound`, cookie, 'PUT', { signingSecret: TG })).status).toBe(201);
    return id;
  }
  const deliver = (id: string, body: unknown) => fetch(`${h.base}/host/openwop-app/connections-inbound/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TG }, body: JSON.stringify(body),
  });
  const dm = (u: number, from: number) => ({ update_id: u, message: { message_id: u, chat: { id: from, type: 'private' }, from: { id: from }, text: 'hi' } });
  const group = (u: number, chat: number, from: number) => ({ update_id: u, message: { message_id: u, chat: { id: chat, type: 'group' }, from: { id: from }, text: 'hey @thebot' } });

  it('an outside sender is narrow; the owner\'s self sender is full; a group is narrow even from the self sender', async () => {
    const editor = await h.editor();
    const id = await connection(editor);
    expect((await h.call(`${CONN}/${encodeURIComponent(id)}/channel`, editor, 'PUT', { botHandle: 'thebot', agentId: AGENT, provider: 'mock', model: 'mock-1' })).status).toBe(200);
    for (const s of ['701', '702', 'group:-900']) await h.call(`${CONN}/${encodeURIComponent(id)}/senders`, editor, 'POST', { senderId: s, ...(s.startsWith('group:') ? { groupAcknowledged: true } : {}) });
    expect((await h.call(`${CONN}/${encodeURIComponent(id)}/senders/702/self`, editor, 'PUT', { self: true })).status).toBe(200);

    const n1 = calls.length; // captured BEFORE the send: the turn can land before it returns
    expect((await deliver(id, dm(1, 701))).status).toBe(202);
    expect((await waitForCall(n1 + 1)).toolScope).toEqual({ mode: 'narrow' });
    // …and a narrow turn loads none of the agent's memory or a twin's recall.
    expect(composed[composed.length - 1]).toBe(true);
    const n2 = calls.length; // captured BEFORE the send: the turn can land before it returns
    expect((await deliver(id, dm(2, 702))).status).toBe(202);
    expect((await waitForCall(n2 + 1)).toolScope).toBeUndefined();
    expect(composed[composed.length - 1]).toBeUndefined();
    // Even a group row that somehow carries `self` (written past the route's refusal)
    // never makes a group message self.
    await setSenderSelf(h.ws, `conn:${id}`, 'group:-900', true);
    const n3 = calls.length; // captured BEFORE the send: the turn can land before it returns
    expect((await deliver(id, group(3, -900, 702))).status).toBe(202);
    expect((await waitForCall(n3 + 1)).toolScope).toEqual({ mode: 'narrow' });
  }, 60_000);

  it('N1: one chat that turns self later gets a NEW conversation; the full one never holds the narrow text', async () => {
    const editor = await h.editor();
    const id = await connection(editor);
    expect((await h.call(`${CONN}/${encodeURIComponent(id)}/channel`, editor, 'PUT', { agentId: AGENT, provider: 'mock', model: 'mock-1' })).status).toBe(200);
    await h.call(`${CONN}/${encodeURIComponent(id)}/senders`, editor, 'POST', { senderId: '731' });
    const n1 = calls.length;
    expect((await deliver(id, { update_id: 31, message: { message_id: 31, chat: { id: 731, type: 'private' }, from: { id: 731 }, text: 'narrow-era secret' } })).status).toBe(202);
    expect((await waitForCall(n1 + 1)).toolScope?.mode).toBe('narrow');
    expect((await h.call(`${CONN}/${encodeURIComponent(id)}/senders/731/self`, editor, 'PUT', { self: true })).status).toBe(200);
    const n2 = calls.length;
    expect((await deliver(id, { update_id: 32, message: { message_id: 32, chat: { id: 731, type: 'private' }, from: { id: 731 }, text: 'now me' } })).status).toBe(202);
    expect((await waitForCall(n2 + 1)).toolScope).toBeUndefined();
    const sessions = (await h.storage.listChatSessions(h.ws)).filter((x) => x.title.includes('· 731'));
    expect(sessions).toHaveLength(2);
    const full = sessions.find((x) => x.title.endsWith('(you)'))!;
    const text = (await h.storage.listChatSessionMessages(full.sessionId)).map((m) => m.content).join(' ');
    expect(text).toContain('now me');
    expect(text).not.toContain('narrow-era secret');
  }, 60_000);

  it('relay: only a from-me message in the owner\'s note-to-self chat is full; it gets its OWN conversation; a contact chat stays narrow, in-app turns included', async () => {
    const editor = await h.editor();
    const M = '/host/openwop-app/messaging';
    const OWN = '+15550001234'; // the device's own account
    const CONTACT = '+15550007777';
    const post = async (path: string, body: unknown, headers: Record<string, string>) => {
      const res = await fetch(`${h.base}${M}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    };
    const reg = await post('/relay/register', { channel: 'signal', accountId: OWN }, { cookie: editor });
    const act = await post('/relay/activate', { relayId: reg.relayId, activationCode: reg.activationCode }, { cookie: editor });
    const dev = { 'x-openwop-device-token': String(act.deviceToken) };
    // ADR 1043 D9 — the device's owner approves the contact for this device; the
    // note-to-self chat needs no approval (only the owner sets the account id).
    expect(await post(`/relay/${String(reg.relayId)}/senders`, { senderId: CONTACT }, { cookie: editor })).toMatchObject({ sender: { senderId: CONTACT } });
    await putChannelSettings({ laneKey: `relay:${String(reg.relayId)}`, tenantId: h.ws, agentId: AGENT, provider: 'mock', model: 'mock-1', updatedAt: new Date().toISOString() });

    // A contact's message: narrow.
    const n4 = calls.length; // captured BEFORE the send: the turn can land before it returns
    const r1 = await post('/device/inbound', { platformMessageId: 'r1', conversationId: CONTACT, peerId: CONTACT, text: 'contact secret words' }, dev);
    expect(r1, JSON.stringify(r1)).toMatchObject({ accepted: true });
    expect((await waitForCall(n4 + 1)).toolScope).toEqual({ mode: 'narrow' });

    // The owner's outgoing message in the CONTACT's chat, flagged from-me: not a command.
    const n5 = calls.length;
    const r2 = await post('/device/inbound', { platformMessageId: 'r2', conversationId: CONTACT, peerId: OWN, text: 'run something', fromMe: true }, dev);
    expect(r2).toMatchObject({ accepted: false, dropped: 'own_outgoing' });

    // Note-to-self (the chat IS the owner's own account): full, in its OWN conversation.
    const r3 = await post('/device/inbound', { platformMessageId: 'r3', conversationId: OWN, peerId: OWN, text: 'note to self', fromMe: true }, dev);
    expect(r3).toMatchObject({ accepted: true });
    expect((await waitForCall(n5 + 1)).toolScope).toBeUndefined();
    expect(calls.length).toBe(n5 + 1); // r2 ran nothing
    expect(r3.conversationId).not.toBe(r1.conversationId);
    // The full conversation never holds the contact's words.
    const selfMsgs = await h.storage.listChatSessionMessages(String(r3.conversationId));
    expect(selfMsgs.map((m) => m.content).join(' ')).not.toContain('contact secret words');

    // An in-app turn the owner sends from the main chat into the CONTACT conversation
    // is still narrow (no agent memory loaded), because the conversation is narrow.
    const { getConversationMeta } = await import('../src/host/conversationStore.js');
    const runId = (await getConversationMeta(h.ws, String(r1.conversationId)))?.conversationRunId;
    expect(runId).toBeTruthy();
    const before = composed.length;
    const { toWireRunId } = await import('../src/host/v2Ids.js');
    const res = await fetch(`${h.base}/runs/${encodeURIComponent(toWireRunId(String(runId), h.ws))}/interrupts/gate`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: editor },
      body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'from the main chat', to: AGENT } } }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    await waitForCall(n5 + 2);
    expect(composed.slice(before)).toContain(true);
  }, 90_000);

  it('only the approval\'s owner can mark self; never a group; at most one per owner per lane', async () => {
    const editor = await h.editor();
    const id = await connection(editor);
    const lane = `conn:${id}`;
    for (const s of ['801', '802', 'group:-1']) await h.call(`${CONN}/${encodeURIComponent(id)}/senders`, editor, 'POST', { senderId: s, ...(s.startsWith('group:') ? { groupAcknowledged: true } : {}) });
    // Another member with workspace write (the connection is the editor's own row, so
    // editor2 reaches this route only on a sender editor2 approved through the store).
    await approveSender({ tenantId: h.ws, laneKey: lane, senderId: '803', ownerUserId: h.editorUserId });
    const other = await h.call(`${CONN}/${encodeURIComponent(id)}/senders/801/self`, await h.editor2(), 'PUT', { self: true });
    expect([403, 404]).toContain(other.status); // editor2 cannot even manage this connection
    await approveSender({ tenantId: h.ws, laneKey: lane, senderId: '804', ownerUserId: h.editor2UserId });
    const notOwner = await h.call(`${CONN}/${encodeURIComponent(id)}/senders/804/self`, editor, 'PUT', { self: true });
    expect(notOwner.status, 'the connection manager is not the approval\'s owner').toBe(403);
    expect((await h.call(`${CONN}/${encodeURIComponent(id)}/senders/group:-1/self`, editor, 'PUT', { self: true })).status).toBe(400);
    expect((await h.call(`${CONN}/${encodeURIComponent(id)}/senders/801/self`, editor, 'PUT', { self: true })).status).toBe(200);
    expect((await h.call(`${CONN}/${encodeURIComponent(id)}/senders/802/self`, editor, 'PUT', { self: true })).status).toBe(200);
    const list = await h.call(`${CONN}/${encodeURIComponent(id)}/senders`, editor);
    const selfIds = ((field(list.body, 'approved') ?? []) as unknown[]).filter((s) => field(s, 'self') === true).map((s) => field(s, 'senderId'));
    expect(selfIds).toEqual(['802']);
  });
});
