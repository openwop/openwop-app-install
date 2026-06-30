/**
 * Live voice mode routes (ADR 0138 P1) — host-extension, toggle-gated, tenant-scoped.
 *
 * The product transport for the live mic (host-internal per RFC 0106 §E). P1 floor =
 * HTTP chunked: open a session → append utterance chunks → commit (endpoint) →
 * the CORE `callTranscriber({audio:{streamRef}})` reads the buffered utterance through
 * the `StreamAudioResolver` seam and emits the canonical `voice.*` turn. A WebSocket /
 * WebRTC transport (deferred open question) plugs in behind the same session + streamRef.
 *
 * Namespace note (ADR 0138 finding #4): core `routes/agents.ts` owns the RFC 0106 wire
 * SEAMS (`/ai/call-transcriber`, `/voice/barge-in`); THIS feature owns the product
 * bootstrap `/voice/session/*`. Disjoint sub-paths — no collision.
 *
 * @see docs/adr/0138-live-voice-mode.md
 */
import { randomUUID } from 'node:crypto';
import { AiProviderError, createAiProvidersAdapter } from '../../aiProviders/aiProvidersHost.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { tenantOf, requireFeatureEnabled, optionalString } from '../featureRoute.js';
import { appendStreamChunk, closeSessionBuffers, closeStreamBuffer, openStreamBuffer, wireStreamAudioResolver } from './voiceBuffers.js';
import { advanceVoiceSession, closeVoiceSession, createVoiceSession, getOpenVoiceSession, resolveAgentVoice } from './voiceSession.js';
import { beginSpeak, cancelSpeak, dropSpeak, endSpeak, isSpeakCancelled } from './voiceTurns.js';

const BASE = '/v1/host/openwop-app/voice/session';
/** Host default voice when an agent has no `agentProfile.configParameters.voice.voiceId` (P3). */
const DEFAULT_VOICE_ID = 'default';

