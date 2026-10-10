/**
 * TWIN-UX-10 — a GET must not permanently unbind a person's documents.
 *
 * `getProfileKnowledge` self-heals a dangling binding by PRUNING it on read — a
 * durable write on a GET. The prune could not tell an authoritative "that
 * collection is gone" from a degraded read: `listAllTenantCollections` scans a
 * tenant SECONDARY INDEX, so an empty or partial answer is reachable without a
 * throw. The result was the absence-is-a-claim family with a write attached, and
 * the tab then renders the shared empty state, which cannot distinguish "you
 * bound nothing" from "we just unbound you."
 *
 * The guard is resolved in the NON-DESTRUCTIVE direction: an unpruned dangling
 * binding is recoverable; an unbound document set is not.
 *
 * This file pins the profile-memory WIRING of the shared rule
 * (`host/knowledgeBindingPrune.ts`, unit-pinned in
 * `knowledge-binding-prune-guard.test.ts`). Each case owns its tenant AND its user
 * (the profile store is keyed by the globally-unique userId), so neither depends on
 * the other's collections or run order.
 *
 * Sabotage that turns it red:
 *   - `listingSize: collectionIds.length` at the profile call site → case 1
 *     (w3g2-prune-wiring)
 *   - dropping the `setProfileKnowledge(…, { collectionIds: liveIds })` prune write
 *     → case 2 (w3g2-prune-positive)
 *
 * @see docs/adr/0589-twin-tenancy-and-recall-audience.md
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { getProfileKnowledge } from '../src/features/profile-memory/profileKnowledgeService.js';
import { getOrCreateProfile, setProfileKnowledge, getProfile } from '../src/features/profiles/profilesService.js';
import { createCollection } from '../src/features/kb/kbService.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('TWIN-UX-10 — the prune-on-read is guarded', () => {
  it('does NOT prune when the tenant listing comes back empty while bindings exist', async () => {
    const T = 'org:pk-prune-wiped'; // a tenant with NO collections: the listing is empty
    const USER = 'user:pk-prune-wiped';
    await getOrCreateProfile(T, USER);
    await setProfileKnowledge(T, USER, { collectionIds: ['col-a', 'col-b'] });

    const view = await getProfileKnowledge(T, USER);
    expect(view.collections).toEqual([]);

    // THE assertion. Before the guard, this GET wrote `collectionIds: []` — the
    // user's bindings destroyed by a read, reported as an empty success.
    const after = await getProfile(T, USER);
    expect(
      after?.knowledge?.collectionIds,
      'an empty listing is indistinguishable from a wiped index — never prune on it',
    ).toEqual(['col-a', 'col-b']);
  });

  it('DOES prune a genuinely dangling binding once the listing is authoritative', async () => {
    // The positive control. Without it the assertion above would pass against a
    // prune that simply never runs — which is the same "green means nothing"
    // shape the guard exists to end.
    const T = 'org:pk-prune-dangling';
    const USER = 'user:pk-prune-dangling';
    await getOrCreateProfile(T, USER);
    const col = await createCollection(T, 'org-1', 'actor', { name: 'Real' });
    await setProfileKnowledge(T, USER, { collectionIds: [col.collectionId, 'col-gone'] });

    const view = await getProfileKnowledge(T, USER);
    expect(view.collections.map((c) => c.collectionId)).toEqual([col.collectionId]);

    const after = await getProfile(T, USER);
    expect(after?.knowledge?.collectionIds).toEqual([col.collectionId]);
  });
});
