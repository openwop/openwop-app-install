/**
 * OpenAI Realtime sideband (ADR 0141 RT-4 — the architect deep-dive fix).
 *
 * OpenAI's own production guidance: tool use + business logic belong on YOUR server. The
 * "sideband" is a second connection to the SAME realtime session — the browser keeps the
 * WebRTC audio, and the host opens a server-side WebSocket (`?call_id=…`, server API key) that
 * (a) HANDLES function calls server-side and (b) RECEIVES all events including transcripts.
 *
 * This retires the two blocking findings for the OpenAI path:
 *  - #1 firewall bypass — tool execution runs on the HOST's session connection, keyed on the
 *    host-owned `call_id` (from the SDP `Location` header), not a client-asserted session id.
 *  - #2 no audit/chat record — the host receives every transcript and persists it to the
 *    conversation (the ONE chat) for the chat feed + audit.
 *
 * The live WebSocket is VERIFY-WITH-KEY (no key/network here); `handleSidebandEvent` is a pure
 * function unit-tested with synthetic events.
 */
import { randomUUID } from 'node:crypto';
import { hostExtStorage } from '../../../host/hostExtPersistence.js';
import { publishChatMessageAppended } from '../../../host/chatMessageBus.js';
import { createLogger } from '../../../observability/logger.js';
import type { ChatMessageRecord } from '../../../types.js';
import { executeRealtimeToolCall, clearRealtimeSessionTools } from './toolBridge.js';
import {
  DELEGATE_TOOL, RETURN_TOOL, armDelegation, clearDelegation, delegationStateOf,
  type DelegableAgent, type SpeakerSnapshot,
} from './delegation.js';
import { truncateFencedContent } from '../../../host/untrustedContent.js';

/** TOCC-4 (ADR 0604) — the budget for a tool result spoken back into a LIVE
 *  realtime session. Applied with `truncateFencedContent`, NEVER a bare
 *  `.slice()`: `resultText` arrives ALREADY FENCED from `toolBridge.ts`, and a
 *  plain slice at this length drops `END UNTRUSTED CONTENT` (the fence header
 *  alone is ~230 chars), injecting an unterminated data-only fence into a live
 *  model session. */
const SIDEBAND_RESULT_MAX_CHARS = 4000;

const log = createLogger('features.voice.realtime.sideband');

export interface SidebandSession {
  /** Host-owned session id (OpenAI `call_id` from the SDP `Location` header). */
  callId: string;
  tenantId: string;
  agentId?: string;
  conversationId?: string;
  /** ADR 0324 — the AUTHENTICATED session opener (resolved at …/openai/connect,
   *  never client-asserted). Threaded into every tool call as `actingUserId` so
   *  the ADR 0308 deliverable tools work over voice exactly as over chat; absent
   *  (anonymous/unresolvable) ⇒ those tools fail closed, as designed. */
  userId?: string;
  /** ADR 0627 D3 (review S2) — the opener's personal tenant (mint-time, never
   *  the body); threaded with `userId` so req-less tenant gates keep the
   *  implicit-owner rule over voice. */
  personalTenant?: string;
  /** ADR 0304 D1 — the agent currently HOLDING THE FLOOR (the delegate while a
   *  spoken hand-off is live, else the home agent). Mutated by the delegation
   *  branches below; every tool call + assistant-turn attribution reads it. */
  boundAgentId?: string;
  /** Display persona of `boundAgentId`, stamped into attribution meta. */
  boundPersona?: string;
}

/** CS-VX-3 (conversation-stack audit) — a sideband failure previously degraded
 *  the call SILENTLY on the audio side (default persona, no tools, no
 *  transcripts; server-log only) — the user kept talking to an ungoverned
 *  model. Persist a system notice into the conversation (the bus frame shows
 *  it live in an open chat) so the degradation is user-visible. Best-effort. */
