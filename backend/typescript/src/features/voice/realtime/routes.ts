/**
 * Real-time voice session routes (ADR 0141 RT-1) — host-extension, toggle-gated.
 *
 *   POST …/voice/realtime/session   → mint an ephemeral token from the tenant BYOK key +
 *                                      return the browser session config (or {realtime:null}
 *                                      when no realtime provider is configured → the FE falls
 *                                      back to the ADR 0138 walkie-talkie).
 *   GET/PUT …/voice/realtime/config → the tenant's realtime provider + credentialRef (admin).
 *
 * Namespace: disjoint from ADR 0138's `/voice/session/*` and core's `/voice/barge-in`.
 */
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../../types.js';
import { resolveSecret } from '../../../byok/secretResolver.js';
import { tenantOf, requireFeatureEnabled, optionalString } from '../../featureRoute.js';
import { requireSuperadmin } from '../../../host/superadmin.js';
import { personalTenantOf } from '../../../host/requestSubject.js';
import { createLogger } from '../../../observability/logger.js';
import { resolveAgentVoice } from '../voiceSession.js';
import { composeChatContext, composeTranscriptDigest, SPOKEN_MODE_ADDENDUM, composeTranscriptTurns } from '../../../host/chatContext.js';
import { getConversationMeta } from '../../../host/conversationStore.js';
import { isVisibleToAsync } from '../../../host/conversationVisibility.js';
import { subscribeConversationMessages } from '../../../host/chatMessageBus.js';
import { openSseChannel } from '../../../host/sseChannel.js';
import { composeVoicePreamble } from './voicePreamble.js';
import { resolveCallerUser } from '../../users/usersGuards.js';
import { getRealtimeConfig, setRealtimeConfig, realtimeProvider, type SetRealtimeConfigInput } from './config.js';
import { executeRealtimeToolCall, resolveAgentToolDecls } from './toolBridge.js';
import { issueRealtimeSession, resolveRealtimeSession } from './sessionRegistry.js';
import { openSideband, resolveHeldSidebandCall, type SidebandSession } from './openaiSideband.js';
import { buildDelegateToolDecl, buildReturnToolDecl, type DelegableAgent, type SpeakerSnapshot } from './delegation.js';
import { listRoster } from '../../../host/rosterService.js';
import { resolveAgentIdentity } from '../../../host/agentIdentity.js';
import { RealtimeProviderError, type RealtimeProviderId, type RealtimeToolDecl } from './types.js';
import { sendError } from '../../../middleware/errorEnvelope.js';

const log = createLogger('features.voice.realtime');
const OPENAI_BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
const BASE = '/v1/host/openwop-app/voice/realtime';
/**
 * ADR 0199 — the session's instructions are COMPOSED per request from the same
 * chat-context owner the text exchange uses (persona + identity anchor +
 * conversation blocks) + the spoken-mode addendum + the budgeted transcript
 * digest. The old RT-2 placeholder ("(RT-2 wires the agent persona + tools.)")
 * is retired — the persona half of RT-2 finally shipped.
 */