export function registerVoiceRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // Wire the host-internal live-audio transport into CORE `callTranscriber` (the
  // dependency-inversion seam — core never imports this feature; ADR 0138 finding #1).
  wireStreamAudioResolver();

  // Open a voice session: mint a session + the first live-utterance handle. The
  // `voice` toggle gates the product surface (a host CAPABILITY, distinct from the
  // always-on `realtimeVoice` advertisement — ADR 0138 finding #3).
  app.post(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as { conversationId?: unknown; agentId?: unknown; mimeType?: unknown };
      const sessionId = randomUUID();
      const streamRef = openStreamBuffer(tenantId, sessionId, body.mimeType);
      const session = await createVoiceSession(tenantId, {
        sessionId,
        ...(optionalString(body.conversationId) ? { conversationId: optionalString(body.conversationId) } : {}),
        ...(optionalString(body.agentId) ? { agentId: optionalString(body.agentId) } : {}),
        streamRef,
      });
      res.status(201).json({ session, transport: { kind: 'http-chunked', appendPath: `${BASE}/${session.sessionId}/audio`, commitPath: `${BASE}/${session.sessionId}/commit` } });
    } catch (err) { next(err); }
  });

  // Append one base64 audio chunk to the current utterance (tenant + budget guarded).
  app.post(`${BASE}/:sessionId/audio`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const session = await getOpenVoiceSession(tenantId, req.params.sessionId);
      const bytes = appendStreamChunk(session.streamRef, tenantId, (req.body as { audioChunk?: unknown })?.audioChunk);
      res.status(202).json({ streamRef: session.streamRef, bytes });
    } catch (err) { next(err); }
  });

  // Commit the utterance (endpoint signal): CORE transcribes the buffered live stream
  // and emits the canonical `voice.*` turn; respond with the settled turn + events, then
  // rotate the session to a fresh utterance handle so the full-duplex loop continues.
  app.post(`${BASE}/:sessionId/commit`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const session = await getOpenVoiceSession(tenantId, req.params.sessionId);
      if (!deps.hostSuite) throw new OpenwopError('host_capability_missing', 'aiProviders adapter not wired.', 503, {});

      const events: Array<{ type: string; payload: unknown }> = [];
      let seq = 0;
      const adapter = createAiProvidersAdapter({
        runId: `voice:${session.sessionId}`,
        nodeId: 'voice.turn',
        tenantId,
        attempt: 1,
        secrets: {},
        policyResolver: deps.hostSuite.providerPolicyResolver,
        emit: async (type, payload) => { seq += 1; events.push({ type, payload }); return { eventId: `voice-evt-${seq}`, sequence: seq }; },
      });

      const body = (req.body ?? {}) as { languageCode?: unknown };
      let result;
      try {
        result = await adapter.callTranscriber({
          audio: { streamRef: session.streamRef },
          ...(optionalString(body.languageCode) ? { languageCode: optionalString(body.languageCode) } : {}),
        });
      } catch (err) {
        if (err instanceof AiProviderError) {
          const clientError = err.code === 'invalid_request' || err.code === 'transcription_unsupported';
          res.status(clientError ? 400 : 502).json({ error: { code: err.code, message: err.message, details: err.details } });
          return;
        }
        throw err;
      }

      // GC the committed utterance buffer + rotate to the next handle (the turn is now
      // durable as the emitted `voice.*` events — finding #7).
      closeStreamBuffer(session.streamRef);
      const nextStreamRef = openStreamBuffer(tenantId, session.sessionId, undefined);
      const advanced = await advanceVoiceSession(session, nextStreamRef);
      res.status(200).json({ ...result, events, nextStreamRef, turns: advanced.turns });
    } catch (err) { next(err); }
  });

  // P2 — speak the agent's reply (TTS-out). The reply TEXT comes from the ONE chat
  // (the real chat-responder generates it; voice mode does NOT re-derive it — no second
  // chat). Synthesize via the CORE streaming `callSpeechSynthesizer` → `voice.synthesis_chunk`
  // (metadata-only) + an audio asset; the per-org TTS budget (ADR 0106) is enforced inside.
  // The reply is barge-in-cancellable (§F).
  app.post(`${BASE}/:sessionId/speak`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const session = await getOpenVoiceSession(tenantId, req.params.sessionId);
      if (!deps.hostSuite) throw new OpenwopError('host_capability_missing', 'aiProviders adapter not wired.', 503, {});
      const body = (req.body ?? {}) as { text?: unknown; voiceId?: unknown; provider?: unknown; credentialRef?: unknown };
      const text = (req.body as { text?: unknown })?.text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new OpenwopError('validation_error', '`text` (the reply to speak) is required.', 400, { field: 'text' });
      }
      // Per-agent voice (P3 / user ask): resolve { provider, voiceId, credentialRef } from the
      // session agent's profile (the ADR 0031 agent-config seam).
      const agentVoice = await resolveAgentVoice(tenantId, session.agentId);
      // W6 (architect #6): when the session is scoped to an agent that has a configured voice,
      // the AGENT voice is AUTHORITATIVE — a client cannot override it per call. An unscoped
      // session (no agent voice) honors the client's request; else the host default.
      const agentAuthoritative = !!(agentVoice && (agentVoice.provider || agentVoice.voiceId));
      const voiceId = (agentAuthoritative ? agentVoice?.voiceId : optionalString(body.voiceId)) ?? DEFAULT_VOICE_ID;
      const provider = agentAuthoritative ? agentVoice?.provider : optionalString(body.provider);
      // W1: a non-managed provider (ElevenLabs/OpenAI/Google) needs a BYOK credentialRef, or
      // callSpeechSynthesizer fails honestly with `speech_synthesis_unsupported`. Resolved
      // tenant-scoped (secretResolver) — a client can only reference its own tenant's secrets.
      const credentialRef = agentAuthoritative ? agentVoice?.credentialRef : optionalString(body.credentialRef);
      const useMock = process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';

      const turnId = randomUUID();
      beginSpeak(session.sessionId, turnId);
      const events: Array<{ type: string; payload: unknown }> = [];
      let seq = 0;
      const adapter = createAiProvidersAdapter({
        runId: `voice:${session.sessionId}`,
        nodeId: 'voice.speak',
        tenantId,
        attempt: 1,
        secrets: {},
        policyResolver: deps.hostSuite.providerPolicyResolver,
        emit: async (type, payload) => { seq += 1; events.push({ type, payload }); return { eventId: `voice-evt-${seq}`, sequence: seq }; },
      });
      try {
        const result = await adapter.callSpeechSynthesizer({
          text,
          voiceId,
          stream: true,
          // Deterministic mock under the test seam; else the agent's / requested TTS provider
          // (e.g. ElevenLabs, BYOK), or the host default when unset.
          ...(useMock ? { provider: 'mock' as const } : provider ? { provider } : {}),
          ...(!useMock && credentialRef ? { credentialRef } : {}),
        });
        // §F voice-bargein-no-partial-leak: if the user barged in while we synthesized,
        // suppress the audio + chunks entirely (the turn was cancelled).
        if (isSpeakCancelled(session.sessionId, turnId)) {
          endSpeak(session.sessionId, turnId);
          res.status(200).json({ turnId, cancelled: true });
          return;
        }
        // Leave the turn ACTIVE for the playback window: the client is now playing this
        // reply, and a `/barge-in` cancels it. The turn is superseded by the next /speak,
        // or cleared on /commit (next user utterance) / session end.
        res.status(200).json({ turnId, audio: result.audio, events });
      } catch (err) {
        endSpeak(session.sessionId, turnId);
        if (err instanceof AiProviderError) {
          const clientError = err.code === 'invalid_request' || err.code === 'content_too_long' || err.code === 'media_budget_exceeded' || err.code === 'speech_synthesis_unsupported';
          res.status(clientError ? (err.code === 'media_budget_exceeded' ? 429 : 400) : 502).json({ error: { code: err.code, message: err.message, details: err.details } });
          return;
        }
        throw err;
      }
    } catch (err) { next(err); }
  });

  // P2 — barge-in: the user spoke during playback. Cancel the in-flight reply and emit
  // the §F lifecycle `voice.barge_in → voice.cancelled` with NO `voice.synthesis_chunk`
  // after the cancel (no partial output leaks). Mirrors the core RFC 0106 §D/§F seam,
  // scoped to the product session.
  app.post(`${BASE}/:sessionId/barge-in`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const session = await getOpenVoiceSession(tenantId, req.params.sessionId);
      const cancelledTurn = cancelSpeak(session.sessionId);
      const atMs = typeof (req.body as { atMs?: unknown })?.atMs === 'number' ? (req.body as { atMs: number }).atMs : 0;
      const events = [
        { type: 'voice.barge_in', payload: { atMs } },
        { type: 'voice.cancelled', payload: { atMs: atMs + 10, reason: 'barge_in' } },
      ];
      res.status(200).json({ events, cancelledTurn });
    } catch (err) { next(err); }
  });

  // End the session: GC its buffers + the session record.
  app.delete(`${BASE}/:sessionId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      closeSessionBuffers(req.params.sessionId);
      dropSpeak(req.params.sessionId);
      await closeVoiceSession(tenantId, req.params.sessionId);
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