async function persistDegradedNotice(s: SidebandSession): Promise<void> {
  if (!s.conversationId) return;
  try {
    const session = await hostExtStorage().getChatSession(s.tenantId, s.conversationId);
    if (!session) return;
    const record: ChatMessageRecord = {
      messageId: `voice-degraded-${s.callId}`, sessionId: s.conversationId, role: 'system',
      content: 'Voice session degraded: the governed connection dropped, so persona, tools, and transcripts are unavailable for the rest of this call. Hang up and reconnect to restore them.',
      meta: JSON.stringify({ source: 'voice-realtime', kind: 'voice-degraded' }),
      authorSubject: null, createdAt: new Date().toISOString(),
    };
    await hostExtStorage().appendChatMessage(record);
    publishChatMessageAppended(record, s.tenantId);
  } catch (err) {
    log.warn('voice_degraded_notice_failed', { callId: s.callId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Persist a committed transcript turn to the conversation — the audit record + the chat feed
 *  (rides the ONE chat; `meta.source` marks it voice-originated). */
async function persistTranscript(s: SidebandSession, role: 'user' | 'assistant', text: string): Promise<void> {
  const t = text.trim();
  if (!s.conversationId || !t) return;
  // Only persist into an EXISTING conversation — don't crash on a missing id and don't create a
  // phantom session (createChatSession is a plain INSERT, not an upsert).
  const session = await hostExtStorage().getChatSession(s.tenantId, s.conversationId);
  if (!session) return;
  // ADR 0304 D4 — assistant turns carry the SPEAKER's agent id (the delegate while a
  // hand-off is live), so a multi-voice call reloads with correct per-agent attribution.
  const speaker = role === 'assistant' ? (s.boundAgentId ?? s.agentId) : undefined;
  const record: ChatMessageRecord = {
    messageId: randomUUID(), sessionId: s.conversationId, role, content: t.slice(0, 100_000),
    meta: JSON.stringify({
      source: 'voice-realtime',
      ...(speaker ? { agentId: speaker } : {}),
      ...(role === 'assistant' && s.boundPersona ? { agentPersona: s.boundPersona } : {}),
    }),
    authorSubject: null, createdAt: new Date().toISOString(),
  };
  await hostExtStorage().appendChatMessage(record);
  await hostExtStorage().updateChatSession(s.tenantId, s.conversationId, { messageCount: session.messageCount + 1, updatedAt: new Date().toISOString() });
  // Publish the live-delivery event so an OPEN chat gets the turn immediately (not only on
  // reload). The OpenAI browser holds audio-only WebRTC — it never sees a transcript — so this
  // bus frame is the sole live path. 1:1/agent voice chats aren't multi-party, so the bus's
  // mention-stamp + channel-notify work is a no-op; only the per-conversation frame fires.
  publishChatMessageAppended(record, s.tenantId);
}

export interface SidebandDeps {
  persist: (s: SidebandSession, role: 'user' | 'assistant', text: string) => Promise<void>;
  /** ADR 0304 D1 — spoken delegation (present only when the mint declared the tool):
   *  compose a target agent's full speaker snapshot + enumerate the delegable roster. */
  delegation?: {
    composeFor: (agentId: string) => Promise<SpeakerSnapshot | null>;
    delegable: readonly DelegableAgent[];
  };
}
const DEFAULT_DEPS: SidebandDeps = { persist: persistTranscript };

interface SidebandEvent { type?: string; name?: string; arguments?: string; call_id?: string; transcript?: string }

/** The `session.update` for one speaker (home restore or delegate swap). */
function speakerUpdate(snap: SpeakerSnapshot): Record<string, unknown> {
  return sessionUpdate({ instructions: snap.instructions, tools: snap.tools, ...(snap.voice ? { voice: snap.voice } : {}) });
}

/** Rebind the session's floor-holder (tool allowlist + attribution follow it). */
function bindSpeaker(s: SidebandSession, agentId: string | undefined, persona: string | undefined): void {
  if (agentId) s.boundAgentId = agentId; else delete s.boundAgentId;
  if (persona) s.boundPersona = persona; else delete s.boundPersona;
}

/**
 * Handle one parsed OpenAI sideband event → the events to send back to the model (tool output),
 * or none. Tool calls run through the EXISTING allowlist + composition firewall + executor,
 * keyed on the host-owned `callId`; transcripts are persisted. Pure (deps-injected) — unit-tested.
 *
 * ADR 0304 D1 — the `voice__delegate_to_agent` / `voice__return_to_agent` SESSION-CONTROL
 * tools are intercepted HERE, before the tool bridge: they are host session mechanics, not
 * agent capabilities, and never reach allowlist/firewall/executor. While delegated, the
 * session's `boundAgentId` is the target, so ordinary tool calls enforce the TARGET's
 * allowlist (no privilege union) and assistant turns attribute to the target.
 */
export async function handleSidebandEvent(s: SidebandSession, evt: SidebandEvent, deps: SidebandDeps = DEFAULT_DEPS): Promise<Array<Record<string, unknown>>> {
  const delegation = delegationStateOf(s.callId);

  if (evt.type === 'response.function_call_arguments.done' && evt.name && evt.call_id) {
    const args = ((): Record<string, unknown> => { try { return JSON.parse(evt.arguments ?? '{}'); } catch { return {}; } })();

    // ── Spoken delegation (session control — never the tool bridge) ────────
    if (evt.name === DELEGATE_TOOL) {
      const fail = (reason: string): Array<Record<string, unknown>> => ([
        { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output: `[unavailable] ${reason}` } },
        { type: 'response.create' },
      ]);
      if (!deps.delegation || !delegation) return fail('Delegation is not available in this session.');
      if (delegation.delegate) return fail('A delegation is already in progress — finish or return first.');
      const targetId = typeof args.agentId === 'string' ? args.agentId : '';
      const target = deps.delegation.delegable.find((d) => d.agentId === targetId);
      if (!target) return fail(`"${targetId}" is not a delegable agent on this roster.`);
      const snap = await deps.delegation.composeFor(target.agentId).catch(() => null);
      if (!snap) return fail(`${target.persona} could not be prepared for this call.`);
      const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : 'the user\'s last question';
      delegation.delegate = { agentId: target.agentId, persona: target.persona, phase: 'requested' };
      bindSpeaker(s, target.agentId, target.persona);
      // Grade-pass fix (VOX-G1): the floor swap is a GOVERNANCE event (the
      // enforced allowlist changes) — audit it like RTV-4 audits tool calls.
      log.info('voice_delegation_started', { tenantId: s.tenantId, callId: s.callId, fromAgentId: delegation.home.agentId, toAgentId: target.agentId });
      return [
        speakerUpdate(snap),
        { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output: `Hand-off accepted. You are now ${target.persona}. Answer this, concisely and in character: ${question} When you are done, call ${RETURN_TOOL}.` } },
        { type: 'response.create' },
      ];
    }
    if (evt.name === RETURN_TOOL) {
      if (!delegation?.delegate) {
        return [
          { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output: 'You already hold the floor — continue.' } },
          { type: 'response.create' },
        ];
      }
      const returnedFrom = delegation.delegate.persona;
      log.info('voice_delegation_returned', { tenantId: s.tenantId, callId: s.callId, fromAgentId: delegation.delegate.agentId, toAgentId: delegation.home.agentId, via: 'return_tool' });
      delete delegation.delegate;
      bindSpeaker(s, delegation.home.agentId, undefined);
      return [
        speakerUpdate(delegation.home),
        { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output: `${returnedFrom} handed the conversation back to you. Briefly acknowledge and continue.` } },
        { type: 'response.create' },
      ];
    }

    // ── Ordinary tool call — the bridge, bound to the CURRENT floor-holder ──
    // ADR 0324 — the acting user is the session OPENER (the human on the call),
    // also while a delegation holds the floor: the delegate acts for the same
    // human, under the delegate's own allowlist.
    const outcome = await executeRealtimeToolCall({
      tenantId: s.tenantId, agentId: s.boundAgentId ?? s.agentId, sessionId: s.callId, name: evt.name, args,
      ...(s.userId ? { actingUserId: s.userId } : {}),
      ...(s.conversationId ? { conversationId: s.conversationId } : {}),
      ...(s.personalTenant ? { personalTenant: s.personalTenant } : {}),
    });
    // A7 — a require-approval verdict HOLDS the call for a chat-side decision
    // (session opener only; the spoken refusal below stays the honest default).
    if (outcome.status === 'requires_approval' && s.userId && s.conversationId && evt.call_id) {
      const existing = [...heldApprovals.keys()].filter((k) => k.startsWith(`${s.callId}:`)).length;
      if (existing < MAX_HELD_PER_CALL) {
        heldApprovals.set(heldKey(s.callId, evt.call_id), {
          tenantId: s.tenantId, userId: s.userId, conversationId: s.conversationId,
          ...(s.personalTenant ? { personalTenant: s.personalTenant } : {}),
          agentId: s.boundAgentId ?? s.agentId, name: evt.name, args, heldAt: Date.now(),
        });
        await persistVoiceApprovalNotice(s, `The voice assistant wants to run ${evt.name} — a sensitive action that needs your approval.`, {
          kind: 'voice-approval-request', toolName: evt.name, callId: s.callId, fcId: evt.call_id,
        });
      }
    }
    const output = outcome.status === 'ok' ? outcome.result : `[${outcome.status}] ${outcome.reason}`;
    // A mid-answer tool round-trip spawns another response — re-arm the lifecycle
    // so ITS `response.done` doesn't end the delegation prematurely.
    if (delegation?.delegate) delegation.delegate.phase = 'requested';
    return [
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output } },
      { type: 'response.create' },
    ];
  }

  // ── One-shot auto-return (ADR 0304 D1.5): the delegated ANSWER finished ──
  if (evt.type === 'response.created' && delegation?.delegate?.phase === 'requested') {
    delegation.delegate.phase = 'answering';
    return [];
  }
  if (evt.type === 'response.done' && delegation?.delegate?.phase === 'answering') {
    log.info('voice_delegation_returned', { tenantId: s.tenantId, callId: s.callId, fromAgentId: delegation.delegate.agentId, toAgentId: delegation.home.agentId, via: 'one_shot' });
    delete delegation.delegate;
    bindSpeaker(s, delegation.home.agentId, undefined);
    // Silent restore — the home agent resumes on the user's next utterance.
    return [speakerUpdate(delegation.home)];
  }

  if (evt.type === 'conversation.item.input_audio_transcription.completed' && evt.transcript) { await deps.persist(s, 'user', evt.transcript); return []; }
  if (evt.type === 'response.audio_transcript.done' && evt.transcript) { await deps.persist(s, 'assistant', evt.transcript); return []; }
  return [];
}