async function composeRealtimeInstructions(
  deps: { storage: import('../../../storage/storage.js').Storage; getWorkflowName: (id: string) => Promise<string | null> },
  tenantId: string,
  opts: {
    agentId?: string | undefined; conversationId?: string | undefined; callerUserId?: string | undefined;
    /** ADR 0199 OQ-1 (Phase G): 'items' returns the windowed turns as
     *  `seedTurns` for real history-item injection (OpenAI sideband) and
     *  keeps the transcript OUT of the instructions block. Default
     *  'instructions' (Gemini — no history-item API) is unchanged. */
    transcriptMode?: 'instructions' | 'items';
  },
): Promise<{ instructions: string; seedTurns: Array<{ role: 'user' | 'assistant'; text: string }>; degraded: string[]; conveneRefusal: string | null }> {
  // AUTHZ (ADR 0199 review finding): the caller must be able to READ the
  // conversation before its context (board block / owner-subject knowledge /
  // transcript) is composed into the model's instructions — the same
  // `isVisibleToAsync` gate the chat-session routes enforce. In prod the
  // browser never sees the instructions, but the MODEL does, and "what was
  // said earlier?" would exfiltrate another user's thread. Fail-closed:
  // an invisible conversation composes as if unscoped (persona only).
  let conversationId = opts.conversationId;
  if (conversationId) {
    const meta = await getConversationMeta(tenantId, conversationId).catch(() => null);
    const visible = await isVisibleToAsync(meta, tenantId, opts.callerUserId).catch(() => false);
    if (!visible) {
      // ADR 0277 — name the drop: an unresolved caller makes every OWNED
      // conversation invisible, silently shedding the transcript, the board
      // block, and the owner-subject KB in one stroke. Keep the fail-closed
      // behavior (never compose an unreadable thread), but make it diagnosable.
      // SECURITY (ADR 0277 OQ-1 review): this block stays LOG-ONLY — surfacing it
      // in the response `degraded` list would be an existence oracle (an invisible
      // conversation would flag while a nonexistent one would not).
      log.warn('context_degraded', { block: 'conversation', conversationId, reason: opts.callerUserId ? 'not_visible' : 'caller_unresolved' });
      conversationId = undefined;
    }
  }
  const mode = opts.transcriptMode ?? 'instructions';
  // Transcript first (both variants ride the gated conversationId — the
  // visibility check above covers the item-seed path exactly as the digest),
  // so its tail can SEED the scaffold's owner-subject KB retrieval below.
  const transcript = conversationId && mode === 'instructions'
    ? await composeTranscriptDigest(deps.storage, tenantId, conversationId)
    : '';
  const seedTurns = conversationId && mode === 'items'
    ? await composeTranscriptTurns(deps.storage, tenantId, conversationId)
    : [];
  const seed = transcript.length > 0
    ? transcript.slice(-500)
    : (seedTurns.length > 0 ? seedTurns[seedTurns.length - 1]!.text.slice(0, 500) : 'current work and recent activity');
  // ADR 0277 — thread the seed into the scaffold: the text path seeds owner-KB
  // retrieval with the user's turn text (conversationExchange), but voice
  // previously passed nothing, so the ADR 0084 grounding ran an UNSEEDED query
  // (generic-or-empty results). Same seed as the preamble: what's being discussed.
  const ctx = await composeChatContext(tenantId, {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(opts.callerUserId ? { callerUserId: opts.callerUserId } : {}),
    seedText: seed,
  });
  // Phase 2 — the agent's work snapshot (fail-soft; empty for unscoped
  // sessions). The memory/knowledge digest now rides ctx.systemPrompt via
  // composeChatContext's seeded fold-in (ADR 0277 P2) — one owner, no
  // double-injection.
  const degraded: string[] = [...ctx.degraded];
  const preamble = await composeVoicePreamble(
    { getWorkflowName: deps.getWorkflowName },
    tenantId,
    opts.agentId,
  ).catch((err: unknown) => {
    log.warn('context_degraded', { block: 'preamble', agentId: opts.agentId, reason: err instanceof Error ? err.message : String(err) });
    degraded.push('preamble');
    return '';
  });
  const blocks = [ctx.systemPrompt, SPOKEN_MODE_ADDENDUM, preamble, transcript].filter((b) => b.length > 0);
  let instructions = blocks.join('\n\n');
  // Size guard: providers cap instruction payloads; keep a hard ceiling and
  // shed the TRANSCRIPT first (oldest context, already elision-tolerant).
  const MAX_INSTRUCTIONS_CHARS = 24_000;
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    const withoutTranscript = [ctx.systemPrompt, SPOKEN_MODE_ADDENDUM, preamble].filter((b) => b.length > 0).join('\n\n');
    const room = MAX_INSTRUCTIONS_CHARS - withoutTranscript.length - 2;
    instructions = room > 200
      ? `${withoutTranscript}\n\n${transcript.slice(-room)}`
      : withoutTranscript.slice(0, MAX_INSTRUCTIONS_CHARS);
  }
  return { instructions, seedTurns, degraded, conveneRefusal: ctx.conveneRefusal };
}

