/**
 * Real-time voice sessions — route-level tests (ADR 0141 RT-1).
 *
 * Boots the real app and drives the session-bootstrap + tenant config at the HTTP
 * boundary. Under the test seam the provider adapters return a deterministic mock token
 * (no key/network), so the wiring — toggle gate, not-configured fallback, BYOK resolution,
 * provider selection — is verifiable without a real key. (The live provider call itself is
 * verify-with-key.)
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { voiceFeature } from '../src/features/voice/feature.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { buildGeminiConstraint, geminiLiveProvider } from '../src/features/voice/realtime/geminiLive.js';
import { resolveWireToolName } from '../src/features/voice/realtime/toolBridge.js';
import { sanitizeToolName } from '../src/providers/dispatchProviderTools.js';
import { handleSidebandEvent, type SidebandSession, seedConversationItems } from '../src/features/voice/realtime/openaiSideband.js';
import { DELEGATE_TOOL, RETURN_TOOL, armDelegation, clearDelegation, delegationStateOf } from '../src/features/voice/realtime/delegation.js';
import { ensureConversationMeta, markAsBoardGroup } from '../src/host/conversationStore.js';
import { registerBoardContextResolver, __resetBoardSeams } from '../src/host/boardContextResolver.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { upsertAgentToolAllowlistOverride, clearAgentToolAllowlistOverride } from '../src/host/agentToolAllowlistService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { resolveAgentVoice } from '../src/features/voice/voiceSession.js';
import { resolveAgentToolDecls } from '../src/features/voice/realtime/toolBridge.js';
import { createUser } from '../src/features/users/usersService.js';
import { composeChatContext, TOOL_GROUNDED_COMMITMENTS } from '../src/host/chatContext.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { subscribeConversationMessages } from '../src/host/chatMessageBus.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const post = (p: string, b?: unknown) => fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: b === undefined ? undefined : JSON.stringify(b) });
const put = (p: string, b: unknown) => fetch(`${BASE}${p}`, { method: 'PUT', headers: H, body: JSON.stringify(b) });
const get = (p: string) => fetch(`${BASE}${p}`, { headers: H });
const RT = '/v1/host/openwop-app/voice/realtime';
const setVoice = (status: 'on' | 'off') => saveConfig({ ...voiceFeature.toggleDefault!, status }, 'test');

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_VOICE_MOCK = 'true'; // voice mocks moved off the seam flag (prod keeps the seam on)
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_VOICE_MOCK;
  await __clearToggleStore();
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0141 RT-1 — realtime session bootstrap', () => {
  it('returns {realtime:null} when no provider is configured (FE falls back to walkie-talkie)', async () => {
    await setVoice('on');
    await put(`${RT}/config`, { provider: 'off' });
    const res = await post(`${RT}/session`, {});
    expect(res.status).toBe(200);
    expect((await res.json() as { realtime: unknown }).realtime).toBeNull();
  });

  it('config PUT/GET round-trips (never returns the key)', async () => {
    await setVoice('on');
    await put(`${RT}/config`, { provider: 'openai-realtime', credentialRef: 'rt-openai' });
    const c = await (await get(`${RT}/config`)).json() as { provider: string; credentialRef?: string; apiKey?: string };
    expect(c.provider).toBe('openai-realtime');
    expect(c.credentialRef).toBe('rt-openai');
    expect(c.apiKey).toBeUndefined();
  });

  it('400s with a clear error when the provider is set but its BYOK key is missing', async () => {
    await setVoice('on');
    await put(`${RT}/config`, { provider: 'openai-realtime', credentialRef: 'rt-missing' });
    const res = await post(`${RT}/session`, {});
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('credential_unavailable');
  });

  it('mints an OpenAI Realtime session (WebRTC) when configured + key present', async () => {
    await setVoice('on');
    await setSecret('rt-openai-key', 'sk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'openai-realtime', credentialRef: 'rt-openai-key' });
    const res = await post(`${RT}/session`, {});
    expect(res.status).toBe(200);
    const j = await res.json() as { realtime: { provider: string; token: string; connect: { kind: string } } };
    expect(j.realtime.provider).toBe('openai-realtime');
    expect(j.realtime.token).toBe('ek_test_openai');
    expect(j.realtime.connect.kind).toBe('webrtc');
  });

  it('mints a Gemini Live session (WebSocket) when selected', async () => {
    await setVoice('on');
    await setSecret('rt-gemini-key', 'gk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-gemini-key' });
    const j = await (await post(`${RT}/session`, {})).json() as { realtime: { provider: string; connect: { kind: string } } };
    expect(j.realtime.provider).toBe('gemini-live');
    expect(j.realtime.connect.kind).toBe('websocket');
  });

  it('400s an invalid provider on config PUT', async () => {
    await setVoice('on');
    const res = await put(`${RT}/config`, { provider: 'nope' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('validation_error');
  });

  it('404s the session when the voice toggle is OFF', async () => {
    await setVoice('off');
    expect((await post(`${RT}/session`, {})).status).toBe(404);
  });
});

describe('ADR 0141 RT-2 — tool bridge (allowlist + firewall gate)', () => {
  // RTV-2/RTV-3: obtain a host-issued session id; /tool-call uses the bound agent + that key.
  async function openGeminiSession(agentId?: string): Promise<string> {
    await setVoice('on');
    await setSecret('rt-rt2-key', 'gk', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-rt2-key' });
    const j = await (await post(`${RT}/session`, agentId ? { agentId } : {})).json() as { hostSessionId: string };
    return j.hostSessionId;
  }

  it('default-denies a tool that is not in the agent allowlist (no execution)', async () => {
    const hostSessionId = await openGeminiSession('no-such-agent');
    const res = await post(`${RT}/tool-call`, { sessionId: hostSessionId, callId: 'c1', name: 'openwop:core.openwop.http.fetch', arguments: {} });
    expect(res.status).toBe(200);
    const j = await res.json() as { callId: string; status: string };
    expect(j.callId).toBe('c1');
    expect(j.status).toBe('denied'); // not in allowlist → never reaches the executor
  });

  it('RTV-2/RTV-3: a forged/unknown session id is rejected (403) — no client-rotatable seen-set', async () => {
    await setVoice('on');
    const res = await post(`${RT}/tool-call`, { sessionId: 'rts_forged-not-issued', callId: 'c1', name: 'openwop:knowledge.search', arguments: {} });
    expect(res.status).toBe(403);
  });

  it('RTV-3: the client-body agentId is IGNORED — the bound agent governs the allowlist', async () => {
    const hostSessionId = await openGeminiSession('no-such-agent'); // session bound to an empty-allowlist agent
    // Even naming a different agent in the body, the host uses the session's bound agent → denied.
    const res = await post(`${RT}/tool-call`, { sessionId: hostSessionId, agentId: 'some-broad-agent', callId: 'c2', name: 'openwop:knowledge.search', arguments: {} });
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('denied');
  });

  it('400s a tool-call with no tool name (before the session check)', async () => {
    await setVoice('on');
    const res = await post(`${RT}/tool-call`, { sessionId: 's1', name: '' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('validation_error');
  });

  it('404s the tool bridge when the voice toggle is OFF', async () => {
    await setVoice('off');
    expect((await post(`${RT}/tool-call`, { name: 'openwop:knowledge.search' })).status).toBe(404);
  });
});

describe('ADR 0141 RT-5/RT-7 — Gemini constrained ephemeral token (the REAL AuthToken wire)', () => {
  it('locks model + system instruction + the agent tools in the token (browser cannot self-grant)', () => {
    // Decls arrive #578-sanitized from resolveAgentToolDecls (provider function names
    // reject `:`/`.`), and their schemas carry only Gemini's accepted OpenAPI subset.
    const body = buildGeminiConstraint('gemini-2.5-flash', 'Be brief.', [{ name: 'openwop_knowledge_search', description: 'search', parameters: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', minLength: 1 } } } }]) as {
      bidiGenerateContentSetup: { model: string; systemInstruction: { parts: Array<{ text: string }> }; tools: Array<{ functionDeclarations: Array<{ name: string; parameters: Record<string, unknown> }> }>; generationConfig: { responseModalities: string[] }; inputAudioTranscription: object; outputAudioTranscription: object };
      uses: number;
      fieldMask?: unknown;
    };
    expect(body.uses).toBe(1);
    // RT-7: the wire field is AuthToken.bidiGenerateContentSetup (NOT the SDK's
    // liveConnectConstraints, which 400s), and fieldMask stays ABSENT/empty so the
    // effective setup comes entirely from the token (client setup ignored).
    expect(body.fieldMask).toBeUndefined();
    expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-2.5-flash');
    expect(body.bidiGenerateContentSetup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0]?.text).toBe('Be brief.');
    // The tools are pinned in the token → a tampered client cannot add tools beyond these.
    const decl = body.bidiGenerateContentSetup.tools[0]?.functionDeclarations[0];
    expect(decl?.name).toBe('openwop_knowledge_search');
    // #578 schema projection: Gemini rejects the whole request on unknown schema keywords —
    // additionalProperties / minLength are dropped; the accepted subset survives.
    expect(decl?.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
    // The client's own setup message is ignored under the token lock, so the transcription
    // asks (RT-5a) MUST ride in the token setup or they are silently dropped.
    expect(body.bidiGenerateContentSetup.inputAudioTranscription).toEqual({});
    expect(body.bidiGenerateContentSetup.outputAudioTranscription).toEqual({});
  });

  it('omits the tools constraint when the agent has no tools (no empty declaration block)', () => {
    const body = buildGeminiConstraint('m', 'x', []) as { bidiGenerateContentSetup: Record<string, unknown> };
    expect('tools' in body.bidiGenerateContentSetup).toBe(false);
  });

  it('projects the BROWSER-facing session.tools onto Gemini\'s subset too (the client sends its own setup — 1007 on additionalProperties)', async () => {
    // The browser echoes session.tools verbatim into its `setup` message; Gemini VALIDATES
    // that payload and closes 1007 (`Unknown name "additionalProperties" at
    // 'setup.tools[0].function_declarations[N].parameters'`) on any non-OpenAPI keyword.
    const session = await geminiLiveProvider.createSession({
      apiKey: 'unused-under-voice-mock',
      instructions: 'Be brief.',
      tools: [{ name: 'openwop_knowledge_search', description: 'search', parameters: { type: 'object', additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#', properties: { q: { type: 'string', minLength: 1 } } } }],
    });
    expect(session.tools[0]?.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
  });
});

describe('ADR 0141 RT-7 follow-up — #578 wire-name round-trip (sanitize out, resolve back)', () => {
  const ALLOW = ['openwop:knowledge.search', 'openwop:core.openwop.http.fetch'];

  it('resolves a sanitized wire name back to the canonical allowlisted id', () => {
    expect(resolveWireToolName(ALLOW, 'openwop_knowledge_search')).toBe('openwop:knowledge.search');
    expect(resolveWireToolName(ALLOW, 'openwop_core_openwop_http_fetch')).toBe('openwop:core.openwop.http.fetch');
  });

  it('passes a canonical id through unchanged (exact match wins)', () => {
    expect(resolveWireToolName(ALLOW, 'openwop:knowledge.search')).toBe('openwop:knowledge.search');
  });

  it('returns undefined for a name not allowlisted under either spelling (default-deny)', () => {
    expect(resolveWireToolName(ALLOW, 'openwop_files_delete')).toBeUndefined();
    expect(resolveWireToolName([], 'anything')).toBeUndefined();
  });
});

describe('ADR 0141 RT-4 — OpenAI sideband (host-owned session: tools + transcript audit)', () => {
  const session: SidebandSession = { callId: 'rtc_host_owned', tenantId: 'default', agentId: 'no-such-agent', conversationId: 'conv-1' };

  it('runs a model tool call through the host policy stack — keyed on the HOST-owned call_id', async () => {
    // A function call the agent isn't allowed → default-deny, executed server-side (NOT relayed by
    // the client), and the firewall state is keyed on the host call_id, not a client value.
    const out = await handleSidebandEvent(session, {
      type: 'response.function_call_arguments.done', name: 'openwop:core.openwop.http.fetch', call_id: 'fc_1', arguments: '{}',
    });
    expect(out[0]?.type).toBe('conversation.item.create');
    expect(JSON.stringify(out[0])).toContain('denied');
    expect(out[1]?.type).toBe('response.create');
  });

  it('persists user + assistant transcripts to the conversation (the audit/chat record)', async () => {
    const persisted: Array<{ role: string; text: string }> = [];
    const deps = { persist: async (_s: SidebandSession, role: 'user' | 'assistant', text: string) => { persisted.push({ role, text }); } };
    await handleSidebandEvent(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'book a table' }, deps);
    await handleSidebandEvent(session, { type: 'response.audio_transcript.done', transcript: 'Booked.' }, deps);
    expect(persisted).toEqual([{ role: 'user', text: 'book a table' }, { role: 'assistant', text: 'Booked.' }]);
  });

  it('real persistence skips (no throw) when the conversation does not exist', async () => {
    // The default persistTranscript guards with getChatSession → a missing conversation must not
    // throw (which would surface as an unhandled rejection in the live sideband loop).
    const ghost: SidebandSession = { callId: 'rtc_ghost', tenantId: 'default', conversationId: 'does-not-exist' };
    await expect(handleSidebandEvent(ghost, { type: 'response.audio_transcript.done', transcript: 'hi' })).resolves.toEqual([]);
  });

  it('appends the turn AND publishes a live-delivery frame (an open chat shows it without reload)', async () => {
    // The OpenAI browser holds audio-only WebRTC and never sees a transcript, so the
    // per-conversation bus frame is the ONLY live signal. Assert the real persistTranscript
    // both writes the row (audit) and publishes the frame (live delivery).
    const storage = hostExtStorage();
    const conversationId = 'conv-live-push';
    const now = new Date().toISOString();
    await storage.createChatSession({ sessionId: conversationId, tenantId: 'default', title: 'Voice', createdAt: now, updatedAt: now, messageCount: 0 });
    const frames: string[] = [];
    const unsub = await subscribeConversationMessages(conversationId, (messageId) => frames.push(messageId));
    try {
      const live: SidebandSession = { callId: 'rtc_live', tenantId: 'default', conversationId };
      await handleSidebandEvent(live, { type: 'response.audio_transcript.done', transcript: 'Booked.' });
      // The publish is fire-and-forget over the host-ext pub/sub — let the microtasks drain.
      await new Promise((r) => setTimeout(r, 30));
      const msgs = await storage.listChatSessionMessages(conversationId);
      expect(msgs.map((m) => m.content)).toContain('Booked.');
      expect(JSON.parse(msgs[0]?.meta ?? '{}')).toMatchObject({ source: 'voice-realtime' });
      expect(frames).toHaveLength(1);
      expect(frames[0]).toBe(msgs[0]?.messageId);
    } finally {
      await unsub();
    }
  });

  it('mediates the SDP + returns a host-owned session id (no client-held session, no ephemeral token to the browser)', async () => {
    await setVoice('on');
    await setSecret('rt-sb-key', 'sk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'openai-realtime', credentialRef: 'rt-sb-key' });
    const res = await post(`${RT}/openai/connect`, { sdp: 'v=0\r\n(offer)\r\n', conversationId: 'conv-1' });
    expect(res.status).toBe(200);
    const j = await res.json() as { sessionId: string; sdp: string };
    expect(j.sessionId).toBe('rtc_test'); // host-minted (mocked); the browser never picks it
    expect(j.sdp).toContain('v=0');
  });

  it('400s /openai/connect when OpenAI is not the configured provider', async () => {
    await setVoice('on');
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-sb-key' });
    expect((await post(`${RT}/openai/connect`, { sdp: 'v=0' })).status).toBe(400);
  });

  it('transcript stream requires a conversationId (400) and IDOR-safe 404s an unknown conversation', async () => {
    await setVoice('on');
    // Missing param → 400 before any stream is opened.
    expect((await get(`${RT}/messages/stream`)).status).toBe(400);
    // Unknown session → 404 (existence gate; never opens a stream for an arbitrary id).
    expect((await get(`${RT}/messages/stream?conversationId=nope-not-real`)).status).toBe(404);
  });

  it('transcript stream DELIVERS a chat.message frame when the sideband persists a turn (GRADE — success path)', async () => {
    await setVoice('on');
    const conversationId = 'conv-sse-success';
    const nowIso = new Date().toISOString();
    await hostExtStorage().createChatSession({ sessionId: conversationId, tenantId: 'default', title: 'Voice SSE', createdAt: nowIso, updatedAt: nowIso, messageCount: 0 });

    // Open the stream and hold it; read frames incrementally with a hard timeout.
    const ac = new AbortController();
    const res = await fetch(`${BASE}${RT}/messages/stream?conversationId=${conversationId}`, { headers: H, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    const reader = res.body!.getReader();
    const readFrame = (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('event: chat.message')) return buf;
      }
    })();

    // Give the subscription a beat to attach, then drive a sideband transcript.
    await new Promise((r) => setTimeout(r, 100));
    const live: SidebandSession = { callId: 'rtc_sse', tenantId: 'default', conversationId };
    await handleSidebandEvent(live, { type: 'response.audio_transcript.done', transcript: 'Frame me.' });

    const frame = await Promise.race([
      readFrame,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    ac.abort(); // tear down the held connection either way
    expect(frame, 'expected a chat.message SSE frame within 4s').toContain('event: chat.message');
    const msgs = await hostExtStorage().listChatSessionMessages(conversationId);
    const persisted = msgs.find((m) => m.content === 'Frame me.');
    expect(persisted).toBeTruthy();
    expect(frame).toContain(persisted!.messageId); // the frame names the persisted row
  });
});

describe('ADR 0199 OQ-1 / Deferred Phase G — history seeding as conversation items (OpenAI)', () => {
  it('maps prior turns to message items with role-correct content types, skipping blanks', () => {
    const items = seedConversationItems([
      { role: 'user', text: 'book a table for two' },
      { role: 'assistant', text: 'Done — 7pm at Nopa.' },
      { role: 'user', text: '   ' }, // blank → skipped
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'book a table for two' }] },
    });
    expect(items[1]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done — 7pm at Nopa.' }] },
    });
  });

  it('never emits response.create — seeding history must not trigger a reply', () => {
    const items = seedConversationItems([{ role: 'user', text: 'hi' }]);
    expect(items.every((i) => i.type === 'conversation.item.create')).toBe(true);
  });

  it('empty history seeds nothing', () => {
    expect(seedConversationItems([])).toEqual([]);
  });
});

describe('ADR 0199 P1 — composed instructions (the RT-2 persona half, finally)', () => {
  it('a scoped agent session carries its authored persona + the spoken addendum, not the old placeholder', async () => {
    await setVoice('on');
    // A user-authored agent with a DISTINCTIVE prompt body.
    const create = await post('/v1/host/openwop-app/agents', {
      persona: 'Vox Context Probe',
      label: 'Vox',
      modelClass: 'chat',
      systemPrompt: 'PERSONA-MARKER-0199: You are Vox, the renewals specialist for this workspace.',
    });
    expect([200, 201, 409]).toContain(create.status); // 409 = re-run in same store
    const agentId = ((await create.json()) as { agentId: string }).agentId; // ADR 0379 P2 — use the minted id (now user.<slug>)

    await setSecret('rt-gemini-ctx', 'gk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-gemini-ctx' });
    const res = await post(`${RT}/session`, { agentId });
    expect(res.status).toBe(200);
    const j = await res.json() as { realtime: { instructions?: string } };
    const instructions = j.realtime.instructions ?? '';
    expect(instructions).toContain('PERSONA-MARKER-0199');
    expect(instructions).toContain('spoken, real-time voice conversation');
    expect(instructions).not.toContain('RT-2 wires the agent persona');
  });

  it('an unscoped session gets the generic scaffold + addendum (never a raw placeholder)', async () => {
    await setVoice('on');
    const res = await post(`${RT}/session`, {});
    expect(res.status).toBe(200);
    const j = await res.json() as { realtime: { instructions?: string } };
    const instructions = j.realtime.instructions ?? '';
    expect(instructions).toContain('helpful AI assistant in a shared chat');
    expect(instructions).toContain('spoken, real-time voice conversation');
    expect(instructions).not.toContain('RT-2 wires the agent persona');
  });
});

describe('ADR 0277 — agent identity normalization (rosterId ↔ agentId duality)', () => {
  it('a ROSTER-scoped session (the VoiceAgentPicker id form) composes the persona, not the generic scaffold', async () => {
    await setVoice('on');
    // The persona's registry projection (the chat-callable agent)…
    const create = await post('/v1/host/openwop-app/agents', {
      persona: 'Marbury Advisor Probe',
      label: 'Marbury',
      modelClass: 'chat',
      systemPrompt: 'PERSONA-MARKER-0277: You are Marbury, an advisor persona.',
    });
    expect([200, 201, 409]).toContain(create.status);
    // …wrapped by a standing ROSTER entry — the id the voice picker actually sends.
    const entry = await createRosterEntry({
      tenantId: 'default', persona: 'Marbury Advisor Probe',
      agentRef: { agentId: 'user.marbury-advisor-probe' },
    });
    expect(entry.rosterId.startsWith('host:')).toBe(true);

    await setSecret('rt-gemini-0277', 'gk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-gemini-0277' });
    const res = await post(`${RT}/session`, { agentId: entry.rosterId });
    expect(res.status).toBe(200);
    const j = await res.json() as { realtime: { instructions?: string } };
    // Pre-0277 this composed the generic scaffold (registry miss on the host:* id),
    // silently dropping the persona AND the caller's identity anchor.
    expect(j.realtime.instructions ?? '').toContain('PERSONA-MARKER-0277');
  });

  it('tool declarations resolve for BOTH id forms (rosterId previously → empty allowlist → zero tools)', async () => {
    // Register a manifest agent with a real allowlisted builtin directly (packs
    // are not mounted in this harness).
    getAgentRegistry().register({
      agentId: 'probe.0277.tooled-agent', persona: 'Tooled Probe', modelClass: 'chat',
      systemPrompt: 'tooled probe', toolAllowlist: ['openwop:knowledge.search'],
      packName: 'test.probe-0277', packVersion: '0.0.1',
    });
    const viaAgentId = await resolveAgentToolDecls('default', 'probe.0277.tooled-agent');
    expect(viaAgentId.length).toBeGreaterThan(0);

    const entry = await createRosterEntry({
      tenantId: 'default', persona: 'Tooled Probe Member',
      agentRef: { agentId: 'probe.0277.tooled-agent' },
    });
    __clearAgentIdentityCache(); // the reverse index is TTL-cached; drop it after mutating the roster
    const viaRosterId = await resolveAgentToolDecls('default', entry.rosterId);
    // The picker's rosterId must yield the SAME tool surface as the registry id.
    expect(viaRosterId).toEqual(viaAgentId);
  });

  it('honors the ADR 0104 super-admin override on voice — a revoked default-on tool is not declared (grade-code TOOLS-1)', async () => {
    // The default-on baseline (ADR 0315) offers `ai.research.web` to every agent,
    // over voice too. The documented REVOKE path is a full-replace override; before
    // the fix voice ignored the override, so a revoked tool stayed declarable +
    // executable over voice. Register a tool-less agent → baseline is its whole surface.
    getAgentRegistry().register({
      agentId: 'probe.override.voice', persona: 'Override Voice Probe', modelClass: 'chat',
      systemPrompt: 'x', toolAllowlist: [], packName: 'test.override', packVersion: '0.0.1',
    });
    __clearAgentIdentityCache();
    const research = sanitizeToolName('openwop:ai.research.web');
    const before = (await resolveAgentToolDecls('default', 'probe.override.voice')).map((d) => d.name);
    expect(before).toContain(research); // baseline tool offered over voice

    // Full-replace override that OMITS the baseline (the operator revoke).
    await upsertAgentToolAllowlistOverride('default', 'probe.override.voice', { toolAllowlist: ['openwop:knowledge.search'], updatedBy: 'admin' });
    __clearAgentIdentityCache();
    const after = (await resolveAgentToolDecls('default', 'probe.override.voice')).map((d) => d.name);
    expect(after).not.toContain(research); // revoked → no longer declared to the realtime model
    expect(after).toContain(sanitizeToolName('openwop:knowledge.search')); // the override's surface stands
    await clearAgentToolAllowlistOverride('default', 'probe.override.voice');
  });

  it('per-agent voice resolves from the registry id form too (profile is rosterId-keyed)', async () => {
    const entry = await createRosterEntry({
      tenantId: 'default', persona: 'Voiced Probe Member',
      agentRef: { agentId: 'probe.0277.voiced-agent' },
    });
    __clearAgentIdentityCache(); // the reverse index is TTL-cached; drop it after mutating the roster
    await upsertAgentProfile('default', entry.rosterId, {
      roleKey: 'worker',
      configParameters: { voice: { provider: 'elevenlabs', voiceId: 'atlas' } },
      autonomy: { specLevel: 'draft-only' },
    });
    // rosterId form (the picker) — direct profile hit, as before.
    expect(await resolveAgentVoice('default', entry.rosterId)).toEqual({ provider: 'elevenlabs', voiceId: 'atlas' });
    // registry-id form (an agent-scoped tab) — previously missed the profile →
    // the agent's configured voice silently fell back to the host default.
    expect(await resolveAgentVoice('default', 'probe.0277.voiced-agent')).toEqual({ provider: 'elevenlabs', voiceId: 'atlas' });
  });

  it('mint responses carry the degraded-context signal (block names only), omitted when whole (ADR 0277 OQ-1)', async () => {
    await setVoice('on');
    await setSecret('rt-gemini-deg', 'gk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-gemini-deg' });
    // An unknown agent → the persona block fails to compose → 'persona' surfaces.
    const degradedRes = await post(`${RT}/session`, { agentId: 'no-such-agent-oq1' });
    expect(degradedRes.status).toBe(200);
    const degraded = (await degradedRes.json() as { degraded?: string[] }).degraded ?? [];
    expect(degraded).toContain('persona');
    // Names only — never reasons/content, and NEVER the 'conversation' block
    // (log-only per the security ruling: it would be an existence oracle).
    expect(degraded.every((b) => /^[a-z_]+$/.test(b))).toBe(true);
    expect(degraded).not.toContain('conversation');
    // A whole session (resolvable persona) omits the field entirely.
    const wholeRes = await post(`${RT}/session`, { agentId: 'user.vox-context-probe' });
    expect(wholeRes.status).toBe(200);
    expect((await wholeRes.json() as { degraded?: string[] }).degraded).toBeUndefined();
  });

  it('the no-persona scaffold keeps the caller identity anchor (previously discarded even when resolved)', async () => {
    const user = await createUser({ tenantId: 'default', principalId: 'principal-0277-dana', displayName: 'Dana Scaffold' });
    const ctx = await composeChatContext('default', { callerUserId: user.userId });
    expect(ctx.systemPrompt).toContain('helpful AI assistant in a shared chat');
    expect(ctx.systemPrompt).toContain('Dana Scaffold');
    // And with no caller at all, the bare scaffold composes exactly the legacy
    // string + the per-turn temporal-grounding date line (this session) + the
    // ADR 0308 tool-grounded-commitments contract (which rides EVERY composed
    // scaffold) — no OTHER drift. The date is non-deterministic, so normalize
    // it to a placeholder, then assert exact equality to catch any real drift.
    const bare = await composeChatContext('default', {});
    expect(bare.systemPrompt).toMatch(/\nToday's date is \w+, \d{4}-\d{2}-\d{2} \(UTC\)\.\n/);
    const normalized = bare.systemPrompt.replace(/Today's date is \w+, \d{4}-\d{2}-\d{2} \(UTC\)\./, "Today's date is <D>.");
    expect(normalized).toBe(`You are a helpful AI assistant in a shared chat. Reply concisely.\n\nToday's date is <D>.\n\n${TOOL_GROUNDED_COMMITMENTS}`);
  });
});

describe('ADR 0199 P1 — conversation-context visibility gate (review finding)', () => {
  it("another user's owned conversation contributes NO context to the session instructions", async () => {
    await setVoice('on');
    // A conversation OWNED by someone else, carrying a distinctive board block.
    const convId = 'conv-owned-by-other';
    await ensureConversationMeta('default', convId, { type: 'group', ownerUserId: 'user:someone-else' });
    await markAsBoardGroup('default', convId, 'board-x', [], 'user:someone-else', undefined, 'SECRET-BOARD-BLOCK-0199');
    // ADVB-1 — a resolver that WOULD serve the block: the visibility gate must
    // stop the compose BEFORE the resolve, not rely on there being nothing to
    // resolve. Without this the assertion below could pass vacuously.
    registerBoardContextResolver(async () => 'SECRET-BOARD-BLOCK-0199');
    await setSecret('rt-gemini-vis', 'gk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-gemini-vis' });
    const res = await post(`${RT}/session`, { conversationId: convId });
    expect(res.status).toBe(200);
    const j = await res.json() as { realtime: { instructions?: string } };
    // Fail-closed: the invisible conversation composes as if unscoped —
    // its injected board block never reaches the model's instructions.
    expect(j.realtime.instructions ?? '').not.toContain('SECRET-BOARD-BLOCK-0199');
    __resetBoardSeams({ context: true });
  });

  it('an ownerless (legacy) conversation stays tenant-visible — its block composes', async () => {
    await setVoice('on');
    const convId = 'conv-legacy-open';
    await ensureConversationMeta('default', convId, { type: 'group' });
    // CORRECTED by ADVB-1 (2026-08-19): this used to seed the block as a
    // PERSISTED `injectedContextBlock` and assert that the snapshot reaches the
    // model. Voice composes through the same `composeChatContext` as text, and
    // that snapshot is written by ONE curator and read by everyone — so serving
    // it back leaked. The block is now re-resolved per CALLER through the board
    // seam. The property this test exists for is unchanged: an OWNERLESS
    // conversation stays tenant-visible, so its board context DOES compose.
    await markAsBoardGroup('default', convId, 'board-y', [], undefined, undefined, undefined);
    registerBoardContextResolver(async (_t, boardId) => (boardId === 'board-y' ? 'OPEN-BOARD-BLOCK-0199' : null));
    try {
      // The injected block reaches the scaffold through the AGENT compose branch
      // (board chats always address an agent) — scope to the Vox agent.
      const res = await post(`${RT}/session`, { conversationId: convId, agentId: 'user.default.vox-context-probe' });
      expect(res.status).toBe(200);
      const j = await res.json() as { realtime: { instructions?: string } };
      expect(j.realtime.instructions ?? '').toContain('OPEN-BOARD-BLOCK-0199');
    } finally {
      __resetBoardSeams({ context: true });
    }
  });
});

describe('ADR 0199 P2 — voice preamble (work snapshot)', () => {
  it("a roster member's workflow portfolio reaches the session instructions", async () => {
    await setVoice('on');
    const entry = await createRosterEntry({
      tenantId: 'default',
      persona: 'Snapshot Probe',
      agentRef: { agentId: 'user.vox-context-probe' },
      workflows: ['wf-renewals-digest'],
    });
    await setSecret('rt-gemini-p2', 'gk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-gemini-p2' });
    // Scope by the ROSTER id (a standing agent) — the snapshot matches either id form.
    const res = await post(`${RT}/session`, { agentId: entry.rosterId });
    expect(res.status).toBe(200);
    const j = await res.json() as { realtime: { instructions?: string } };
    const instructions = j.realtime.instructions ?? '';
    expect(instructions).toContain('Your workflow portfolio');
    expect(instructions).toContain('wf-renewals-digest');
  });
});

describe('ADR 0304 D1 — spoken delegation (session-control tools, OpenAI sideband)', () => {
  const HOME = { agentId: 'host:iris', instructions: 'You are Iris.', tools: [{ type: 'function', name: 'existing_tool' }], voice: 'iris-voice' };
  const REX = { agentId: 'host:rex', instructions: 'You are Rex.', tools: [{ type: 'function', name: 'rex_tool' }], voice: 'rex-voice' };
  const delegable = [{ agentId: 'host:rex', persona: 'Rex' }];
  const noPersist = { persist: async () => { /* not under test */ } };
  const deps = { ...noPersist, delegation: { delegable, composeFor: async (id: string) => (id === 'host:rex' ? REX : null) } };

  function freshSession(callId: string): SidebandSession {
    armDelegation(callId, HOME);
    return { callId, tenantId: 'default', agentId: 'host:iris', boundAgentId: 'host:iris' };
  }

  it('delegates: session.update to the TARGET (voice + instructions + ITS tools), floor rebinds, one-shot armed', async () => {
    const s = freshSession('rtc_delegate_1');
    try {
      const out = await handleSidebandEvent(s, {
        type: 'response.function_call_arguments.done', name: DELEGATE_TOOL, call_id: 'fc_d1',
        arguments: JSON.stringify({ agentId: 'host:rex', question: 'What is the pipeline status?' }),
      }, deps);
      expect(out.map((o) => o.type)).toEqual(['session.update', 'conversation.item.create', 'response.create']);
      const su = out[0] as { session: { instructions: string; tools: unknown[]; audio?: { output?: { voice?: string } } } };
      expect(su.session.instructions).toBe('You are Rex.');
      expect(su.session.audio?.output?.voice).toBe('rex-voice');
      expect(JSON.stringify(su.session.tools)).toContain('rex_tool');
      expect(JSON.stringify(su.session.tools)).not.toContain('existing_tool'); // no privilege union
      expect(JSON.stringify(out[1])).toContain('What is the pipeline status?');
      expect(s.boundAgentId).toBe('host:rex'); // tool calls + attribution now bind to Rex
      expect(delegationStateOf('rtc_delegate_1')?.delegate).toMatchObject({ agentId: 'host:rex', phase: 'requested' });
    } finally { clearDelegation('rtc_delegate_1'); }
  });

  it('one-shot return: the delegated answer’s response.done restores the HOME speaker silently', async () => {
    const s = freshSession('rtc_delegate_2');
    try {
      await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: DELEGATE_TOOL, call_id: 'fc_d2', arguments: JSON.stringify({ agentId: 'host:rex', question: 'Q?' }) }, deps);
      // The answer's lifecycle: created (arms) → done (returns).
      expect(await handleSidebandEvent(s, { type: 'response.created' }, deps)).toEqual([]);
      expect(delegationStateOf('rtc_delegate_2')?.delegate?.phase).toBe('answering');
      const out = await handleSidebandEvent(s, { type: 'response.done' }, deps);
      expect(out.map((o) => o.type)).toEqual(['session.update']); // silent — no response.create
      expect((out[0] as { session: { instructions: string } }).session.instructions).toBe('You are Iris.');
      expect(s.boundAgentId).toBe('host:iris');
      expect(delegationStateOf('rtc_delegate_2')?.delegate).toBeUndefined();
    } finally { clearDelegation('rtc_delegate_2'); }
  });

  it('a plain response.done with NO delegation live changes nothing (normal turns unaffected)', async () => {
    const s = freshSession('rtc_delegate_3');
    try {
      expect(await handleSidebandEvent(s, { type: 'response.done' }, deps)).toEqual([]);
      expect(s.boundAgentId).toBe('host:iris');
    } finally { clearDelegation('rtc_delegate_3'); }
  });

  it('voice__return_to_agent hands back early (session.update home + acknowledgment turn)', async () => {
    const s = freshSession('rtc_delegate_4');
    try {
      await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: DELEGATE_TOOL, call_id: 'fc_d4', arguments: JSON.stringify({ agentId: 'host:rex', question: 'Q?' }) }, deps);
      const out = await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: RETURN_TOOL, call_id: 'fc_r4', arguments: '{}' }, deps);
      expect(out.map((o) => o.type)).toEqual(['session.update', 'conversation.item.create', 'response.create']);
      expect((out[0] as { session: { instructions: string } }).session.instructions).toBe('You are Iris.');
      expect(s.boundAgentId).toBe('host:iris');
      expect(delegationStateOf('rtc_delegate_4')?.delegate).toBeUndefined();
    } finally { clearDelegation('rtc_delegate_4'); }
  });

  it('rejects an unknown target + nested delegation with structured tool errors (no session.update)', async () => {
    const s = freshSession('rtc_delegate_5');
    try {
      const unknown = await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: DELEGATE_TOOL, call_id: 'fc_u5', arguments: JSON.stringify({ agentId: 'host:nobody', question: 'Q?' }) }, deps);
      expect(unknown.map((o) => o.type)).toEqual(['conversation.item.create', 'response.create']);
      expect(JSON.stringify(unknown[0])).toContain('[unavailable]');
      await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: DELEGATE_TOOL, call_id: 'fc_d5', arguments: JSON.stringify({ agentId: 'host:rex', question: 'Q?' }) }, deps);
      const nested = await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: DELEGATE_TOOL, call_id: 'fc_n5', arguments: JSON.stringify({ agentId: 'host:rex', question: 'Q2?' }) }, deps);
      expect(JSON.stringify(nested[0])).toContain('already in progress');
    } finally { clearDelegation('rtc_delegate_5'); }
  });

  it('delegation is unavailable when the mint never armed it (Gemini / unscoped sessions)', async () => {
    const s: SidebandSession = { callId: 'rtc_unarmed', tenantId: 'default', agentId: 'host:iris' };
    const out = await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: DELEGATE_TOOL, call_id: 'fc_x', arguments: JSON.stringify({ agentId: 'host:rex', question: 'Q?' }) }, noPersist);
    expect(JSON.stringify(out[0])).toContain('[unavailable]');
  });

  it('a mid-answer ordinary tool call re-arms the lifecycle so ITS response.done does not end the delegation', async () => {
    const s = freshSession('rtc_delegate_6');
    try {
      await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: DELEGATE_TOOL, call_id: 'fc_d6', arguments: JSON.stringify({ agentId: 'host:rex', question: 'Q?' }) }, deps);
      await handleSidebandEvent(s, { type: 'response.created' }, deps); // answering
      // Rex calls one of its tools mid-answer (denied here — no such agent — but the
      // lifecycle effect is what's under test).
      await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: 'rex_tool', call_id: 'fc_t6', arguments: '{}' }, deps);
      expect(delegationStateOf('rtc_delegate_6')?.delegate?.phase).toBe('requested');
      expect(await handleSidebandEvent(s, { type: 'response.done' }, deps)).toEqual([]); // the TOOL response's done — still delegated
      await handleSidebandEvent(s, { type: 'response.created' }, deps);
      const out = await handleSidebandEvent(s, { type: 'response.done' }, deps); // the real answer's done
      expect(out.map((o) => o.type)).toEqual(['session.update']);
    } finally { clearDelegation('rtc_delegate_6'); }
  });

  it('ADR 0304 D4 — the delegated assistant turn persists attributed to the SPEAKER (row meta agentId)', async () => {
    const storage = hostExtStorage();
    const conversationId = 'conv-delegated-attr';
    const now = new Date().toISOString();
    await storage.createChatSession({ sessionId: conversationId, tenantId: 'default', title: 'Voice', createdAt: now, updatedAt: now, messageCount: 0 });
    const s: SidebandSession = { callId: 'rtc_attr', tenantId: 'default', agentId: 'host:iris', conversationId, boundAgentId: 'host:rex', boundPersona: 'Rex' };
    await handleSidebandEvent(s, { type: 'response.audio_transcript.done', transcript: 'Pipeline looks strong.' });
    const msgs = await storage.listChatSessionMessages(conversationId);
    expect(JSON.parse(msgs[0]?.meta ?? '{}')).toMatchObject({ source: 'voice-realtime', agentId: 'host:rex', agentPersona: 'Rex' });
  });
});