/**
 * ADR 0199 OQ-1 (Deferred Phase G) — prior conversation turns as REAL history
 * items for the model (`conversation.item.create` message items), replacing
 * the transcript-in-instructions block on the OpenAI path. Deliberately no
 * trailing `response.create`: seeding history must not trigger a reply.
 * Pure — unit-tested alongside `handleSidebandEvent`.
 */
export function seedConversationItems(
  turns: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
): Array<Record<string, unknown>> {
  return turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) => ({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: t.role,
        // The Realtime API's content types differ by role: user history is
        // `input_text`; assistant history is `text`.
        content: [t.role === 'user' ? { type: 'input_text', text: t.text } : { type: 'text', text: t.text }],
      },
    }));
}

// ── A7 (ADR 0467 follow-on) — held SENSITIVE calls awaiting a chat-side decision ──
// The sideband's tool loop is server-side (the browser is audio-only), so the
// in-voice card can't render there. Instead: the refusal is spoken (unchanged),
// the call is HELD here, and a structured notice lands in the conversation —
// the ONE chat renders Approve/Deny, and the resolver below re-executes with
// the same one-shot `userApproved` authority as the browser-relay card (#2386).
interface HeldApproval {
  tenantId: string;
  /** The session OPENER — the only human who may resolve (mint-time bound). */
  userId: string;
  personalTenant?: string;
  conversationId: string;
  agentId?: string | undefined;
  name: string;
  args: Record<string, unknown>;
  heldAt: number;
}
const heldApprovals = new Map<string, HeldApproval>(); // `${callId}:${fcId}`
const MAX_HELD_PER_CALL = 8;
const heldKey = (callId: string, fcId: string): string => `${callId}:${fcId}`;
function clearHeldForCall(callId: string): void {
  for (const k of heldApprovals.keys()) if (k.startsWith(`${callId}:`)) heldApprovals.delete(k);
}
export function __heldApprovalsForTests(): Map<string, HeldApproval> { return heldApprovals; }

