/**
 * Gemini Live adapter (ADR 0141) — speech-to-speech over WebSocket (BidiGenerateContent).
 *
 * Mints a short-lived ephemeral token from the tenant BYOK key via the v1alpha
 * AuthTokenService (`POST /v1alpha/authTokens`), then returns the WebSocket connect URL +
 * the session setup (model + system instruction + tools) the browser sends as the first
 * `BidiGenerateContentSetup` message. The long-lived key stays host-side.
 *
 * ⚠ Provider request/response shape is written to Google's current docs but is
 * VERIFY-WITH-KEY. Under OPENWOP_TEST_SEAM_ENABLED it returns a deterministic mock.
 */
import type { CreateRealtimeSessionInput, RealtimeProvider, RealtimeSessionConfig } from './types.js';
import { RealtimeProviderError } from './types.js';

const GEMINI_BASE = (process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview'; // a Live-API audio model
// Ephemeral tokens require the v1alpha BidiGenerateContent WS endpoint.
const WS_URL = `${GEMINI_BASE.replace(/^http/, 'ws')}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`;

/**
 * Build the CONSTRAINED auth-token request (ADR 0141 RT-5 / Gemini option A): lock the model +
 * system instruction + the agent's tools server-side via `liveConnectConstraints`, so a tampered
 * browser cannot self-grant tools or change the persona. Gemini has no sideband, so tool
 * EXECUTION + the transcript still terminate in the browser — this hardens the CONFIG, not those
 * (lower assurance; the admin UI labels it). Pure — unit-tested.
 */
export function buildGeminiConstraint(model: string, instructions: string, tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>): Record<string, unknown> {
  const functionDeclarations = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return {
    uses: 1,
    liveConnectConstraints: {
      model: `models/${model}`,
      config: {
        responseModalities: ['AUDIO'],
        systemInstruction: { parts: [{ text: instructions }] },
        ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
      },
    },
    lockAdditionalFields: [],
  };
}

export const geminiLiveProvider: RealtimeProvider = {
  id: 'gemini-live',
  defaultModel: DEFAULT_MODEL,
  async createSession(input: CreateRealtimeSessionInput): Promise<RealtimeSessionConfig> {
    const model = input.model ?? DEFAULT_MODEL;

    if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
      return {
        provider: 'gemini-live', model, ...(input.voice ? { voice: input.voice } : {}),
        token: 'auth_tokens/test_gemini', connect: { kind: 'websocket', url: WS_URL },
        instructions: input.instructions, tools: input.tools,
      };
    }

    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE}/v1alpha/authTokens?key=${encodeURIComponent(input.apiKey)}`, {
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
      instructions: input.instructions, tools: input.tools,
    };
  },
};
