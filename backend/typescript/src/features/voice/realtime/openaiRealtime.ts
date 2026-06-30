/**
 * OpenAI Realtime adapter (ADR 0141) — speech-to-speech over WebRTC.
 *
 * Mints a short-lived ephemeral client secret from the tenant BYOK key via
 * `POST /v1/realtime/client_secrets` (the documented 2026 flow), baking the agent's
 * model + instructions + voice + tools into the server-side session payload so they
 * never depend on browser-supplied config. The browser then opens WebRTC to the
 * realtime calls endpoint using ONLY the ephemeral secret.
 *
 * ⚠ The provider request/response shape is written to OpenAI's current docs but is
 * VERIFY-WITH-KEY (no key/network here). Under OPENWOP_TEST_SEAM_ENABLED it returns a
 * deterministic mock so the route is testable without a key.
 */
import type { CreateRealtimeSessionInput, RealtimeProvider, RealtimeSessionConfig } from './types.js';
import { RealtimeProviderError } from './types.js';

const OPENAI_BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
const DEFAULT_MODEL = 'gpt-realtime';

export const openaiRealtimeProvider: RealtimeProvider = {
  id: 'openai-realtime',
  defaultModel: DEFAULT_MODEL,
  async createSession(input: CreateRealtimeSessionInput): Promise<RealtimeSessionConfig> {
    const model = input.model ?? DEFAULT_MODEL;
    const connectUrl = `${OPENAI_BASE}/v1/realtime/calls`;

    // Deterministic mock under the test seam (no key/network).
    if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
      return {
        provider: 'openai-realtime', model, ...(input.voice ? { voice: input.voice } : {}),
        token: 'ek_test_openai', connect: { kind: 'webrtc', url: connectUrl },
        instructions: input.instructions, tools: input.tools,
      };
    }

    // The server-side session payload — instructions/voice/tools baked in (kept off the browser).
    const body = {
      session: {
        type: 'realtime',
        model,
        instructions: input.instructions,
        ...(input.voice ? { audio: { output: { voice: input.voice } } } : {}),
        tools: input.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
      },
    };
    let res: Response;
    try {
      res = await fetch(`${OPENAI_BASE}/v1/realtime/client_secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new RealtimeProviderError('openai-realtime', `Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 300);
      throw new RealtimeProviderError('openai-realtime', `OpenAI rejected the realtime session (${res.status}): ${snippet}`, res.status);
    }
    const j = (await res.json().catch(() => ({}))) as { value?: string; client_secret?: { value?: string }; expires_at?: number };
    const token = j.value ?? j.client_secret?.value;
    if (!token) throw new RealtimeProviderError('openai-realtime', 'OpenAI returned no ephemeral client secret.');
    return {
      provider: 'openai-realtime', model, ...(input.voice ? { voice: input.voice } : {}),
      token,
      ...(j.expires_at ? { expiresAt: new Date(j.expires_at * 1000).toISOString() } : {}),
      connect: { kind: 'webrtc', url: connectUrl },
      instructions: input.instructions, tools: input.tools,
    };
  },
};
