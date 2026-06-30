/**
 * Real-time voice provider abstraction (ADR 0141). Two adapters — `openai-realtime`
 * and `gemini-live` — behind one interface, so the route + the browser are
 * provider-agnostic. The host mints a short-lived EPHEMERAL token from the tenant's
 * BYOK key; the long-lived key never leaves the host (ADR 0141 §Security).
 */

export type RealtimeProviderId = 'openai-realtime' | 'gemini-live';

/** A tool the realtime model may call, projected to a provider-neutral declaration.
 *  The host bridge (RT-2) executes the call through the existing RBAC/firewall/HITL. */
export interface RealtimeToolDecl {
  name: string;
  description: string;
  /** JSON-Schema for the tool's parameters (provider adapters map to native shape). */
  parameters: Record<string, unknown>;
}

/** Everything the browser needs to open the live session, after the host mints the token. */
export interface RealtimeSessionConfig {
  provider: RealtimeProviderId;
  model: string;
  voice?: string;
  /** The ephemeral, scoped token the browser connects with (NOT the BYOK key). */
  token: string;
  /** ISO expiry of the ephemeral token, when the provider returns one. */
  expiresAt?: string;
  /** How + where the browser connects. */
  connect: { kind: 'webrtc' | 'websocket'; url: string };
  /** The agent's persona — the realtime model's system instructions. */
  instructions: string;
  /** The agent's allowed tools (provider-neutral; the client maps + the host executes). */
  tools: RealtimeToolDecl[];
}

export interface CreateRealtimeSessionInput {
  /** The tenant BYOK key (resolved host-side; used ONLY to mint the ephemeral token). */
  apiKey: string;
  model?: string;
  voice?: string;
  instructions: string;
  tools: RealtimeToolDecl[];
}

/** A realtime provider adapter. `createSession` mints the ephemeral token (calling the
 *  provider's token API with the BYOK key) and returns the browser session config. */
export interface RealtimeProvider {
  id: RealtimeProviderId;
  defaultModel: string;
  createSession(input: CreateRealtimeSessionInput): Promise<RealtimeSessionConfig>;
}

/** Thrown when a provider's token API rejects (bad key, quota, etc.) — mapped to a clean
 *  host error so the route surfaces an actionable message instead of a 500. */
export class RealtimeProviderError extends Error {
  constructor(public readonly provider: RealtimeProviderId, message: string, public readonly status?: number) {
    super(message);
    this.name = 'RealtimeProviderError';
  }
}