/** ADR 0324 — the conversation a realtime session may bind to its TOOL SCOPE
 *  (and, on the OpenAI path, persist transcripts into) must EXIST and be
 *  VISIBLE to the authenticated opener — the same existence+visibility gate the
 *  transcript stream route enforces (IDOR-safe). The chat path gets this for
 *  free (`chatSessionId` is server-stamped from the caller's own session at run
 *  creation); voice takes a client-supplied id, so it is gated here once, at
 *  bind time. Fail-closed: unknown/invisible ⇒ the session runs unscoped. */
async function scopedConversationIdOf(
  storage: import('../../../storage/storage.js').Storage,
  tenantId: string,
  conversationId: string | undefined,
  callerUserId: string | undefined,
): Promise<string | undefined> {
  if (!conversationId) return undefined;
  const exists = await storage.getChatSession(tenantId, conversationId).catch(() => null);
  if (!exists) return undefined;
  const meta = await getConversationMeta(tenantId, conversationId).catch(() => null);
  const visible = await isVisibleToAsync(meta, tenantId, callerUserId).catch(() => false);
  return visible ? conversationId : undefined;
}

export function registerRealtimeRoutes(deps: RouteDeps): void {
  const { app, storage, hostSuite } = deps;
  // Workflow display names for the Phase 2 work snapshot — resolved through
  // the catalog (fail-soft to the id).
  const getWorkflowName = async (id: string): Promise<string | null> => {
    try {
      const wf = await hostSuite.workflowCatalog.getWorkflow(id);
      const name = wf?.definition.metadata?.['name'];
      return typeof name === 'string' && name.length > 0 ? name : null;
    } catch {
      return null;
    }
  };

  // Open a realtime session: mint the ephemeral token + return the browser config.
  app.post(`${BASE}/session`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const config = await getRealtimeConfig(tenantId);

      // Not configured → tell the FE to use the walkie-talkie fallback (expected, not an error).
      if (config.provider === 'off') {
        res.status(200).json({ realtime: null });
        return;
      }
      if (!config.credentialRef) {
        throw new OpenwopError('credential_required', 'No BYOK key is set for the realtime voice provider.', 400, { provider: config.provider });
      }
      const apiKey = await resolveSecret(config.credentialRef, { tenantId });
      if (!apiKey) {
        throw new OpenwopError('credential_unavailable', 'The realtime voice provider key could not be resolved.', 400, { provider: config.provider });
      }

      const body = (req.body ?? {}) as { agentId?: unknown; conversationId?: unknown };
      const agentId = optionalString(body.agentId);
      const sessionConversationId = optionalString(body.conversationId);
      // ADR 0199 — the same brain as a typed turn (fail-soft: a compose failure
      // must not block voice; fall back to the generic scaffold + addendum).
      const routeDegraded: string[] = [];
      const callerUser = await resolveCallerUser(req).catch((err: unknown) => {
        // ADR 0277 — this single miss loses the NAME and (via the visibility
        // gate) the whole conversation block. Fail-soft as before, but loudly.
        log.warn('context_degraded', { block: 'identity', reason: err instanceof Error ? err.message : String(err) });
        // OQ-1: an ANONYMOUS caller (sign_in_required) has no identity to lose —
        // only an unexpected resolution failure counts as degraded.
        if (!(err instanceof OpenwopError && err.code === 'sign_in_required')) routeDegraded.push('identity');
        return null;
      });
      const { instructions, degraded: composeDegraded, conveneRefusal } = await composeRealtimeInstructions({ storage, getWorkflowName }, tenantId, {
        agentId, conversationId: sessionConversationId, callerUserId: callerUser?.userId,
      }).catch((err: unknown) => {
        log.warn('context_degraded', { block: 'whole', agentId, reason: err instanceof Error ? err.message : String(err) });
        // H1 — `conveneRefusal: null` here is a KNOWN fail-open edge, named rather
        // than left implicit: if composition threw outright we no longer know
        // whether the bound conversation is an unacknowledged board. It is the
        // pre-existing "voice must never be blocked by a compose failure" posture
        // (the session degrades to the bare addendum, with NO board persona, NO
        // board context and NO cohort — i.e. nothing of the board is simulated),
        // and `composeChatContext` is fail-soft on every internal leg, so reaching
        // here means the whole compose is broken, not the gate.
        return { instructions: SPOKEN_MODE_ADDENDUM, seedTurns: [], degraded: ['whole'], conveneRefusal: null };
      });
      routeDegraded.push(...composeDegraded);
      // H1 / ADR 0588 D5 — a realtime session on an unacknowledged `living` board
      // is a convene by another name (it composes the same persona + planning
      // block and then SPEAKS). Refuse before any provider token is minted.
      if (conveneRefusal) throw new OpenwopError('validation_error', conveneRefusal, 422, { field: 'livingPersonaAck' });
      const agentVoice = await resolveAgentVoice(tenantId, agentId);
      // RT-2: the agent's allowlisted tools become the realtime session's function declarations.
      // The model may call them; the host bridge (POST …/tool-call) enforces allowlist + firewall.
      const tools = await resolveAgentToolDecls(tenantId, agentId);

      try {
        const session = await realtimeProvider(config.provider).createSession({
          apiKey,
          ...(config.model ? { model: config.model } : {}),
          ...(agentVoice?.voiceId ? { voice: agentVoice.voiceId } : {}),
          instructions,
          tools,
        });
        // RTV-2/RTV-3: mint a host-issued session id bound to {tenant, agent}. The Gemini
        // relay path echoes it on …/tool-call so the host re-derives the agent + seen-set
        // key server-side (the client can't rotate the key or name a different agent).
        // ADR 0324 — also bind the AUTHENTICATED opener + the gated conversation, so
        // …/tool-call can thread the acting user + conversation into tool execution
        // (chat-parity for the ADR 0308 deliverable tools) without trusting the body.
        const scopedConversationId = await scopedConversationIdOf(storage, tenantId, sessionConversationId, callerUser?.userId);
        const hostSessionId = issueRealtimeSession(tenantId, agentId, {
          ...(callerUser ? { userId: callerUser.userId } : {}),
          ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
          // ADR 0627 D3 (review S2) — the opener's personal tenant, host-bound at mint.
          ...(callerUser && personalTenantOf(req) ? { personalTenant: personalTenantOf(req) } : {}),
        });
        // RTV-4: audit the ephemeral-token mint (no key material; provider + agent only).
        log.info('realtime_session_created', { tenantId, provider: config.provider, agentId, hostSessionId });
        // ADR 0277 OQ-1 — the degraded-context signal (block names only; the FE
        // shows a quiet chip). Omitted entirely when composition was whole.
        res.status(200).json({ realtime: session, hostSessionId, ...(routeDegraded.length > 0 ? { degraded: routeDegraded } : {}) });
      } catch (err) {
        if (err instanceof RealtimeProviderError) {
          sendError(res, 502, 'realtime_provider_error', err.message, { provider: err.provider, status: err.status });
          return;
        }
        throw err;
      }
    } catch (err) { next(err); }
  });

  // RT-4 (architect fix) — OpenAI sideband: the host MEDIATES the WebRTC SDP so it owns the
  // session. The browser POSTs its offer here; the host POSTs it to OpenAI with the real BYOK
  // key, learns the `call_id` (SDP `Location` header), opens a server-side sideband WebSocket
  // that HANDLES tools + captures transcripts, and returns the answer SDP. The browser keeps the
  // audio but no longer holds the session id, relays tools, or sees the only transcript copy —
  // retiring the firewall-bypass + no-audit findings for the OpenAI path.
  app.post(`${BASE}/openai/connect`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const config = await getRealtimeConfig(tenantId);
      if (config.provider !== 'openai-realtime') {
        throw new OpenwopError('invalid_request', 'OpenAI Realtime is not the configured provider for this tenant.', 400, { provider: config.provider });
      }
      if (!config.credentialRef) throw new OpenwopError('credential_required', 'No BYOK key is set for OpenAI Realtime.', 400, {});
      const apiKey = await resolveSecret(config.credentialRef, { tenantId });
      if (!apiKey) throw new OpenwopError('credential_unavailable', 'The OpenAI Realtime key could not be resolved.', 400, {});

      const body = (req.body ?? {}) as { sdp?: unknown; agentId?: unknown; conversationId?: unknown };
      const sdp = optionalString(body.sdp);
      if (!sdp) throw new OpenwopError('validation_error', '`sdp` (the browser WebRTC offer) is required.', 400, { field: 'sdp' });
      const agentId = optionalString(body.agentId);
      const conversationId = optionalString(body.conversationId);
      const model = config.model ?? 'gpt-realtime';
      const agentVoice = await resolveAgentVoice(tenantId, agentId);
      const routeDegraded: string[] = [];
      const callerUser = await resolveCallerUser(req).catch((err: unknown) => {
        log.warn('context_degraded', { block: 'identity', reason: err instanceof Error ? err.message : String(err) });
        if (!(err instanceof OpenwopError && err.code === 'sign_in_required')) routeDegraded.push('identity');
        return null;
      });
      // Phase G (ADR 0199 OQ-1): the sideband path seeds prior turns as REAL
      // history items instead of the transcript-in-instructions block.
      const { instructions, seedTurns, degraded: composeDegraded, conveneRefusal } = await composeRealtimeInstructions({ storage, getWorkflowName }, tenantId, {
        agentId, conversationId, callerUserId: callerUser?.userId, transcriptMode: 'items',
      }).catch((err: unknown) => {
        log.warn('context_degraded', { block: 'whole', agentId, reason: err instanceof Error ? err.message : String(err) });
        // H1 — `conveneRefusal: null` here is a KNOWN fail-open edge, named rather
        // than left implicit: if composition threw outright we no longer know
        // whether the bound conversation is an unacknowledged board. It is the
        // pre-existing "voice must never be blocked by a compose failure" posture
        // (the session degrades to the bare addendum, with NO board persona, NO
        // board context and NO cohort — i.e. nothing of the board is simulated),
        // and `composeChatContext` is fail-soft on every internal leg, so reaching
        // here means the whole compose is broken, not the gate.
        return { instructions: SPOKEN_MODE_ADDENDUM, seedTurns: [], degraded: ['whole'], conveneRefusal: null };
      });
      routeDegraded.push(...composeDegraded);
      // H1 / ADR 0588 D5 — a realtime session on an unacknowledged `living` board
      // is a convene by another name (it composes the same persona + planning
      // block and then SPEAKS). Refuse before any provider token is minted.
      if (conveneRefusal) throw new OpenwopError('validation_error', conveneRefusal, 422, { field: 'livingPersonaAck' });
      const wireTool = (t: RealtimeToolDecl): Record<string, unknown> => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters });
      const agentTools = (await resolveAgentToolDecls(tenantId, agentId)).map(wireTool);
      // ADR 0304 D1 — spoken delegation: an agent-scoped session with at least one OTHER
      // enabled roster agent gets the session-control delegate tool. OpenAI-realtime ONLY
      // (this route): the sideband can re-instruct/re-voice the live session; Gemini's
      // token-locked setup cannot, so the Gemini mint never declares it (honest gap).
      let delegation: { composeFor: (id: string) => Promise<SpeakerSnapshot | null>; delegable: DelegableAgent[] } | undefined;
      if (agentId) {
        const homeIdentity = await resolveAgentIdentity(tenantId, agentId, { allowReverseScan: true }).catch(() => null);
        const roster = await listRoster(tenantId).catch(() => [] as Awaited<ReturnType<typeof listRoster>>);
        const delegable: DelegableAgent[] = roster
          .filter((r) => r.enabled)
          .filter((r) => r.rosterId !== agentId && r.rosterId !== homeIdentity?.rosterId && r.agentRef.agentId !== homeIdentity?.agentId)
          .map((r) => ({ agentId: r.rosterId, persona: r.persona }));
        if (delegable.length > 0) {
          const homePersona = roster.find((r) => r.rosterId === (homeIdentity?.rosterId ?? agentId))?.persona ?? 'the host agent';
          delegation = {
            delegable,
            // The target is a REAL agent: same instruction composer, same voice resolver,
            // same tool projection — its OWN allowlist (plus the return control), never a
            // union with the delegator's (ADR 0304 D1 step 3).
            composeFor: async (targetId: string): Promise<SpeakerSnapshot | null> => {
              if (!delegable.some((d) => d.agentId === targetId)) return null;
              const composed = await composeRealtimeInstructions({ storage, getWorkflowName }, tenantId, {
                agentId: targetId, conversationId, callerUserId: callerUser?.userId, transcriptMode: 'items',
              }).catch(() => null);
              if (!composed) return null;
              const targetVoice = await resolveAgentVoice(tenantId, targetId).catch(() => null);
              const targetTools = (await resolveAgentToolDecls(tenantId, targetId).catch(() => [] as RealtimeToolDecl[])).map(wireTool);
              return {
                agentId: targetId,
                instructions: composed.instructions,
                tools: [...targetTools, wireTool(buildReturnToolDecl(homePersona))],
                ...(targetVoice?.voiceId ? { voice: targetVoice.voiceId } : {}),
              };
            },
          };
        }
      }
      const sessionConfig = {
        instructions, seedTurns,
        tools: delegation ? [...agentTools, wireTool(buildDelegateToolDecl(delegation.delegable))] : agentTools,
        ...(agentVoice?.voiceId ? { voice: agentVoice.voiceId } : {}),
        ...(delegation ? { delegation } : {}),
      };

      // Deterministic mock under OPENWOP_VOICE_MOCK (no key/network): return a fake answer +
      // call_id, open no real sideband. Exercises the route wiring; the live OpenAI POST is
      // verify-with-key. NOT the conformance-seam flag — prod keeps that on (geminiLive.ts).
      if (process.env.OPENWOP_VOICE_MOCK === 'true') {
        res.status(200).json({ sessionId: 'rtc_test', sdp: 'v=0\r\n(test answer)\r\n', ...(routeDegraded.length > 0 ? { degraded: routeDegraded } : {}) });
        return;
      }

      let oa: Response;
      try {
        oa = await fetch(`${OPENAI_BASE}/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
          method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/sdp', 'openai-beta': 'realtime=v1' }, body: sdp,
        });
      } catch (err) {
        throw new OpenwopError('internal_error', `Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`, 502, {});
      }
      if (!oa.ok) {
        const snippet = (await oa.text().catch(() => '')).slice(0, 300);
        sendError(res, 502, 'realtime_provider_error', `OpenAI rejected the call (${oa.status}): ${snippet}`);
        return;
      }
      const answer = await oa.text();
      const callId = (oa.headers.get('location') ?? '').split('/').pop() ?? '';
      if (!callId) throw new OpenwopError('internal_error', 'OpenAI returned no call id (Location header).', 502, {});
      // ADR 0324 — the sideband session carries the AUTHENTICATED opener (tool acting-user
      // parity with chat) and only an existence+visibility-gated conversation (a caller can
      // no longer bind another user's conversation id for transcripts or tool scope).
      const scopedConversationId = await scopedConversationIdOf(storage, tenantId, conversationId, callerUser?.userId);
      const session: SidebandSession = {
        callId, tenantId,
        ...(agentId ? { agentId } : {}),
        ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
        ...(callerUser ? { userId: callerUser.userId } : {}),
        ...(callerUser && personalTenantOf(req) ? { personalTenant: personalTenantOf(req) } : {}),
      };
      openSideband(session, apiKey, sessionConfig);
      res.status(200).json({ sessionId: callId, sdp: answer, ...(routeDegraded.length > 0 ? { degraded: routeDegraded } : {}) });
    } catch (err) { next(err); }
  });

  // Live transcript delivery for the OpenAI path. The browser holds audio-only WebRTC and
  // never sees a transcript; the sideband persists each turn server-side + publishes a
  // per-conversation frame (openaiSideband.persistTranscript → publishChatMessageAppended).
  // The FE opens this SSE while a realtime session is live and reloads the thread on each
  // frame — the durable store is the source of truth (mirrors the channels stream, ADR 0154
  // FU-6). Read-gated by the SAME `isVisibleToAsync` the chat-session routes enforce so a
  // caller can't tail another user's conversation (IDOR-safe 404).
  app.get(`${BASE}/messages/stream`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const conversationId = optionalString((req.query ?? {}).conversationId);
      if (!conversationId) throw new OpenwopError('validation_error', '`conversationId` is required.', 400, { field: 'conversationId' });
      const caller = await resolveCallerUser(req).catch(() => null);
      // IDOR-safe 404: the session must EXIST and be VISIBLE to the caller. Existence alone
      // matters because `isVisibleToAsync(null, …)` is `true` for a legacy/unowned meta — so
      // without the existence check any tenant caller could open a stream on an arbitrary id.
      const exists = await storage.getChatSession(tenantId, conversationId);
      const meta = await getConversationMeta(tenantId, conversationId);
      if (!exists || !(await isVisibleToAsync(meta, tenantId, caller?.userId))) {
        throw new OpenwopError('not_found', 'Conversation not found.', 404, {});
      }
      const sse = openSseChannel(req, res, { heartbeatMs: 15_000 });
      const unsub = await subscribeConversationMessages(conversationId, (messageId) => {
        if (!sse.closed) res.write(`event: chat.message\ndata: ${JSON.stringify({ messageId })}\n\n`);
      });
      // The client may have disconnected during the await (openSseChannel's teardown is
      // idempotent and already ran) — unsubscribe now so the listener doesn't leak.
      if (sse.closed) { void unsub(); return; }
      sse.onClose(() => { void unsub(); });
    } catch (err) { next(err); }
  });

  // RT-2 — the tool-execution bridge. The browser relays a provider function-call here; the
  // host runs it through the SAME allowlist + capability firewall (ADR 0135) + executor a typed
  // turn uses, and returns the result for the browser to send back into the realtime session.
  app.post(`${BASE}/tool-call`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as { sessionId?: unknown; callId?: unknown; name?: unknown; arguments?: unknown; userApproved?: unknown };
      const name = optionalString(body.name);
      const callId = optionalString(body.callId) ?? '';
      const hostSessionId = optionalString(body.sessionId);
      if (!name) throw new OpenwopError('validation_error', '`name` (the tool to call) is required.', 400, { field: 'name' });
      // RTV-2/RTV-3: the `sessionId` MUST be a host-issued id from POST /session. The host
      // resolves the bound agentId server-side (the client body's agentId is ignored) and
      // uses the host id as the firewall seen-set key — it can't be rotated to reset
      // composition state within a conversation.
      const resolved = hostSessionId ? await resolveRealtimeSession(hostSessionId, tenantId) : null;
      if (!resolved || !hostSessionId) {
        throw new OpenwopError('forbidden', 'A valid realtime session (from POST /session) is required.', 403, {});
      }
      const args = (body.arguments && typeof body.arguments === 'object') ? body.arguments as Record<string, unknown> : {};
      // ADR 0324 — the acting user + conversation come from the HOST-bound session
      // record (mint-time), exactly like the agentId: the client body cannot name them.
      // A7 (ADR 0467 follow-on) — the in-voice approval card's one-shot approve.
      // Honored ONLY for a session with a BOUND human (mint-time userId): the card
      // click is that human's approval. A user-less session cannot self-approve.
      const userApproved = body.userApproved === true && Boolean(resolved.userId);
      const outcome = await executeRealtimeToolCall({
        tenantId, agentId: resolved.agentId, sessionId: hostSessionId, name, args,
        ...(resolved.userId ? { actingUserId: resolved.userId } : {}),
        ...(resolved.conversationId ? { conversationId: resolved.conversationId } : {}),
        ...(resolved.personalTenant ? { personalTenant: resolved.personalTenant } : {}),
        ...(userApproved ? { userApproved: true } : {}),
      });
      // RTV-4: audit the tool-call verdict (no args/secrets — tool name + decision only).
      log.info('realtime_tool_call', { tenantId, hostSessionId, toolName: name, status: outcome.status, ...(userApproved ? { userApproved: true } : {}) });
      res.status(200).json({ callId, ...outcome });
    } catch (err) { next(err); }
  });

  // A7 (ADR 0467 follow-on) — resolve a HELD sideband tool call from the chat
  // card. Authority: the authenticated caller must be the session OPENER (the
  // resolver enforces it); one-shot both ways. Member route (like /session).
  app.post(`${BASE}/held-approvals/resolve`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const user = await resolveCallerUser(req);
      const body = (req.body ?? {}) as { callId?: unknown; fcId?: unknown; approve?: unknown };
      if (typeof body.callId !== 'string' || !body.callId || typeof body.fcId !== 'string' || !body.fcId || typeof body.approve !== 'boolean') {
        throw new OpenwopError('validation_error', '`callId`, `fcId` (non-empty strings) and `approve` (boolean) are required.', 400, {});
      }
      const out = await resolveHeldSidebandCall({
        tenantId: tenantOf(req), userId: user.userId, callId: body.callId, fcId: body.fcId, approve: body.approve,
      });
      if (out.status === 'not_found') { sendError(
        res,
        404,
        'not_found',
        'No held approval for that call — it may have been resolved or the call ended.',
      ); return; }
      if (out.status === 'forbidden') { sendError(res, 403, 'forbidden', 'Only the human on the call can resolve its approvals.'); return; }
      log.info('voice_held_approval_resolved', { tenantId: tenantOf(req), callId: body.callId, approved: body.approve, outcome: out.status });
      res.status(200).json({ status: out.status });
    } catch (err) { next(err); }
  });

  // GRADE-4 — the NON-PRIVILEGED capability probe. Every member is entitled to
  // realtime voice (POST /session and /openai/connect are member routes), but the
  // FE probed the superadmin-gated GET /config to learn "is a provider active?"
  // — so for non-superadmin members the 403 silently degraded the UI to the
  // walkie fallback and the OpenAI transcript stream never subscribed. This
  // returns ONLY the provider id (never the credentialRef/model binding).
  app.get(`${BASE}/capability`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const c = await getRealtimeConfig(tenantOf(req));
      res.status(200).json({ provider: c.provider });
    } catch (err) { next(err); }
  });

  // Read the tenant realtime config (NEVER the key). Admin surface — RTV-1: superadmin-gated
  // (the tenant-admin primitive in this host, matching the menu-config tenant layer), since
  // it exposes the BYOK `credentialRef` binding.
  app.get(`${BASE}/config`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      requireSuperadmin(req, 'Reading the realtime voice provider configuration');
      const c = await getRealtimeConfig(tenantOf(req));
      res.status(200).json({ provider: c.provider, ...(c.credentialRef ? { credentialRef: c.credentialRef } : {}), ...(c.model ? { model: c.model } : {}) });
    } catch (err) { next(err); }
  });

  // Set the tenant realtime provider + BYOK credentialRef. RTV-1: superadmin-gated — repoints
  // the tenant's BYOK provider binding (and could downgrade governed OpenAI → lower-assurance
  // Gemini), so it is NOT a self-service member operation.
  app.put(`${BASE}/config`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      requireSuperadmin(req, 'Configuring the realtime voice provider');
      const body = (req.body ?? {}) as { provider?: unknown; credentialRef?: unknown; model?: unknown };
      const provider = body.provider;
      if (provider !== 'off' && provider !== 'openai-realtime' && provider !== 'gemini-live') {
        throw new OpenwopError('validation_error', '`provider` must be one of off | openai-realtime | gemini-live.', 400, { field: 'provider' });
      }
      const input: SetRealtimeConfigInput = {
        provider: provider as RealtimeProviderId | 'off',
        ...(optionalString(body.credentialRef) ? { credentialRef: optionalString(body.credentialRef) } : {}),
        ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}),
      };
      const saved = await setRealtimeConfig(tenantOf(req), input);
      res.status(200).json({ provider: saved.provider, ...(saved.credentialRef ? { credentialRef: saved.credentialRef } : {}), ...(saved.model ? { model: saved.model } : {}) });
    } catch (err) { next(err); }
  });
}
