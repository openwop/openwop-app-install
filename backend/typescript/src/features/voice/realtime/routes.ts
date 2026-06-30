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
import { createLogger } from '../../../observability/logger.js';
import { resolveAgentVoice } from '../voiceSession.js';
import { getRealtimeConfig, setRealtimeConfig, realtimeProvider, type SetRealtimeConfigInput } from './config.js';
import { executeRealtimeToolCall, resolveAgentToolDecls } from './toolBridge.js';
import { issueRealtimeSession, resolveRealtimeSession } from './sessionRegistry.js';
import { openSideband, type SidebandSession } from './openaiSideband.js';
import { RealtimeProviderError, type RealtimeProviderId } from './types.js';

const log = createLogger('features.voice.realtime');
const OPENAI_BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
const BASE = '/v1/host/openwop-app/voice/realtime';
const DEFAULT_INSTRUCTIONS =
  'You are a helpful assistant in a spoken, real-time voice conversation. Be brief and ' +
  'conversational, one idea at a time, and confirm before any action. (RT-2 wires the agent persona + tools.)';

export function registerRealtimeRoutes(deps: RouteDeps): void {
  const { app } = deps;

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

      const body = (req.body ?? {}) as { agentId?: unknown };
      const agentId = optionalString(body.agentId);
      const agentVoice = await resolveAgentVoice(tenantId, agentId);
      // RT-2: the agent's allowlisted tools become the realtime session's function declarations.
      // The model may call them; the host bridge (POST …/tool-call) enforces allowlist + firewall.
      const tools = resolveAgentToolDecls(agentId);

      try {
        const session = await realtimeProvider(config.provider).createSession({
          apiKey,
          ...(config.model ? { model: config.model } : {}),
          ...(agentVoice?.voiceId ? { voice: agentVoice.voiceId } : {}),
          instructions: DEFAULT_INSTRUCTIONS,
          tools,
        });
        // RTV-2/RTV-3: mint a host-issued session id bound to {tenant, agent}. The Gemini
        // relay path echoes it on …/tool-call so the host re-derives the agent + seen-set
        // key server-side (the client can't rotate the key or name a different agent).
        const hostSessionId = issueRealtimeSession(tenantId, agentId);
        // RTV-4: audit the ephemeral-token mint (no key material; provider + agent only).
        log.info('realtime_session_created', { tenantId, provider: config.provider, agentId, hostSessionId });
        res.status(200).json({ realtime: session, hostSessionId });
      } catch (err) {
        if (err instanceof RealtimeProviderError) {
          res.status(502).json({ error: { code: 'realtime_provider_error', message: err.message, provider: err.provider, status: err.status } });
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
      const sessionConfig = { instructions: DEFAULT_INSTRUCTIONS, tools: resolveAgentToolDecls(agentId).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })), ...(agentVoice?.voiceId ? { voice: agentVoice.voiceId } : {}) };

      // Deterministic mock under the test seam (no key/network): return a fake answer + call_id,
      // open no real sideband. Exercises the route wiring; the live OpenAI POST is verify-with-key.
      if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
        res.status(200).json({ sessionId: 'rtc_test', sdp: 'v=0\r\n(test answer)\r\n' });
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
        res.status(502).json({ error: { code: 'realtime_provider_error', message: `OpenAI rejected the call (${oa.status}): ${snippet}` } });
        return;
      }
      const answer = await oa.text();
      const callId = (oa.headers.get('location') ?? '').split('/').pop() ?? '';
      if (!callId) throw new OpenwopError('internal_error', 'OpenAI returned no call id (Location header).', 502, {});
      const session: SidebandSession = { callId, tenantId, ...(agentId ? { agentId } : {}), ...(conversationId ? { conversationId } : {}) };
      openSideband(session, apiKey, sessionConfig);
      res.status(200).json({ sessionId: callId, sdp: answer });
    } catch (err) { next(err); }
  });

  // RT-2 — the tool-execution bridge. The browser relays a provider function-call here; the
  // host runs it through the SAME allowlist + capability firewall (ADR 0135) + executor a typed
  // turn uses, and returns the result for the browser to send back into the realtime session.
  app.post(`${BASE}/tool-call`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'voice', 'Voice mode');
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as { sessionId?: unknown; callId?: unknown; name?: unknown; arguments?: unknown };
      const name = optionalString(body.name);
      const callId = optionalString(body.callId) ?? '';
      const hostSessionId = optionalString(body.sessionId);
      if (!name) throw new OpenwopError('validation_error', '`name` (the tool to call) is required.', 400, { field: 'name' });
      // RTV-2/RTV-3: the `sessionId` MUST be a host-issued id from POST /session. The host
      // resolves the bound agentId server-side (the client body's agentId is ignored) and
      // uses the host id as the firewall seen-set key — it can't be rotated to reset
      // composition state within a conversation.
      const resolved = hostSessionId ? resolveRealtimeSession(hostSessionId, tenantId) : null;
      if (!resolved || !hostSessionId) {
        throw new OpenwopError('forbidden', 'A valid realtime session (from POST /session) is required.', 403, {});
      }
      const args = (body.arguments && typeof body.arguments === 'object') ? body.arguments as Record<string, unknown> : {};
      const outcome = await executeRealtimeToolCall({ tenantId, agentId: resolved.agentId, sessionId: hostSessionId, name, args });
      // RTV-4: audit the tool-call verdict (no args/secrets — tool name + decision only).
      log.info('realtime_tool_call', { tenantId, hostSessionId, toolName: name, status: outcome.status });
      res.status(200).json({ callId, ...outcome });
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
