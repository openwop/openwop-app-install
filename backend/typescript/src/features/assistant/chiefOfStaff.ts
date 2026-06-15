/**
 * @deprecated Back-compat shim. The assistant capability is no longer fused to
 * `roleKey === 'chief-of-staff'` — it is a CORE capability activated per agent
 * via `AgentProfile.capabilities` (David's law, 2026-06-13; see `capability.ts`
 * + the ADR 0023 correction note). New code should import from `./capability.js`
 * (`ensureAssistantAgent` / `findAssistantAgent`). These aliases remain only so
 * existing call sites/tests keep resolving the tenant's assistant-capability
 * agent — by capability, NOT by roleKey.
 */

import { ensureAssistantAgent, findAssistantAgent } from './capability.js';
import type { RosterEntry } from '../../host/rosterService.js';

/** @deprecated Use `ensureAssistantAgent` (capability-driven). */
export async function ensureChiefOfStaff(tenantId: string): Promise<RosterEntry> {
  return ensureAssistantAgent(tenantId);
}

/** @deprecated Use `findAssistantAgent` (capability-driven). Read-only; null if
 *  no agent in the tenant has the assistant capability activated. */
export async function findChiefOfStaff(tenantId: string): Promise<RosterEntry | null> {
  return findAssistantAgent(tenantId);
}