/** Persist the approval-request (or outcome) notice into the conversation —
 *  same ride as transcripts/degraded notices (the bus frame shows it live). */
async function persistVoiceApprovalNotice(
  s: Pick<SidebandSession, 'tenantId' | 'conversationId'>,
  content: string,
  meta: Record<string, unknown>,
): Promise<void> {
  if (!s.conversationId) return;
  try {
    const session = await hostExtStorage().getChatSession(s.tenantId, s.conversationId);
    if (!session) return;
    const record: ChatMessageRecord = {
      messageId: randomUUID(), sessionId: s.conversationId, role: 'system', content,
      meta: JSON.stringify({ source: 'voice-realtime', ...meta }),
      authorSubject: null, createdAt: new Date().toISOString(),
    };
    await hostExtStorage().appendChatMessage(record);
    await hostExtStorage().updateChatSession(s.tenantId, s.conversationId, { messageCount: session.messageCount + 1, updatedAt: new Date().toISOString() });
    publishChatMessageAppended(record, s.tenantId);
  } catch (err) {
    log.warn('voice_approval_notice_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Resolve a held sideband call from the chat card. One-shot both ways (the
 * entry is consumed). Authority: the CALLER must be the session opener — the
 * same human whose click authorizes the browser-relay card. On approve the
 * tool executes with `userApproved` (per-tool one-shot; hard denies still
 * deny), the outcome is persisted to the conversation, and — when the call is
 * still live — spoken back into the session (user-role inject + response).
 */
export async function resolveHeldSidebandCall(input: {
  tenantId: string; userId: string; callId: string; fcId: string; approve: boolean;
}): Promise<{ status: 'executed' | 'denied' | 'not_found' | 'forbidden'; resultText?: string }> {
  const key = heldKey(input.callId, input.fcId);
  const held = heldApprovals.get(key);
  if (!held || held.tenantId !== input.tenantId) return { status: 'not_found' };
  if (held.userId !== input.userId) return { status: 'forbidden' };
  heldApprovals.delete(key);
  if (!input.approve) {
    await persistVoiceApprovalNotice(
      { tenantId: held.tenantId, conversationId: held.conversationId },
      `Declined: the voice assistant's request to run ${held.name} was not approved.`,
      { kind: 'voice-approval-resolved', toolName: held.name, approved: false },
    );
    return { status: 'denied' };
  }
  const outcome = await executeRealtimeToolCall({
    tenantId: held.tenantId, agentId: held.agentId, sessionId: input.callId,
    name: held.name, args: held.args,
    actingUserId: held.userId, conversationId: held.conversationId,
    ...(held.personalTenant ? { personalTenant: held.personalTenant } : {}),
    userApproved: true,
  });
  const resultText = outcome.status === 'ok' ? outcome.result : `[${outcome.status}] ${outcome.reason}`;
  await persistVoiceApprovalNotice(
    { tenantId: held.tenantId, conversationId: held.conversationId },
    `Approved: ${held.name} ran from the chat. ${outcome.status === 'ok' ? 'Result delivered to the voice session.' : resultText}`,
    { kind: 'voice-approval-resolved', toolName: held.name, approved: true, outcome: outcome.status },
  );
  // Speak the outcome back into the LIVE call (best-effort; the call may have ended).
  const ws = sessions.get(input.callId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[The user approved running ${held.name} from the chat. Tool result: ${truncateFencedContent(resultText, SIDEBAND_RESULT_MAX_CHARS)}]` }] },
    }));
    ws.send(JSON.stringify({ type: 'response.create' }));
  }
  return { status: 'executed', resultText };
}

// ── Live sideband (verify-with-key) ─────────────────────────────────────────
type WSCtor = new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket;
const sessions = new Map<string, WebSocket>();

/** The `session.update` that locks the agent's persona + tools + voice + transcription on the
 *  HOST side (the browser never sets these). */
function sessionUpdate(session: { instructions: string; tools: ReadonlyArray<Record<string, unknown>>; voice?: string }): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      instructions: session.instructions,
      tools: session.tools,
      ...(session.voice ? { audio: { output: { voice: session.voice } } } : {}),
      // Enable input transcription so the user's speech is captured for persistence/audit.
      input_audio_transcription: { model: 'whisper-1' },
    },
  };
}

/** Open the server-side sideband to OpenAI for a live call. Sends the session config, then
 *  handles tools + transcripts for the session's lifetime. (Live network — verify-with-key.) */
export function openSideband(
  s: SidebandSession,
  apiKey: string,
  config: {
    instructions: string;
    tools: ReadonlyArray<Record<string, unknown>>;
    voice?: string;
    /** Phase G — prior turns injected as history items right after session.update. */
    seedTurns?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
    /** ADR 0304 D1 — spoken delegation (declared at mint only when delegable agents exist). */
    delegation?: NonNullable<SidebandDeps['delegation']>;
  },
): void {
  const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(s.callId)}`;
  const ws = new (WebSocket as unknown as WSCtor)(url, { headers: { authorization: `Bearer ${apiKey}`, 'openai-beta': 'realtime=v1' } });
  const teardown = (): void => { sessions.delete(s.callId); clearRealtimeSessionTools(s.callId); clearDelegation(s.callId); clearHeldForCall(s.callId); };
  // ADR 0304 D1 — capture the HOME speaker so a delegation can be restored one-shot.
  const deps: SidebandDeps = config.delegation ? { persist: persistTranscript, delegation: config.delegation } : DEFAULT_DEPS;
  if (config.delegation) {
    armDelegation(s.callId, {
      ...(s.agentId ? { agentId: s.agentId } : {}),
      instructions: config.instructions,
      tools: config.tools,
      ...(config.voice ? { voice: config.voice } : {}),
    });
  }
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify(sessionUpdate(config)));
    // Phase G — seed prior turns as history items (session.update first so the
    // persona/tools are locked before any history lands; no response.create).
    for (const item of seedConversationItems(config.seedTurns ?? [])) ws.send(JSON.stringify(item));
  });
  ws.addEventListener('message', (e: MessageEvent) => { void (async () => {
    // A throw here (e.g. tool exec or transcript persistence) must NOT become an unhandled
    // rejection — log and continue the session.
    try {
      let evt: SidebandEvent; try { evt = JSON.parse(String((e as MessageEvent).data)); } catch { return; }
      const out = await handleSidebandEvent(s, evt, deps);
      for (const o of out) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
    } catch (err) {
      // ADR 0733: was `console.error`, which bypasses the sink — and THIS channel
      // carries transcripts, so a driver message here is the likeliest place for a
      // participant's address to reach stdout unmasked.
      log.error('voice_sideband_event_handling_failed', { callId: s.callId, error: err instanceof Error ? err.message : String(err) });
    }
  })(); });
  // GRADE-15 — a sideband failure was fully SILENT: the call proceeded with the
  // default persona, no tools, no transcripts, and no audit record, invisibly
  // (the session config is applied only via `session.update` over this WS).
  // Log both failure shapes; keep the fail-soft behavior (the audio call must
  // not drop because the sideband did).
  let sidebandOpened = false;
  ws.addEventListener('open', () => { sidebandOpened = true; });
  ws.addEventListener('close', () => {
    if (!sidebandOpened) {
      log.error('voice_sideband_closed_before_open', { callId: s.callId, impact: 'call runs without persona/tools/transcripts' });
      void persistDegradedNotice(s); // CS-VX-3 — surface it in the chat, not only ops
    }
    teardown();
  });
  ws.addEventListener('error', (e: Event) => {
    log.error('voice_sideband_socket_error', {
      callId: s.callId,
      preOpen: !sidebandOpened,
      ...(sidebandOpened ? {} : { impact: 'call runs without persona/tools/transcripts' }),
      error: (e as { message?: string }).message ?? 'unknown',
    });
    void persistDegradedNotice(s); // CS-VX-3 — mid-call loss is equally silent otherwise
    teardown();
  });
  sessions.set(s.callId, ws);
}

export function closeSideband(callId: string): void {
  const ws = sessions.get(callId);
  if (ws) { try { ws.close(); } catch { /* ignore */ } }
  sessions.delete(callId);
  clearRealtimeSessionTools(callId); // release the firewall seen-set (it has no other reaper)
  clearDelegation(callId); // release the delegation state with it
}