describe('ADR 0304 VOX-G2 — Gemini NEVER gets the delegation session-control tools (honest gap)', () => {
  it('a gemini-live mint with delegable peers declares no voice__delegate/return tool', async () => {
    await setVoice('on');
    // The exact precondition under which the OpenAI path WOULD declare the tool:
    // an agent-scoped session + at least one OTHER enabled roster agent.
    const home = await createRosterEntry({ tenantId: 'default', persona: 'G2 Home', agentRef: { agentId: 'user.default.g2-home' } });
    await createRosterEntry({ tenantId: 'default', persona: 'G2 Peer', agentRef: { agentId: 'user.default.g2-peer' } });
    await setSecret('rt-gemini-g2', 'gk-test', { tenantId: 'default' });
    await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-gemini-g2' });
    const res = await post(`${RT}/session`, { agentId: home.rosterId });
    expect(res.status).toBe(200);
    const j = await res.json() as { realtime: { tools: Array<{ name: string }> } };
    const names = j.realtime.tools.map((t) => t.name);
    // Token-locked setup can't re-instruct/re-voice mid-session (RT-7) — declaring
    // delegation there would be a dishonest capability claim (ADR 0304 D1).
    expect(names).not.toContain(DELEGATE_TOOL);
    expect(names).not.toContain(RETURN_TOOL);
  });
});
