/**
 * ADR 0775 D5 — the roster cascade deletes only what it owns, evicts what it
 * deletes, and deletes the row AFTER its dependents.
 *
 *  - `ARWF-6`: `POST /roster` accepts any agentRef, so two members may share one
 *    `user.*` chat agent. Deleting one used to delete the shared agent from
 *    storage (and leave it live in the registry on this instance), and name it
 *    to the lifecycle hooks, which disabled the SURVIVOR's widgets.
 *  - `ARWF-12`: the row was deleted FIRST, so a throw in a later sweep returned
 *    500 and the route's 404 pre-check refused every retry — orphans stranded.
 *
 * Breaks it (round-1 probes, all witnessed, `host/rosterCascade.ts`): the
 * `!stillReferenced` guard forced true (8fw2g2-rcs-shared) or the registry
 * eviction dropped (rcs-evict) or the agentId named to the hooks while the agent
 * is still shared (rcs-hooks) — each reds case 1; deleting the roster row
 * before the sweeps (rcs-roworder) reds case 2.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ twin: false }));
vi.mock('../src/host/twinService.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/twinService.js')>();
  return {
    ...real,
    clearTwinGrantsForAgent: async (...args: Parameters<typeof real.clearTwinGrantsForAgent>) => {
      if (fault.twin) throw new Error('injected twin-grant sweep failure');
      return real.clearTwinGrantsForAgent(...args);
    },
  };
});

import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { createRosterEntry, getRosterEntry } from '../src/host/rosterService.js';
import { deleteRosterMemberCascade } from '../src/host/rosterCascade.js';
import { onRosterMemberDeleted, __resetRosterLifecycleHooks } from '../src/host/rosterLifecycle.js';
import { getAgentProfile, upsertAgentProfile } from '../src/host/agentProfileService.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';

const T = 'ws-cascade-shared';
let storage: Storage;
const retired: Array<string | undefined> = [];

async function userAgent(agentId: string): Promise<void> {
  await storage.insertUserAgent({
    agentId, tenantId: T, persona: agentId, modelClass: 'general', systemPrompt: 'x', toolAllowlist: [],
    memoryShape: { scratchpad: false, conversation: false, longTerm: false }, createdAt: new Date().toISOString(),
  });
  const manifest: ResolvedAgentManifest = {
    agentId, persona: agentId, modelClass: 'general', systemPrompt: 'x', packName: 'user', packVersion: '0', toolAllowlist: [], ownerTenant: T,
  };
  getAgentRegistry().register(manifest);
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  onRosterMemberDeleted('test-probe', async (e) => { retired.push(e.agentId); });
});
afterAll(() => {
  __resetRosterLifecycleHooks();
  getAgentRegistry()._resetForTest();
  __resetHostExtPersistence();
});

describe('ADR 0775 D5 — a shared chat agent survives until its last member goes', () => {
  it('deleting one sharer keeps the agent (storage + registry) and does not name it to the hooks; the last one retires it', async () => {
    await userAgent('user.shared-twin');
    const a = await createRosterEntry({ tenantId: T, persona: 'Sharer A', agentRef: { agentId: 'user.shared-twin' } });
    const b = await createRosterEntry({ tenantId: T, persona: 'Sharer B', agentRef: { agentId: 'user.shared-twin' } });

    retired.length = 0;
    const first = await deleteRosterMemberCascade(T, storage, a.rosterId);
    expect(first.chatAgentDeleted).toBe(false);
    expect(await storage.getUserAgent(T, 'user.shared-twin'), 'B still uses it').not.toBeNull();
    expect(getAgentRegistry().get('user.shared-twin', T)).not.toBeNull();
    expect(retired, 'naming it would disable B’s widgets and pause B’s chats').toEqual([undefined]);

    retired.length = 0;
    const last = await deleteRosterMemberCascade(T, storage, b.rosterId);
    expect(last.chatAgentDeleted).toBe(true);
    expect(await storage.getUserAgent(T, 'user.shared-twin')).toBeNull();
    expect(getAgentRegistry().get('user.shared-twin', T), 'evicted from this instance, not served until restart').toBeNull();
    expect(retired).toEqual(['user.shared-twin']);
  });
});

describe('ADR 0775 D5 — the row goes after its dependents', () => {
  it('a sweep failure leaves the roster row, so the retry re-runs the whole cascade', async () => {
    await userAgent('user.fragile');
    const m = await createRosterEntry({ tenantId: T, persona: 'Fragile', agentRef: { agentId: 'user.fragile' } });
    await upsertAgentProfile(T, m.rosterId, { roleKey: 'analyst', autonomy: { specLevel: 'draft-only' } });

    fault.twin = true;
    await expect(deleteRosterMemberCascade(T, storage, m.rosterId)).rejects.toThrow(/injected/);
    fault.twin = false;
    // Before ADR 0775 the row was already gone here, and `DELETE /roster/:id`
    // 404'd every retry. Now it survives the failure…
    expect(await getRosterEntry(T, m.rosterId), 'the row must outlive a failed sweep').not.toBeNull();
    expect(await storage.getUserAgent(T, 'user.fragile'), 'nothing past the failure ran').not.toBeNull();

    // …so the retry completes the cascade.
    const retry = await deleteRosterMemberCascade(T, storage, m.rosterId);
    expect(retry.chatAgentDeleted).toBe(true);
    expect(await getRosterEntry(T, m.rosterId)).toBeNull();
    expect(await getAgentProfile(T, m.rosterId)).toBeNull();
    expect(await storage.getUserAgent(T, 'user.fragile')).toBeNull();
  });
});
