/**
 * VoiceSession (ADR 0138 §1) — EPHEMERAL live-audio session state keyed to a chat
 * conversation. It holds the transport handle (current `streamRef`), the bound
 * agent/conversation, and per-session counters — NOT a second conversation store
 * (the RFC 0005 conversation remains the single owner of turns; ADR 0138 finding #7).
 * Read by deterministic POINT-GET (`get(${tenantId}:${sessionId})`), never `list()`
 * on the hot turn loop (finding #2). GC-able + exempt from replay.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { getAgentProfile } from '../../host/agentProfileService.js';

export interface VoiceSession {
  sessionId: string;
  tenantId: string;
  /** The RFC 0005 conversation this voice session drives (optional until bound in P2). */
  conversationId?: string;
  /** The agent the session is scoped to (the ADR 0058 voice persona, optional in P1). */
  agentId?: string;
  /** The current live-utterance handle (re-minted per turn). */
  streamRef: string;
  /** Host-internal transport floor (P1). WebSocket/WebRTC plug in behind the same model. */
  transport: 'http-chunked';
  status: 'open' | 'closed';
  turns: number;
  createdAt: string;
  updatedAt: string;
}

// Keyed by tenant+session → point-get, no cross-tenant scan (finding #2).
const sessions = new DurableCollection<VoiceSession>(
  'voice:session',
  (s) => `${s.tenantId}:${s.sessionId}`,
);

const keyOf = (tenantId: string, sessionId: string): string => `${tenantId}:${sessionId}`;

export interface CreateVoiceSessionInput {
  /** The session id, minted by the caller so the first stream buffer shares it. */
  sessionId: string;
  conversationId?: string;
  agentId?: string;
  streamRef: string;
}

export async function createVoiceSession(tenantId: string, input: CreateVoiceSessionInput): Promise<VoiceSession> {
  const now = new Date().toISOString();
  const session: VoiceSession = {
    sessionId: input.sessionId,
    tenantId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    streamRef: input.streamRef,
    transport: 'http-chunked',
    status: 'open',
    turns: 0,
    createdAt: now,
    updatedAt: now,
  };
  await sessions.put(session);
  return session;
}

/** Point-get a session, tenant-bound. Throws 404 (no existence oracle) when missing/closed. */
export async function getOpenVoiceSession(tenantId: string, sessionId: string): Promise<VoiceSession> {
  const s = await sessions.get(keyOf(tenantId, sessionId));
  if (!s || s.tenantId !== tenantId || s.status !== 'open') {
    throw new OpenwopError('not_found', 'Voice session not found.', 404, { sessionId });
  }
  return s;
}

/** Rotate the session to a fresh utterance handle + bump the turn counter (post-commit). */
export async function advanceVoiceSession(session: VoiceSession, nextStreamRef: string): Promise<VoiceSession> {
  const updated: VoiceSession = { ...session, streamRef: nextStreamRef, turns: session.turns + 1, updatedAt: new Date().toISOString() };
  await sessions.put(updated);
  return updated;
}

/** Close + remove the session (end of call). Idempotent. */
export async function closeVoiceSession(tenantId: string, sessionId: string): Promise<void> {
  await sessions.delete(keyOf(tenantId, sessionId));
}

/** The per-agent spoken voice (ADR 0138 P3 / user ask, 2026-06-25). Read from the
 *  agent's profile — the existing ADR 0031 agent-config seam (`configParameters.voice
 *  = { provider, voiceId }`), set in agent settings — NOT a new per-agent voice store. */
export interface AgentVoice {
  provider?: string;
  voiceId?: string;
  /** BYOK credential for a non-managed TTS provider (ElevenLabs/OpenAI/Google) — an opaque
   *  `credentialRef` into the tenant's BYOK store, resolved tenant-scoped in `/speak`. */
  credentialRef?: string;
}

export async function resolveAgentVoice(tenantId: string, agentId: string | undefined): Promise<AgentVoice | null> {
  if (!agentId) return null;
  const profile = await getAgentProfile(tenantId, agentId);
  const v = (profile?.configParameters as { voice?: unknown } | undefined)?.voice;
  if (!v || typeof v !== 'object') return null;
  const { provider, voiceId, credentialRef } = v as AgentVoice;
  return {
    ...(typeof provider === 'string' && provider ? { provider } : {}),
    ...(typeof voiceId === 'string' && voiceId ? { voiceId } : {}),
    ...(typeof credentialRef === 'string' && credentialRef ? { credentialRef } : {}),
  };
}
