/**
 * ADR 0414 M3-2 (KickTodo B2) — collision-checked mention handle on the roster
 * rename path.
 *
 * The chat @-mention picker keys on persona text, so a rename that takes
 * another same-tenant agent's (case-insensitive) persona would make mentions
 * ambiguous — and would let a user-renamed agent (KickBot) impersonate an
 * existing coworker. Covers: collision refused (service throw + route 409),
 * case-insensitive matching, self-rename no-op allowed, unique rename allowed,
 * and rename continuity (rosterId/roleKey untouched by a successful rename).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createRosterEntry,
  getRosterEntry,
  updateRosterEntry,
  PersonaCollisionError,
} from '../src/host/rosterService.js';

const TENANT = 'tenant-persona';

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

afterEach(() => {
  __resetHostExtPersistence();
});

const AGENT = { kind: 'manifest', agentId: 'core.openwop.agents.react' } as const;

describe('persona rename collision (ADR 0414 M3-2)', () => {
  it('renaming onto another agent\'s persona is refused, case-insensitively', async () => {
    await createRosterEntry({ tenantId: TENANT, persona: 'Iris', agentRef: AGENT });
    const bot = await createRosterEntry({ tenantId: TENANT, persona: 'KickBot', agentRef: AGENT, roleKey: 'kicktodo-guide' });

    await expect(updateRosterEntry(TENANT, bot.rosterId, { persona: 'Iris' })).rejects.toBeInstanceOf(PersonaCollisionError);
    await expect(updateRosterEntry(TENANT, bot.rosterId, { persona: '  iris ' })).rejects.toBeInstanceOf(PersonaCollisionError);

    // The refused rename left the entry untouched.
    expect((await getRosterEntry(TENANT, bot.rosterId))?.persona).toBe('KickBot');
  });

  it('self-rename (case tweak) and unique renames are allowed; identity fields survive', async () => {
    const bot = await createRosterEntry({ tenantId: TENANT, persona: 'KickBot', agentRef: AGENT, roleKey: 'kicktodo-guide' });

    const caseTweak = await updateRosterEntry(TENANT, bot.rosterId, { persona: 'kickbot' });
    expect(caseTweak?.persona).toBe('kickbot');

    const renamed = await updateRosterEntry(TENANT, bot.rosterId, { persona: 'Coach Ada', label: 'Coach Ada' });
    expect(renamed?.persona).toBe('Coach Ada');
    // Rename continuity is structural: stable identity fields never change.
    expect(renamed?.rosterId).toBe(bot.rosterId);
    expect(renamed?.roleKey).toBe('kicktodo-guide');
    expect(renamed?.agentRef).toEqual(bot.agentRef);
  });

  it('the same persona in a DIFFERENT tenant does not collide', async () => {
    await createRosterEntry({ tenantId: 'tenant-other', persona: 'Iris', agentRef: AGENT });
    const bot = await createRosterEntry({ tenantId: TENANT, persona: 'KickBot', agentRef: AGENT });
    const renamed = await updateRosterEntry(TENANT, bot.rosterId, { persona: 'Iris' });
    expect(renamed?.persona).toBe('Iris');
  });
});
