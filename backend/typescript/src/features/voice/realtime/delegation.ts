/**
 * Spoken delegation (ADR 0304 D1) — the host-side SESSION-CONTROL tools that let the
 * active realtime agent hand a question to another roster agent IN THE SAME live call.
 *
 * OpenAI-realtime ONLY: the sideband owns the session (RT-4) and `session.update` can
 * re-instruct + re-voice it mid-call; Gemini Live's token-locked constrained setup
 * cannot (RT-7), so these tools are never declared there — an honest capability gap,
 * not a workaround.
 *
 * These are NOT agent capabilities: they are never in any allowlist, never reach the
 * Capability Firewall or `executeTool`, and exist only inside the sideband's event
 * loop. The DELEGATED agent, however, is a REAL agent — its instructions come from the
 * same `composeRealtimeInstructions`, its voice from `resolveAgentVoice`, and its tool
 * projection from `resolveAgentToolDecls`; while it holds the floor the session's
 * bound agent id is swapped so the ADR 0142 boundary enforces ITS allowlist (the
 * delegator's tools are removed — no privilege union).
 *
 * Return semantics (ADR 0304 D1.5): ONE-SHOT — after the target's `response.done` the
 * sideband silently restores the home agent; `voice__return_to_agent` lets the target
 * hand back early. Nested delegation is refused (the delegate tool is not declared
 * while delegated).
 */
import type { RealtimeToolDecl } from './types.js';

/** Wire-safe names (already `[a-zA-Z0-9_-]` — no #578 sanitization round-trip needed). */
export const DELEGATE_TOOL = 'voice__delegate_to_agent';
export const RETURN_TOOL = 'voice__return_to_agent';

/** An agent the current speaker may delegate to (enumerated into the tool schema so
 *  the model calls by id, never by fuzzy name). */
export interface DelegableAgent {
  agentId: string;
  persona: string;
}

/** The full session config for one speaker — captured for the home agent at mint,
 *  composed for a target at delegation time. `tools` are provider WIRE decls. */
export interface SpeakerSnapshot {
  agentId?: string;
  instructions: string;
  tools: ReadonlyArray<Record<string, unknown>>;
  voice?: string;
}

export function buildDelegateToolDecl(delegable: readonly DelegableAgent[]): RealtimeToolDecl {
  return {
    name: DELEGATE_TOOL,
    description:
      'Hand the conversation to another agent on this workspace roster to answer one question in their own voice. '
      + 'Use it when the user asks for someone else, or when a question is squarely in a colleague\'s domain. '
      + `Available agents: ${delegable.map((d) => `${d.persona} (id: ${d.agentId})`).join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', enum: delegable.map((d) => d.agentId), description: 'The roster agent to hand the floor to.' },
        question: { type: 'string', description: 'The question they should answer, in one or two sentences.' },
      },
      required: ['agentId', 'question'],
    },
  };
}

export function buildReturnToolDecl(homePersona: string): RealtimeToolDecl {
  return {
    name: RETURN_TOOL,
    description: `Hand the conversation back to ${homePersona} once your delegated answer is complete.`,
    parameters: { type: 'object', properties: {} },
  };
}

/** Per-call delegation state. `phase` tracks the response lifecycle so the ONE-SHOT
 *  return triggers on the DELEGATED answer's `response.done`, not the tool-calling
 *  response that requested it (and not a mid-answer tool round-trip). */
export interface DelegationState {
  home: SpeakerSnapshot;
  delegate?: { agentId: string; persona: string; phase: 'requested' | 'answering' };
}

const states = new Map<string, DelegationState>();

export function armDelegation(callId: string, home: SpeakerSnapshot): void {
  states.set(callId, { home });
}
export function delegationStateOf(callId: string): DelegationState | undefined {
  return states.get(callId);
}
export function clearDelegation(callId: string): void {
  states.delete(callId);
}
