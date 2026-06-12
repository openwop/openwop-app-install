/**
 * The Chief of Staff IS a roster agent (ADR 0023 — corrected 2026-06-11).
 *
 * The original implementation claimed "named roster agent (RFC 0086) on the
 * same rails every agent uses" but never instantiated one (a literal
 * `rosterId:'assistant'`, tenant-scoped loops). First correction made it a real
 * `RosterEntry`; this one removes the feature's OWN agent-creation code and
 * routes through the single seeder path instead (`ensureSeededAgentByRole`),
 * sourced from `demoAgents.json` — so there is exactly one way to create an
 * agent in this app, and the assistant doesn't hand-roll a parallel one.
 *
 * Identity is the persisted `roleKey === 'chief-of-staff'` (robust to a
 * user-renamed persona/label). The agent is ensured on demand (first loop
 * enable / action enqueue) so existing tenants get it without a re-seed.
 */

import { ensureSeededAgentByRole, findSeededAgentByRole } from '../../host/demoSeed.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import type { RosterEntry } from '../../host/rosterService.js';

/** The seed role key that identifies the Chief of Staff (see `demoAgents.json`). */
export const CHIEF_OF_STAFF_ROLE_KEY = 'chief-of-staff' as const;

/** Is this roster entry the tenant's Chief of Staff? (persisted seed roleKey). */
export function isChiefOfStaff(entry: Pick<RosterEntry, 'roleKey'>): boolean {
  return entry.roleKey === CHIEF_OF_STAFF_ROLE_KEY;
}

/**
 * The tenant's Chief-of-Staff roster member, created via the seeder if absent.
 * The assistant's loops + approvals call this to attribute to a REAL agent.
 */
export async function ensureChiefOfStaff(tenantId: string): Promise<RosterEntry> {
  const entry = await ensureSeededAgentByRole(tenantId, hostExtStorage(), CHIEF_OF_STAFF_ROLE_KEY);
  if (!entry) {
    // The seed spec for the role is missing — a build/seed-data misconfiguration.
    throw Object.assign(new Error("no 'chief-of-staff' agent spec in demoAgents.json"), { code: 'chief_of_staff_seed_missing' });
  }
  return entry;
}

/** Read-only lookup — the Chief of Staff's roster member if it exists, else null. */
export async function findChiefOfStaff(tenantId: string): Promise<RosterEntry | null> {
  return findSeededAgentByRole(tenantId, CHIEF_OF_STAFF_ROLE_KEY);
}
