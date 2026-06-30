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
import { buildGeminiConstraint } from '../src/features/voice/realtime/geminiLive.js';
import { handleSidebandEvent, type SidebandSession } from '../src/features/voice/realtime/openaiSideband.js';

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
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
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

describe('ADR 0141 RT-5 — Gemini constrained ephemeral token (lock config server-side)', () => {
  it('locks model + system instruction + the agent tools in the token (browser cannot self-grant)', () => {
    const body = buildGeminiConstraint('gemini-2.5-flash', 'Be brief.', [{ name: 'openwop:knowledge.search', description: 'search', parameters: { type: 'object' } }]) as {
      liveConnectConstraints: { model: string; config: { systemInstruction: { parts: Array<{ text: string }> }; tools: Array<{ functionDeclarations: Array<{ name: string }> }>; responseModalities: string[] } };
      uses: number;
    };
    expect(body.uses).toBe(1);
    expect(body.liveConnectConstraints.model).toBe('models/gemini-2.5-flash');
    expect(body.liveConnectConstraints.config.responseModalities).toEqual(['AUDIO']);
    expect(body.liveConnectConstraints.config.systemInstruction.parts[0]?.text).toBe('Be brief.');
    // The tools are pinned in the token → a tampered client cannot add tools beyond these.
    expect(body.liveConnectConstraints.config.tools[0]?.functionDeclarations[0]?.name).toBe('openwop:knowledge.search');
  });

  it('omits the tools constraint when the agent has no tools (no empty declaration block)', () => {
    const body = buildGeminiConstraint('m', 'x', []) as { liveConnectConstraints: { config: Record<string, unknown> } };
    expect('tools' in body.liveConnectConstraints.config).toBe(false);
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
});
