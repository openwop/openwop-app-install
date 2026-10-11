/**
 * The `assistant` capability — core-agent level, activated per named agent
 * (David's architecture law, 2026-06-13; `features/assistant/capability.ts` +
 * the ADR 0023 correction). Proves the assistant runtime resolves the acting /
 * writing agent by the profile CAPABILITY, NEVER by `roleKey 'chief-of-staff'`:
 *   - a non-chief-of-staff agent with the capability DOES participate;
 *   - a chief-of-staff-shaped agent WITHOUT the capability does NOT;
 *   - Iris and Executive Operations both activate via their profiles;
 *   - the bootstrap default self-heals to a capability flag (back-compat).
 *
 * Sabotage-witnessed (/grade-tests w11, `features/assistant/capability.ts`):
 * dropping the `capabilities.includes` filter reds cases 1+2; reversing
 * `primaryOf`'s (createdAt, rosterId) order reds case 3; dropping the self-heal
 * `activateAgentCapability` reds case 4 (its pre-flag roster-agent leg — a FRESH
 * bootstrap is double-guarded, because the seed spec's profile already carries
 * the capability). The idempotence line is double-guarded too:
 * `ensureSeededAgentByRole` returns the existing roleKey entry, so removing the
 * `findAssistantAgent` short-circuit still resolves the same agent.
 */

import { getAgentProfile } from '../src/host/agentProfileService.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import {
  upsertAgentProfile,
  activateAgentCapability,
  __resetAgentProfileStore,
} from '../src/host/agentProfileService.js';
import {
  ASSISTANT_CAPABILITY,
  listCapabilityAgents,
  findAssistantAgent,
  ensureAssistantAgent,
} from '../src/features/assistant/capability.js';
import type { RosterEntry } from '../src/host/rosterService.js';

const storage = await openStorage('memory://');
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-capability-')) });

let seq = 0;
/** Create a roster agent; give it a profile with or without the capability. */
async function makeAgent(tenantId: string, roleKey: string, withCapability: boolean): Promise<RosterEntry> {
  const persona = `${roleKey}-${++seq}`;
  const entry = await createRosterEntry({
    tenantId,
    persona,
    agentRef: { agentId: `user.${tenantId}.${persona}`, version: '1.0.0' },
    roleKey,
  });
  if (withCapability) {
    await activateAgentCapability(tenantId, entry.rosterId, ASSISTANT_CAPABILITY, {
      roleKey,
      autonomy: { specLevel: 'recommend' },
    });
  } else {
    // A profile that exists but does NOT activate the capability.
    await upsertAgentProfile(tenantId, entry.rosterId, { roleKey, autonomy: { specLevel: 'recommend' } });
  }
  return entry;
}

beforeEach(async () => {
  await __resetAgentProfileStore();
});

describe('assistant capability — resolution is by capability, not roleKey', () => {
  it('a NON-chief-of-staff agent with the capability participates', async () => {
    const t = 'tenant-cap-1';
    const exec = await makeAgent(t, 'executive-ops', true);
    await makeAgent(t, 'finance-close', false); // has a profile, but no capability

    const capable = await listCapabilityAgents(t, ASSISTANT_CAPABILITY);
    expect(capable.map((e) => e.rosterId)).toEqual([exec.rosterId]);
    expect((await findAssistantAgent(t))?.rosterId).toBe(exec.rosterId);
  });

  it('a chief-of-staff-shaped agent WITHOUT the capability does NOT participate (no roleKey gate)', async () => {
    const t = 'tenant-cap-2';
    await makeAgent(t, 'chief-of-staff', false); // CoS roleKey, but capability OFF

    expect(await listCapabilityAgents(t, ASSISTANT_CAPABILITY)).toHaveLength(0);
    expect(await findAssistantAgent(t)).toBeNull();
  });

  it('Iris AND Executive Operations both activate via their profiles', async () => {
    const t = 'tenant-cap-3';
    // Exec is created EARLIER but sorts LATER by rosterId (`host:executive-ops-…` >
    // `host:chief-of-staff-…`), so only the documented rule — earliest createdAt
    // first, rosterId as tie-break — picks exec. Only `Date` is faked.
    vi.useFakeTimers({ toFake: ['Date'] });
    let iris: RosterEntry;
    let exec: RosterEntry;
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      exec = await makeAgent(t, 'executive-ops', true);
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      iris = await makeAgent(t, 'chief-of-staff', true);
    } finally {
      vi.useRealTimers();
    }

    const capable = await listCapabilityAgents(t, ASSISTANT_CAPABILITY);
    expect(new Set(capable.map((e) => e.rosterId))).toEqual(new Set([iris.rosterId, exec.rosterId]));

    // Deterministic primary (stable across calls — replay-safe).
    const first = await findAssistantAgent(t);
    const second = await findAssistantAgent(t);
    expect(first?.rosterId).toBe(second?.rosterId);
    expect(first?.rosterId, 'the earliest-created capable agent is primary').toBe(exec.rosterId);
  });

  it('ensureAssistantAgent bootstraps the default holder and self-heals its capability flag', async () => {
    const t = 'tenant-cap-4';
    // No capability-activated agent yet.
    expect(await findAssistantAgent(t)).toBeNull();

    const bootstrapped = await ensureAssistantAgent(t);
    // The bootstrap stamped the capability onto its profile (data), so the next
    // resolution is pure-capability — no roleKey fallback needed.
    //
    // ADR 0662 D4 — this used to assert `agentHasAssistantCapability`, a predicate with no
    // production caller: the test proved a function nothing used, which is how an inert
    // predicate keeps looking load-bearing. Assert the REAL contract instead — ADR 0023
    // §Correction says the capability's job is to RESOLVE the acting agent — by reading the
    // profile the bootstrap stamped and then resolving through it.
    const profile = await getAgentProfile(t, bootstrapped.rosterId);
    expect(profile?.capabilities, 'the bootstrap stamps the capability onto the profile').toContain(ASSISTANT_CAPABILITY);
    expect((await findAssistantAgent(t))?.rosterId).toBe(bootstrapped.rosterId);

    // Idempotent: a second ensure resolves the same agent by capability.
    expect((await ensureAssistantAgent(t)).rosterId).toBe(bootstrapped.rosterId);

    // The SELF-HEAL leg proper: a tenant whose default-role agent predates the flag
    // (a chief-of-staff roster entry whose profile does NOT carry the capability).
    // The bootstrap must reuse that agent and stamp the capability onto it.
    const legacyTenant = 'tenant-cap-5';
    const legacy = await makeAgent(legacyTenant, 'chief-of-staff', false);
    expect(await findAssistantAgent(legacyTenant)).toBeNull();
    const healed = await ensureAssistantAgent(legacyTenant);
    expect(healed.rosterId).toBe(legacy.rosterId);
    expect((await getAgentProfile(legacyTenant, legacy.rosterId))?.capabilities).toContain(ASSISTANT_CAPABILITY);
    expect((await findAssistantAgent(legacyTenant))?.rosterId).toBe(legacy.rosterId);
  });
});
