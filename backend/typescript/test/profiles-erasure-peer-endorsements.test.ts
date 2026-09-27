/**
 * ADR 0624 D5 / PROF-8 — subject erasure reaches PEERS' rows: an erased user's
 * id is stripped from every `skills[].endorsements` in the erasing tenant.
 *
 * Why: `setEndorsement` writes the ENDORSER's id into the TARGET's row and
 * nothing ever removed it, so an erased subject's id survived in every peer's
 * endorsements forever (the ADR 0464 ratchet is keyed on the subject's OWN row
 * and cannot see the embedding), and departed endorsers inflated counts.
 *
 * Pinned:
 *   - erase the ENDORSER → the target's count drops and the id is gone
 *     (through the service AND through the registered eraser fan-out, which
 *     now reports the peer rows as `rowsTouched`);
 *   - an endorser with NO own row is still stripped (an endorser never needs
 *     a materialised profile);
 *   - an EMAIL key never scans (`listForTenantIndexed` not called);
 *   - `'unchanged'` writes nothing: erasing a user who endorsed nobody makes
 *     ZERO CAS writes (the pre-filter) and no `put`;
 *   - reach is the ERASING tenant only — an endorsement the subject gave in a
 *     different tenant survives (stated honestly, WF-TWIN-3);
 *   - the strip is SILENT (no `endorsement.removed` fan-out; the users `erased`
 *     event names the person).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { DurableCollection, initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initHostEventDispatcher, __clearHostEventBindings, __resetHostEventDispatcher, type HostEventEnvelope } from '../src/host/hostEventDispatcher.js';
import { registeredSubjectEraserIds } from '../src/host/subjectErasure.js';
import {
  __resetProfiles,
  deleteSubjectProfile,
  eraseProfileSubject,
  getOrCreateProfile,
  getProfile,
  profileEraser,
  setEndorsement,
  setOwnSkills,
  stripEndorsementsBy,
} from '../src/features/profiles/profilesService.js';
import { buildProfilesSurface } from '../src/features/profiles/surface.js';

const T = 'org:prof-erase-t1';
const T2 = 'org:prof-erase-t2';
const ALICE = 'user:pe-alice';
const BOB = 'user:pe-bob';
const CAROL = 'user:pe-carol';
let storage: Storage;
let delivered: HostEventEnvelope[];
const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearHostEventBindings();
  await __resetProfiles();
  delivered = [];
  initHostEventDispatcher({ storage, hostSuite, deliverWebhooks: async (e) => { delivered.push(e); }, startRun: async () => null });
  // Alice has a skill; Bob (with an own row) and Carol (NO own row) endorse it.
  await getOrCreateProfile(T, ALICE);
  await setOwnSkills(T, ALICE, [{ name: 'TypeScript', proficiency: 4 }, { name: 'Go', proficiency: 2 }]);
  await getOrCreateProfile(T, BOB);
  await setEndorsement(T, ALICE, 'TypeScript', BOB, true);
  await setEndorsement(T, ALICE, 'Go', BOB, true);
  await setEndorsement(T, ALICE, 'TypeScript', CAROL, true);
  await settle();
  delivered = [];
});
afterEach(() => { vi.restoreAllMocks(); __resetHostEventDispatcher(); __resetHostExtPersistence(); });

const endorsers = async (tenantId: string, userId: string, skill: string): Promise<string[]> =>
  (await getProfile(tenantId, userId))!.skills.find((s) => s.name === skill)!.endorsements;

describe('erase the ENDORSER → the target loses the endorsement', () => {
  it('deleteSubjectProfile(bob): bob\'s own row is gone AND alice\'s TypeScript/Go endorsements no longer carry bob; carol survives; the surface count drops', async () => {
    expect(await endorsers(T, ALICE, 'TypeScript')).toEqual([BOB, CAROL]);
    expect(await deleteSubjectProfile(T, BOB)).toBe(true);
    expect(await getProfile(T, BOB)).toBeNull();
    expect(await endorsers(T, ALICE, 'TypeScript')).toEqual([CAROL]);
    expect(await endorsers(T, ALICE, 'Go')).toEqual([]);
    const surface = buildProfilesSurface({ tenantId: T });
    const one = await surface.getProfile!({ userId: ALICE }) as { profile: { skills: Array<{ name: string; endorsements: { count: number; endorserUserIds: string[] } }> } };
    expect(one.profile.skills.find((s) => s.name === 'TypeScript')!.endorsements).toEqual({ count: 1, endorserUserIds: [CAROL] });
    // Silent: no endorsement.removed / profile.updated fan-out for the strip.
    await settle();
    expect(delivered.filter((e) => e.type.startsWith('host.profiles.'))).toEqual([]);
  });

  it('an endorser with NO own row (carol) is still stripped; deleted:false, peersStripped:1', async () => {
    expect(await getProfile(T, CAROL)).toBeNull();
    expect(await eraseProfileSubject(T, CAROL)).toEqual({ deleted: false, peersStripped: 1 });
    expect(await endorsers(T, ALICE, 'TypeScript')).toEqual([BOB]);
  });

  it('the REGISTERED eraser (what eraseSubject fans out to) strips peers and reports own row + peer rows as rowsTouched', async () => {
    expect(registeredSubjectEraserIds().some((id) => /profileEraser/.test(id))).toBe(true);
    expect(await profileEraser(T, BOB)).toEqual({ rowsTouched: 2 }); // bob's own row + alice's row
    expect(await endorsers(T, ALICE, 'TypeScript')).toEqual([CAROL]);
    expect(await getProfile(T, BOB)).toBeNull();
    expect(await profileEraser(T, BOB)).toEqual({ rowsTouched: 0 }); // idempotent: nothing left to touch
    expect(await profileEraser(T, 'bob@example.test')).toEqual({ rowsTouched: 0 }); // the resolver's email key
  });
});

describe('the guards: email key never scans; unchanged writes nothing; the erasing tenant only', () => {
  it('an EMAIL subject key does not scan the tenant (listForTenantIndexed is not called)', async () => {
    const scan = vi.spyOn(DurableCollection.prototype, 'listForTenantIndexed');
    expect(await eraseProfileSubject(T, 'bob@example.test')).toEqual({ deleted: false, peersStripped: 0 });
    expect(scan).not.toHaveBeenCalled();
    expect(await endorsers(T, ALICE, 'TypeScript')).toEqual([BOB, CAROL]);
  });

  it('erasing a user who endorsed nobody makes ZERO CAS writes and no put (the pre-filter + unchanged)', async () => {
    await getOrCreateProfile(T, 'user:pe-loner');
    const cas = vi.spyOn(DurableCollection.prototype, 'compareAndSwap');
    const put = vi.spyOn(DurableCollection.prototype, 'put');
    expect(await stripEndorsementsBy(T, 'user:pe-loner')).toBe(0);
    expect(cas).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    // and the endorser lane for a real endorser writes exactly the rows that held the id
    expect(await stripEndorsementsBy(T, BOB)).toBe(1);
    expect(cas).toHaveBeenCalledTimes(1);
  });

  it('reach is the ERASING tenant: bob\'s endorsement in tenant T2 survives an erasure in T', async () => {
    await getOrCreateProfile(T2, 'user:pe-dana');
    await setOwnSkills(T2, 'user:pe-dana', [{ name: 'Audio', proficiency: 3 }]);
    await setEndorsement(T2, 'user:pe-dana', 'Audio', BOB, true);
    await deleteSubjectProfile(T, BOB);
    expect(await endorsers(T, ALICE, 'TypeScript')).toEqual([CAROL]);
    expect(await endorsers(T2, 'user:pe-dana', 'Audio')).toEqual([BOB]); // stated: other workspaces are out of reach
  });
});
