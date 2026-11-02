/**
 * ADR 1001 D6 — an agent's clarification expires into a timeout skip, so the
 * agent finishes with what it has instead of the run waiting forever. Lazy on
 * every read of the run's open interrupts, and swept on the webhook worker tick
 * (`host/interruptExpiry.ts`) for a run nobody looks at.
 */
import { registerExpiringPromptProfile } from '../../host/interruptExpiry.js';
import { AGENT_CLARIFICATION_PROFILE, CLARIFICATION_EXPIRED_VALUE } from '../../host/clarificationLift.js';

export function registerAgentClarificationExpirySweep(): void {
  registerExpiringPromptProfile(AGENT_CLARIFICATION_PROFILE, CLARIFICATION_EXPIRED_VALUE, { sweep: true });
}
