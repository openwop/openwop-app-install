/**
 * `ADR 0603 R1 H1` — the OTHER two prune-on-read binding wipes.
 *
 * `TWIN-UX-10` (ADR 0589) hardened `getProfileKnowledge` against a durable erasure
 * on a GET and named the harm in its own comment. It did not reach the two
 * siblings running the identical shape:
 *
 *   - `getAgentKnowledge` (`features/agent-knowledge/service.ts`) — writes
 *     `setAgentKnowledge(…, { collectionIds: liveIds })` whenever fewer ids
 *     resolved than are bound, landing through `agentProfileService`'s
 *     whole-patch spread;
 *   - `getProjectKnowledge` (`features/projects/projectKnowledgeService.ts`) —
 *     the same, landing through `subjectKnowledge`'s
 *     `collectionIds: patch.collectionIds ?? existing`. **This binding is what
 *     backs a NOTEBOOK's bound KB collections** (`notebooksService.ts`), so the
 *     blast radius is a notebook silently losing its sources on a read.
 *
 * The premise both rested on — "not in the tenant listing ⇒ deleted" — is not
 * safe: `listAllTenantCollections` reads a tenant SECONDARY INDEX, whose own
 * contract admits "the row is simply not enumerated this pass", and the
 * prefix-scan primitive under it SKIPS any row whose decode fails without
 * throwing. One corrupt or schema-drifted index row was enough to overwrite the
 * whole binding with `[]` and return 200 with an empty knowledge panel.
 *
 * The cure is deliberately NOT a tenancy widening: the ADR 0042 ruling records
 * that widening the candidate set of exactly this self-heal turns it into a
 * data-loss machine, because "not visible from here" is indistinguishable from
 * "gone". It is also deliberately NOT a length gate at the write layer —
 * `unbindCollection` legitimately writes `[]` when the last collection is removed,
 * so gating there would trade a destructive write for a silent no-op.
 *
 * @see backend/typescript/src/host/knowledgeBindingPrune.ts
 * @see docs/adr/0603-podcasts-destructive-mix-and-deferred-param-aliases.md
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { mayPruneKnowledgeBinding } from '../src/host/knowledgeBindingPrune.js';
import { getAgentKnowledge } from '../src/features/agent-knowledge/service.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js'; // ADR 0643 R4 Blocker 2 — `getAgentKnowledge` takes a REQUIRED caller; a test reading its own unbound seed spells the bypass
import { getAgentProfile, setAgentKnowledge } from '../src/host/agentProfileService.js';
import { getProjectKnowledge } from '../src/features/projects/projectKnowledgeService.js';
import { getSubjectKnowledge, setSubjectKnowledge } from '../src/host/subjectKnowledge.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import { createCollection } from '../src/features/kb/kbService.js';

const T = 'org:kbp-guard';
const INIT = { roleKey: 'analyst', autonomy: { specLevel: 'draft-only' as const } };

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('the shared rule', () => {
  it('refuses on a wiped listing, refuses on a non-authoritative one, and still prunes otherwise', () => {
    // Refuses — the empty listing is indistinguishable from a wiped index.
    expect(mayPruneKnowledgeBinding({ boundIds: ['a', 'b'], listingSize: 0, liveIds: [] })).toBe(false);
    // Refuses — the caller could not read the listing at all.
    expect(mayPruneKnowledgeBinding({ boundIds: ['a', 'b'], listingSize: 5, liveIds: ['a'], authoritative: false })).toBe(false);
    // POSITIVE CONTROL: without this the two above would be satisfied by a rule
    // that always returns false, i.e. by deleting the self-heal outright.
    expect(mayPruneKnowledgeBinding({ boundIds: ['a', 'b'], listingSize: 5, liveIds: ['a'] })).toBe(true);
    // And it is a no-op when nothing is dangling.
    expect(mayPruneKnowledgeBinding({ boundIds: ['a'], listingSize: 5, liveIds: ['a'] })).toBe(false);
    // An EMPTY binding with an empty listing is not "wiped" — there is nothing to
    // lose, and nothing to prune either.
    expect(mayPruneKnowledgeBinding({ boundIds: [], listingSize: 0, liveIds: [] })).toBe(false);
  });
});

describe('H1a — `getAgentKnowledge` does not unbind an agent on a read', () => {
  const AGENT = 'agent-kbp';

  it('does NOT prune when the tenant listing comes back empty while bindings exist', async () => {
    await setAgentKnowledge(T, AGENT, { collectionIds: ['col-a', 'col-b'] }, INIT);

    const view = await getAgentKnowledge(T, AGENT, PREAUTHORIZED_CALLER);
    expect(view.collections).toEqual([]);

    // THE assertion. Before the guard this GET wrote `collectionIds: []`.
    const after = await getAgentProfile(T, AGENT);
    expect(
      after?.knowledge?.collectionIds,
      'an empty listing is indistinguishable from a wiped index — never prune on it',
    ).toEqual(['col-a', 'col-b']);
  });

  it('DOES prune a genuinely dangling binding once the listing is authoritative', async () => {
    // The positive control: without it the assertion above would pass against a
    // prune that simply never runs.
    const col = await createCollection(T, 'org-1', 'actor', { name: 'Agent real' });
    await setAgentKnowledge(T, AGENT, { collectionIds: [col.collectionId, 'col-gone'] }, INIT);

    const view = await getAgentKnowledge(T, AGENT, PREAUTHORIZED_CALLER);
    expect(view.collections.map((c) => c.collectionId)).toEqual([col.collectionId]);

    const after = await getAgentProfile(T, AGENT);
    expect(after?.knowledge?.collectionIds).toEqual([col.collectionId]);
  });
});

describe('H1b — `getProjectKnowledge` does not unbind a project (and so a notebook) on a read', () => {
  const PROJECT = 'proj-kbp';

  it('does NOT prune when the tenant listing comes back empty while bindings exist', async () => {
    const T2 = 'org:kbp-guard-proj'; // its own tenant: the sibling test above creates a collection
    await setSubjectKnowledge(T2, projectSubject(PROJECT), { collectionIds: ['col-a', 'col-b'] });

    const view = await getProjectKnowledge(T2, PROJECT);
    expect(view.collections).toEqual([]);

    const after = await getSubjectKnowledge(T2, projectSubject(PROJECT));
    expect(
      after.collectionIds,
      'a notebook losing its bound sources to a GET is not recoverable',
    ).toEqual(['col-a', 'col-b']);
  });

  it('DOES prune a genuinely dangling binding once the listing is authoritative', async () => {
    const col = await createCollection(T, 'org-1', 'actor', { name: 'Project real' });
    await setSubjectKnowledge(T, projectSubject(PROJECT), { collectionIds: [col.collectionId, 'col-gone'] });

    const view = await getProjectKnowledge(T, PROJECT);
    expect(view.collections.map((c) => c.collectionId)).toEqual([col.collectionId]);

    const after = await getSubjectKnowledge(T, projectSubject(PROJECT));
    expect(after.collectionIds).toEqual([col.collectionId]);
  });
});
