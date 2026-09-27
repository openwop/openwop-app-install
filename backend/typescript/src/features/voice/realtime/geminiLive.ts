/**
 * Gemini Live adapter (ADR 0141) — speech-to-speech over WebSocket (BidiGenerateContent).
 *
 * Mints a short-lived ephemeral token from the tenant BYOK key via the v1alpha
 * AuthTokenService (`POST /v1alpha/authTokens`), then returns the WebSocket connect URL +
 * the session setup (model + system instruction + tools) the browser sends as the first
 * `BidiGenerateContentSetup` message. The long-lived key stays host-side.
 *
 * ⚠ Provider request/response shape is written to Google's current docs but is
 * VERIFY-WITH-KEY. Under OPENWOP_VOICE_MOCK it returns a deterministic mock —
 * NOT OPENWOP_TEST_SEAM_ENABLED, which prod keeps on for the conformance seam
 * ROUTES; keying user-facing provider mocks on it served every real user the
 * fake `auth_tokens/test_gemini` token (ADR 0141 correction).
 */
import type { CreateRealtimeSessionInput, RealtimeProvider, RealtimeSessionConfig } from './types.js';
import { RealtimeProviderError } from './types.js';
import { toGeminiSchema } from '../../../providers/dispatchProviderTools.js';

const GEMINI_BASE = (process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview'; // the docs' current Live-API model (RT-7); admins can override via config.model
// RT-9b: EPHEMERAL tokens authenticate ONLY the CONSTRAINED bidi method —
// `BidiGenerateContentConstrained` (v1alpha). Connecting them to the plain
// `BidiGenerateContent` endpoint "succeeds" at the socket layer, then the server
// closes 1000 WITHOUT ever sending `setupComplete` — the "Gemini Live closed
// (1000) before setup completed" failure. The client still sends its `setup`
// message on this endpoint; the token's `bidiGenerateContentSetup` governs
// (RT-7 lock). Ref: ai.google.dev/api/live + the ephemeral-tokens guide.
const WS_URL = `${GEMINI_BASE.replace(/^http/, 'ws')}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained`;

/**
 * Build the CONSTRAINED auth-token request (ADR 0141 RT-5 / Gemini option A, corrected to the
 * REAL wire in RT-7): the REST resource is `POST /v1alpha/auth_tokens` and the body is an
 * `AuthToken` whose lock mechanism is `bidiGenerateContentSetup` + `fieldMask` — NOT the SDK's
 * `liveConnectConstraints` abstraction (that name 400s on the wire: `Unknown name
 * "liveConnectConstraints" at 'auth_token'`; the old `/v1alpha/authTokens` camelCase path 404s).
 * Verified against the live discovery doc + a bad-key probe (shape validates before key).
 *
 * Leaving `fieldMask` EMPTY while `bidiGenerateContentSetup` is present makes the effective
 * setup come ENTIRELY from this token — the client's `setup` message is IGNORED. That is the
 * strongest form of the RT-5 lock (a tampered browser cannot self-grant tools or change the
 * persona), but it also means this setup must carry EVERYTHING the client would have sent —
 * including both transcription configs (RT-5a) — or those settings are silently dropped.
 * Pure — unit-tested.
 */
export function buildGeminiConstraint(model: string, instructions: string, tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>): Record<string, unknown> {
  // Names arrive #578-sanitized from resolveAgentToolDecls; the parameter schemas are
  // projected onto Gemini's accepted OpenAPI subset (additionalProperties/$schema/… are
  // rejected wholesale otherwise — the same #578 class as the names).
  const functionDeclarations = tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) }));
  return {
    uses: 1,
    bidiGenerateContentSetup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: instructions }] },
      ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
      // Mirror the client's transcription asks (RT-5a) — with the token-locked setup the
      // client's own setup message is ignored, so these must live here.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export const geminiLiveProvider: RealtimeProvider = {
  id: 'gemini-live',
  defaultModel: DEFAULT_MODEL,
  async createSession(input: CreateRealtimeSessionInput): Promise<RealtimeSessionConfig> {
    const model = input.model ?? DEFAULT_MODEL;

    // The browser sends its OWN `setup` message on the constrained endpoint
    // (realtimeClient.ts). Even though the RT-7 token-locked setup governs, Gemini still
    // VALIDATES that client payload and closes 1007 (`Invalid JSON payload … Unknown name
    // "additionalProperties" at 'setup.tools[0].function_declarations[N].parameters'`) if a
    // parameter schema carries a non-OpenAPI keyword. So hand the browser Gemini-projected
    // tool schemas — the same subset the token constraint (buildGeminiConstraint) uses.
    const geminiTools = input.tools.map((t) => ({ ...t, parameters: toGeminiSchema(t.parameters) as Record<string, unknown> }));

    if (process.env.OPENWOP_VOICE_MOCK === 'true') {
      return {
        provider: 'gemini-live', model, ...(input.voice ? { voice: input.voice } : {}),
        token: 'auth_tokens/test_gemini', connect: { kind: 'websocket', url: WS_URL },
        instructions: input.instructions, tools: geminiTools,
      };
    }

    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE}/v1alpha/auth_tokens?key=${encodeURIComponent(input.apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildGeminiConstraint(model, input.instructions, input.tools)),
      });
    } catch (err) {
      throw new RealtimeProviderError('gemini-live', `Could not reach Gemini: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 300);
      throw new RealtimeProviderError('gemini-live', `Gemini rejected the auth-token request (${res.status}): ${snippet}`, res.status);
    }
    const j = (await res.json().catch(() => ({}))) as { name?: string; token?: string; expireTime?: string };
    const token = j.token ?? j.name;
    if (!token) throw new RealtimeProviderError('gemini-live', 'Gemini returned no ephemeral token.');
    return {
      provider: 'gemini-live', model, ...(input.voice ? { voice: input.voice } : {}),
      token,
      ...(j.expireTime ? { expiresAt: j.expireTime } : {}),
      connect: { kind: 'websocket', url: WS_URL },
      instructions: input.instructions, tools: geminiTools,
    };
  },
};
