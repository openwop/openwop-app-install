/**
 * The `assistant` capability — core-agent level, activated per named agent
 * (David's architecture law, 2026-06-13; `features/assistant/capability.ts` +
 * the ADR 0023 correction). Proves the assistant runtime resolves the acting /
 * writing agent by the profile CAPABILITY, NEVER by `roleKey 'chief-of-staff'`:
 *   - a non-chief-of-staff agent with the capability DOES participate;
 *   - a chief-of-staff-shaped agent WITHOUT the capability does NOT;
 *   - Iris and Executive Operations both activate via their profiles;
 *   - the bootstrap default self-heals to a capability flag (back-compat).
 */

import { beforeEach, describe, expect, it } from 'vitest';
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
  agentHasAssistantCapability,
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
    const iris = await makeAgent(t, 'chief-of-staff', true);
    const exec = await makeAgent(t, 'executive-ops', true);

    const capable = await listCapabilityAgents(t, ASSISTANT_CAPABILITY);
    expect(new Set(capable.map((e) => e.rosterId))).toEqual(new Set([iris.rosterId, exec.rosterId]));

    // Deterministic primary (stable across calls — replay-safe).
    const first = await findAssistantAgent(t);
    const second = await findAssistantAgent(t);
    expect(first?.rosterId).toBe(second?.rosterId);
    expect([iris.rosterId, exec.rosterId]).toContain(first!.rosterId);
  });

  it('ensureAssistantAgent bootstraps the default holder and self-heals its capability flag', async () => {
    const t = 'tenant-cap-4';
    // No capability-activated agent yet.
    expect(await findAssistantAgent(t)).toBeNull();

    const bootstrapped = await ensureAssistantAgent(t);
    // The bootstrap stamped the capability onto its profile (data), so the next
    // resolution is pure-capability — no roleKey fallback needed.
    expect(await agentHasAssistantCapability(t, bootstrapped.rosterId)).toBe(true);
    expect((await findAssistantAgent(t))?.rosterId).toBe(bootstrapped.rosterId);

    // Idempotent: a second ensure resolves the same agent by capability.
    expect((await ensureAssistantAgent(t)).rosterId).toBe(bootstrapped.rosterId);
  });
});
