/**
 * Live voice mode — route-level tests (ADR 0138 P1, finding #5).
 *
 * Boots the real app via createApp and drives the host-extension product surface
 * (`/v1/host/openwop-app/voice/session/*`) at the HTTP boundary — where authz,
 * the `voice` toggle gate, tenant binding, and the §F budget are observable.
 * Proves the live `streamRef` flips ADR 0109's `transcription_unsupported` into a
 * real `voice.*` turn: open → append utterance chunks → commit → CORE
 * `callTranscriber({audio:{streamRef}})` reads the buffer through the
 * `StreamAudioResolver` seam and emits the canonical taxonomy.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { voiceFeature } from '../src/features/voice/feature.js';
import { OpenwopError } from '../src/types.js';
import { appendStreamChunk, openStreamBuffer, __resetVoiceBuffers } from '../src/features/voice/voiceBuffers.js';
import { resolveAgentVoice } from '../src/features/voice/voiceSession.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const post = (path: string, body?: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const del = (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE', headers: H });
const SESS = '/v1/host/openwop-app/voice/session';
const b64 = (n: number, fill = 0x61) => Buffer.alloc(n, fill).toString('base64');

async function setVoice(status: 'on' | 'off'): Promise<void> {
  await saveConfig({ ...voiceFeature.toggleDefault!, status }, 'test');
}

type VoiceEvent = { type: string; payload: Record<string, unknown> };
type CommitOk = { finalText: string; atMs: number; events: VoiceEvent[]; nextStreamRef: string; turns: number };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // deterministic transcription (no provider key)
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await __clearToggleStore();
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0138 P1 — live voice mode routes', () => {
  it('404s the bootstrap when the `voice` toggle is OFF (backend authority)', async () => {
    await setVoice('off');
    const res = await post(SESS, {});
    expect(res.status).toBe(404);
    // The canonical envelope carries the code in `error` (a flat code string).
    expect((await res.json() as { error?: string }).error).toBe('not_found');
  });

  it('opens a session + returns the transport descriptor when the toggle is ON', async () => {
    await setVoice('on');
    const res = await post(SESS, { mimeType: 'audio/webm' });
    expect(res.status).toBe(201);
    const j = await res.json() as { session: { sessionId: string; streamRef: string; status: string; turns: number }; transport: { kind: string; appendPath: string; commitPath: string } };
    expect(j.session.status).toBe('open');
    expect(j.session.streamRef).toMatch(/^vstream_/);
    expect(j.transport.kind).toBe('http-chunked');
    expect(j.transport.commitPath).toBe(`${SESS}/${j.session.sessionId}/commit`);
  });

  it('append → commit flips the live streamRef into a real voice.* turn (untrusted, committed at turn_commit)', async () => {
    await setVoice('on');
    const open = await (await post(SESS, {})).json() as { session: { sessionId: string } };
    const id = open.session.sessionId;

    const ap = await post(`${SESS}/${id}/audio`, { audioChunk: b64(2048) });
    expect(ap.status).toBe(202);
    expect((await ap.json() as { bytes: number }).bytes).toBe(2048);

    const cm = await post(`${SESS}/${id}/commit`, {});
    expect(cm.status).toBe(200);
    const j = await cm.json() as CommitOk;
    // The buffered audio actually flowed through the resolver → managed-transcribe seam.
    expect(j.finalText).toBe('live transcript (2048 bytes)');
    expect(j.turns).toBe(1);
    expect(j.nextStreamRef).toMatch(/^vstream_/);
    // Canonical voice.* taxonomy on the durable log (C1).
    const types = j.events.map((e) => e.type);
    expect(types).toContain('voice.speech_start');
    expect(types).toContain('voice.transcript');
    expect(types).toContain('voice.turn_commit');
    // §F voice-transcript-untrusted: every transcript emission is marked untrusted.
    for (const e of j.events.filter((e) => e.type === 'voice.transcript')) {
      expect(e.payload.contentTrust).toBe('untrusted');
    }
  });

  it('400s a commit on an empty utterance (the resolver returns null — no over-claim)', async () => {
    await setVoice('on');
    const open = await (await post(SESS, {})).json() as { session: { sessionId: string } };
    const cm = await post(`${SESS}/${open.session.sessionId}/commit`, {});
    expect(cm.status).toBe(400);
    expect((await cm.json() as { error?: { code?: string } }).error?.code).toBe('invalid_request');
  });

  it('404s append/commit on an unknown session (§F — collapses cross-tenant, no existence oracle)', async () => {
    await setVoice('on');
    expect((await post(`${SESS}/does-not-exist/audio`, { audioChunk: b64(8) })).status).toBe(404);
    expect((await post(`${SESS}/does-not-exist/commit`, {})).status).toBe(404);
  });

  it('fails closed past the per-utterance audio budget (§F TDoS) — unit, below the body-parser limit', () => {
    // Tested directly: a single 8MiB+ HTTP body is stopped earlier by the body
    // parser; the per-utterance CUMULATIVE budget is the buffer's own guard.
    __resetVoiceBuffers();
    const ref = openStreamBuffer('t1', 's1', 'audio/webm');
    expect(appendStreamChunk(ref, 't1', b64(4 * 1024 * 1024))).toBe(4 * 1024 * 1024);
    let code = '';
    try { appendStreamChunk(ref, 't1', b64(4 * 1024 * 1024 + 1)); } catch (e) { code = (e as OpenwopError).code; }
    expect(code).toBe('rate_limited');
    // §F voice-streamref-tenant-bound: another tenant cannot append to this handle.
    let crossCode = '';
    try { appendStreamChunk(ref, 't2', b64(8)); } catch (e) { crossCode = (e as OpenwopError).code; }
    expect(crossCode).toBe('not_found');
  });

  it('ends the session (204) and a later commit 404s', async () => {
    await setVoice('on');
    const open = await (await post(SESS, {})).json() as { session: { sessionId: string } };
    const id = open.session.sessionId;
    expect((await del(`${SESS}/${id}`)).status).toBe(204);
    expect((await post(`${SESS}/${id}/commit`, {})).status).toBe(404);
  });
});

describe('ADR 0138 P2 — full-duplex: speak (TTS-out) + barge-in (§F)', () => {
  async function openSession(): Promise<string> {
    await setVoice('on');
    const j = await (await post(SESS, {})).json() as { session: { sessionId: string } };
    return j.session.sessionId;
  }

  it('speaks the chat reply: streaming synthesis → audio asset + voice.synthesis_chunk', async () => {
    const id = await openSession();
    const res = await post(`${SESS}/${id}/speak`, { text: 'Your table for two is booked.' });
    expect(res.status).toBe(200);
    const j = await res.json() as { turnId: string; audio: { url: string; mimeType: string; voiceId: string }; events: VoiceEvent[] };
    expect(j.audio.url).toMatch(/\/assets\//);
    expect(j.audio.voiceId).toBe('default');
    expect(j.events.map((e) => e.type)).toContain('voice.synthesis_chunk');
  });

  it('400s a speak with no reply text', async () => {
    const id = await openSession();
    const res = await post(`${SESS}/${id}/speak`, { text: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('validation_error');
  });

  it('barge-in emits voice.barge_in → voice.cancelled with NO synthesis_chunk after the cancel (§F no-partial-leak)', async () => {
    const id = await openSession();
    await post(`${SESS}/${id}/speak`, { text: 'A long-winded answer the user cuts off…' });
    const res = await post(`${SESS}/${id}/barge-in`, { atMs: 500 });
    expect(res.status).toBe(200);
    const j = await res.json() as { events: VoiceEvent[]; cancelledTurn: string | null };
    const types = j.events.map((e) => e.type);
    expect(types).toEqual(['voice.barge_in', 'voice.cancelled']);
    // No audio crosses the wire after the cancel.
    expect(types).not.toContain('voice.synthesis_chunk');
    expect(j.events.find((e) => e.type === 'voice.cancelled')?.payload.reason).toBe('barge_in');
    expect(j.cancelledTurn).toBeTruthy();
  });

  it('uses the per-agent voice (agentProfile.configParameters.voice.voiceId) for the spoken reply', async () => {
    await setVoice('on');
    // The voice lives in the existing agent-config seam (ADR 0031), set in agent settings.
    await upsertAgentProfile('default', 'voice-agent-1', {
      roleKey: 'worker',
      configParameters: { voice: { provider: 'elevenlabs', voiceId: 'rachel', credentialRef: 'my-11labs-key' } },
      autonomy: { specLevel: 'draft-only' },
    });
    // Direct resolver unit — the BYOK credentialRef (W1) is carried through.
    expect(await resolveAgentVoice('default', 'voice-agent-1')).toEqual({ provider: 'elevenlabs', voiceId: 'rachel', credentialRef: 'my-11labs-key' });
    expect(await resolveAgentVoice('default', undefined)).toBeNull();

    // End-to-end: a session bound to that agent speaks in that agent's voice.
    const open = await (await post(SESS, { agentId: 'voice-agent-1' })).json() as { session: { sessionId: string } };
    const res = await post(`${SESS}/${open.session.sessionId}/speak`, { text: 'Booked.' });
    expect(res.status).toBe(200);
    expect((await res.json() as { audio: { voiceId: string } }).audio.voiceId).toBe('rachel');
  });

  it('W6: the agent voice is authoritative — a client cannot override a scoped agent’s voiceId', async () => {
    await setVoice('on');
    await upsertAgentProfile('default', 'voice-agent-auth', {
      roleKey: 'worker',
      configParameters: { voice: { voiceId: 'rachel' } }, // managed default provider
      autonomy: { specLevel: 'draft-only' },
    });
    const open = await (await post(SESS, { agentId: 'voice-agent-auth' })).json() as { session: { sessionId: string } };
    // Client tries to override with a different voice — must be ignored.
    const res = await post(`${SESS}/${open.session.sessionId}/speak`, { text: 'Hi.', voiceId: 'client-voice' });
    expect(res.status).toBe(200);
    expect((await res.json() as { audio: { voiceId: string } }).audio.voiceId).toBe('rachel');
  });

  it('W1: a non-managed voice (ElevenLabs) with NO credentialRef fails with an honest, actionable error', async () => {
    await setVoice('on');
    await upsertAgentProfile('default', 'voice-agent-nokey', {
      roleKey: 'worker',
      configParameters: { voice: { provider: 'elevenlabs', voiceId: 'rachel' } }, // no credentialRef
      autonomy: { specLevel: 'draft-only' },
    });
    const open = await (await post(SESS, { agentId: 'voice-agent-nokey' })).json() as { session: { sessionId: string } };
    // Drop the test seam for this case so /speak reaches the real provider-credential check
    // (it throws BEFORE any network — no managed key + no credentialRef).
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    try {
      const res = await post(`${SESS}/${open.session.sessionId}/speak`, { text: 'Booked.' });
      expect(res.status).toBe(400);
      expect((await res.json() as { error?: { code?: string } }).error?.code).toBe('speech_synthesis_unsupported');
    } finally {
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    }
  });

  it('barge-in with no reply in flight is a clean no-op (still emits the lifecycle, cancels nothing)', async () => {
    const id = await openSession();
    // No /speak → no active reply turn.
    const res = await post(`${SESS}/${id}/barge-in`, {});
    expect(res.status).toBe(200);
    const j = await res.json() as { events: VoiceEvent[]; cancelledTurn: string | null };
    expect(j.events.map((e) => e.type)).toEqual(['voice.barge_in', 'voice.cancelled']);
    expect(j.cancelledTurn).toBeNull(); // nothing was in flight
  });
});
