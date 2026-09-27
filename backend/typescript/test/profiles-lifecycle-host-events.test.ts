/**
 * ADR 0624 D3 — the four `host.profiles.*` lifecycle events: emitted from the
 * WRITERS (one site each), transition-guarded, ids-only, over the REAL
 * `profilesService` + real dispatcher with a FAKE fanout (the
 * `users-lifecycle-host-events.test.ts` shape).
 *
 * What is pinned and WHY each pin is load-bearing:
 *   - an IDENTICAL PATCH emits nothing — `fields` is a JSON diff of the row
 *     excluding `updatedAt`/`updatedBy`, not "the CAS wrote";
 *   - a DEAD-ASSET promotion produces ZERO events — `setAvatarToken` /
 *     `addPortfolioToken` CAS-commit the reference FIRST, then unwind on a
 *     failed `promoteToDurable`; the emit sits after the promotion and the
 *     unwind is silent (the review's Blocker (a));
 *   - two CONCURRENT writers straddling 50 → exactly ONE `crossed` — `before`
 *     is the WINNING CAS attempt's `current`, so the loser's re-read diff
 *     starts where the winner landed;
 *   - one write crossing 25 AND 50 → ONE event with `thresholds: [25, 50]`;
 *   - a downward crossing carries `direction: 'down'`;
 *   - the demo seed (`{ silent: true }`) emits nothing;
 *   - endorsement given/removed emit ONCE on the transition; the idempotent
 *     `'unchanged'` re-endorse emits nothing; an endorsement is NOT an
 *     `updated`;
 *   - the LITERAL payload key set per event (the emitter's discipline —
 *     `stripPiiPayload` would not strip a `bio` or `location` value).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  initHostEventDispatcher,
  __clearHostEventBindings,
  __resetHostEventDispatcher,
  type HostEventEnvelope,
} from '../src/host/hostEventDispatcher.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import {
  __resetProfiles,
  addPortfolioToken,
  clearAvatar,
  computeCompleteness,
  getOrCreateProfile,
  getProfile,
  removePortfolioToken,
  setAgentPinned,
  setAvatarToken,
  setEndorsement,
  setOwnSkills,
  setOwnWorkflows,
  setProfileKnowledge,
  updateOwnProfile,
} from '../src/features/profiles/profilesService.js';
import {
  COMPLETENESS_CROSSED_EVENT,
  ENDORSEMENT_GIVEN_EVENT,
  ENDORSEMENT_REMOVED_EVENT,
  PROFILE_UPDATED_EVENT,
  changedFields,
  crossedThresholds,
} from '../src/features/profiles/emit.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let delivered: HostEventEnvelope[];
const T = 'org:profiles-events-t1';
const U = 'user:pe-owner';
const PEER = 'user:pe-peer';
const settle = () => new Promise((r) => setTimeout(r, 10));
const ofType = (type: string) => delivered.filter((e) => e.type === type);
const profileEvents = () => delivered.filter((e) => e.type.startsWith('host.profiles.'));
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearHostEventBindings();
  await __resetProfiles();
  delivered = [];
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async (event) => { delivered.push(event); },
    startRun: async () => null,
  });
  await getOrCreateProfile(T, U);
});

afterEach(() => {
  __resetHostEventDispatcher();
  __resetHostExtPersistence();
});

describe('host.profiles.profile.updated — diff-based, from the owner writers', () => {
  it('a PATCH that changes fields emits ONCE with the changed field NAMES (never values); an IDENTICAL PATCH emits nothing', async () => {
    await updateOwnProfile(T, U, { jobTitle: 'Producer', bio: 'A secret-ish bio' });
    await settle();
    let evs = ofType(PROFILE_UPDATED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['fields', 'tenantId', 'userId']);
    expect(evs[0]!.payload).toEqual({ tenantId: T, userId: U, fields: ['bio', 'jobTitle'] });
    expect(JSON.stringify(evs[0]!.payload)).not.toContain('secret-ish');
    expect('origin' in evs[0]!).toBe(false);

    await updateOwnProfile(T, U, { jobTitle: 'Producer', bio: 'A secret-ish bio' }); // identical — CAS writes, nothing differs
    await settle();
    evs = ofType(PROFILE_UPDATED_EVENT);
    expect(evs).toHaveLength(1);
    expect(profileEvents()).toHaveLength(2); // the one updated + the one crossed (0 → 25)
  });

  it('setOwnSkills / setOwnWorkflows emit `updated` with the single changed key; a no-op replacement is silent', async () => {
    await setOwnSkills(T, U, [{ name: 'TypeScript', proficiency: 4 }]);
    await setOwnWorkflows(T, U, ['wf.a']);
    await settle();
    expect(ofType(PROFILE_UPDATED_EVENT).map((e) => e.payload.fields)).toEqual([['skills'], ['workflows']]);
    await setOwnSkills(T, U, [{ name: 'TypeScript', proficiency: 4 }]);
    await setOwnWorkflows(T, U, ['wf.a']);
    await settle();
    expect(ofType(PROFILE_UPDATED_EVENT)).toHaveLength(2);
  });

  it('the deliberately SILENT writers emit nothing: pin/unpin, knowledge binding, lazy materialisation', async () => {
    await setAgentPinned(T, U, 'roster:x', true);
    await setAgentPinned(T, U, 'roster:x', false);
    await setProfileKnowledge(T, U, { collectionIds: ['kb:1'] });
    await getOrCreateProfile(T, 'user:pe-fresh');
    await settle();
    expect(profileEvents()).toEqual([]);
  });

  it('`{ silent: true }` (the demo-seed lane) suppresses BOTH updated and crossed on updateOwnProfile and setOwnSkills', async () => {
    await updateOwnProfile(T, U, { jobTitle: 'CEO', department: 'Exec', bio: 'Seeded' }, { silent: true }); // 0 → 35
    await setOwnSkills(T, U, [{ name: 'Leadership', proficiency: 5 }], { silent: true }); // 35 → 50
    await settle();
    expect(profileEvents()).toEqual([]);
    expect(computeCompleteness((await getProfile(T, U))!)).toBe(50);
  });
});

describe('media writers — emit AFTER promoteToDurable; the unwind is silent', () => {
  it('a live asset: setAvatarToken emits updated {avatar} + crossed 0→15 (no band) … then clearAvatar emits updated only', async () => {
    const asset = await storeMediaAsset(T, { contentBase64: PNG_1x1, contentType: 'image/png', ttlSeconds: 7 * 24 * 60 * 60 });
    await setAvatarToken(T, U, asset.token);
    await settle();
    expect(ofType(PROFILE_UPDATED_EVENT).map((e) => e.payload.fields)).toEqual([['avatarAssetToken']]);
    expect(ofType(COMPLETENESS_CROSSED_EVENT)).toHaveLength(0); // 0 → 15 crosses no band
    await clearAvatar(T, U);
    await settle();
    expect(ofType(PROFILE_UPDATED_EVENT).map((e) => e.payload.fields)).toEqual([['avatarAssetToken'], ['avatarAssetToken']]);
    await clearAvatar(T, U); // nothing to clear — no field differs
    await settle();
    expect(ofType(PROFILE_UPDATED_EVENT)).toHaveLength(2);
  });

  it('a DEAD-asset promotion (avatar AND portfolio) produces ZERO events — the reference is unwound and the write 404s', async () => {
    await expect(setAvatarToken(T, U, 'ma:dead-avatar')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    await expect(addPortfolioToken(T, U, 'ma:dead-portfolio')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    await settle();
    expect(profileEvents()).toEqual([]);
    const row = (await getProfile(T, U))!;
    expect(row.avatarAssetToken).toBeUndefined();
    expect(row.portfolioAssetTokens).toEqual([]);
  });

  it('portfolio add/remove emit updated {portfolioAssetTokens}; the idempotent re-add and a missing remove are silent', async () => {
    const asset = await storeMediaAsset(T, { contentBase64: PNG_1x1, contentType: 'image/png', ttlSeconds: 7 * 24 * 60 * 60 });
    await addPortfolioToken(T, U, asset.token);
    await addPortfolioToken(T, U, asset.token); // 'unchanged'
    expect(await removePortfolioToken(T, U, 'ma:never-there')).toBeNull(); // 'abort'
    await removePortfolioToken(T, U, asset.token);
    await settle();
    expect(ofType(PROFILE_UPDATED_EVENT).map((e) => e.payload.fields)).toEqual([['portfolioAssetTokens'], ['portfolioAssetTokens']]);
  });
});

describe('host.profiles.completeness.crossed — ONE event per write, every threshold crossed, with direction', () => {
  it('one write crossing 25 AND 50 → ONE event with thresholds [25, 50], direction up, exact key set', async () => {
    // 0 → jobTitle 10 + department 10 + bio 15 + interests 10 + equipment 5 = 50
    await updateOwnProfile(T, U, { jobTitle: 'a', department: 'b', bio: 'c', interests: ['x'], equipment: ['y'] });
    await settle();
    const evs = ofType(COMPLETENESS_CROSSED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['direction', 'from', 'tenantId', 'thresholds', 'to', 'userId']);
    expect(evs[0]!.payload).toEqual({ tenantId: T, userId: U, from: 0, to: 50, direction: 'up', thresholds: [25, 50] });
  });

  it('landing EXACTLY on a threshold counts (before < T ≤ after); leaving it downward counts as down', async () => {
    await updateOwnProfile(T, U, { jobTitle: 'a', bio: 'c' }); // 0 → 25
    await settle();
    expect(ofType(COMPLETENESS_CROSSED_EVENT).map((e) => e.payload)).toEqual([{ tenantId: T, userId: U, from: 0, to: 25, direction: 'up', thresholds: [25] }]);
    await updateOwnProfile(T, U, { bio: null }); // 25 → 10
    await settle();
    expect(ofType(COMPLETENESS_CROSSED_EVENT)).toHaveLength(2);
    expect(ofType(COMPLETENESS_CROSSED_EVENT)[1]!.payload).toEqual({ tenantId: T, userId: U, from: 25, to: 10, direction: 'down', thresholds: [25] });
    await updateOwnProfile(T, U, { department: 'd' }); // 10 → 20, no band
    await settle();
    expect(ofType(COMPLETENESS_CROSSED_EVENT)).toHaveLength(2);
  });

  it('two CONCURRENT writers straddling 50 emit exactly ONE crossed (before = the winning CAS attempt\'s current)', async () => {
    await updateOwnProfile(T, U, { jobTitle: 'a', department: 'b' }, { silent: true }); // 20 (no events)
    await setOwnSkills(T, U, [{ name: 'TS', proficiency: 3 }], { silent: true }); // 35
    await settle();
    expect(profileEvents()).toEqual([]);
    // Both would cross 50 alone (35 + 15 = 50); the loser re-reads the winner's
    // 50 and lands on 65 — no second crossing of 50.
    await Promise.all([
      updateOwnProfile(T, U, { bio: 'crosses' }),
      updateOwnProfile(T, U, { interests: ['x'], equipment: ['y'] }),
    ]);
    await settle();
    expect(computeCompleteness((await getProfile(T, U))!)).toBe(65);
    const crossed = ofType(COMPLETENESS_CROSSED_EVENT);
    expect(crossed).toHaveLength(1);
    expect(crossed[0]!.payload.thresholds).toEqual([50]);
    expect(ofType(PROFILE_UPDATED_EVENT)).toHaveLength(2); // each writer changed its own fields
  });

  it('the pure helpers: changedFields ignores bookkeeping; crossedThresholds is the [25,50,75,100] band rule', () => {
    const base = { ...((): Record<string, unknown> => ({}))(), userId: U, tenantId: T, portfolioAssetTokens: [], skills: [], equipment: [], interests: [], workflows: [], pinnedAgentIds: [], createdAt: 't', updatedAt: 't1' } as never;
    expect(changedFields(base, { ...(base as object), updatedAt: 't2', updatedBy: U } as never)).toEqual([]);
    expect(changedFields(base, { ...(base as object), bio: 'x', updatedAt: 't2' } as never)).toEqual(['bio']);
    expect(crossedThresholds(0, 100)).toEqual({ thresholds: [25, 50, 75, 100], direction: 'up' });
    expect(crossedThresholds(100, 0)).toEqual({ thresholds: [25, 50, 75, 100], direction: 'down' });
    expect(crossedThresholds(25, 49)).toBeNull();
    expect(crossedThresholds(24, 25)).toEqual({ thresholds: [25], direction: 'up' });
    expect(crossedThresholds(25, 24)).toEqual({ thresholds: [25], direction: 'down' });
    expect(crossedThresholds(30, 30)).toBeNull();
  });
});

describe('host.profiles.endorsement.given / .removed — the CAS-won transition only, never an `updated`', () => {
  it('given ONCE with {tenantId, userId, endorserUserId, skill}; the unchanged re-endorse emits nothing; removed ONCE; a second remove is silent', async () => {
    await setOwnSkills(T, U, [{ name: 'TypeScript', proficiency: 4 }]);
    await settle();
    const baseline = profileEvents().length;
    expect(await setEndorsement(T, U, 'typescript', PEER, true)).not.toBeNull();
    await settle();
    let evs = ofType(ENDORSEMENT_GIVEN_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['endorserUserId', 'skill', 'tenantId', 'userId']);
    expect(evs[0]!.payload).toEqual({ tenantId: T, userId: U, endorserUserId: PEER, skill: 'TypeScript' }); // the STORED name
    expect(await setEndorsement(T, U, 'TypeScript', PEER, true)).not.toBeNull(); // 'unchanged'
    await settle();
    expect(ofType(ENDORSEMENT_GIVEN_EVENT)).toHaveLength(1);

    await setEndorsement(T, U, 'TypeScript', PEER, false);
    await setEndorsement(T, U, 'TypeScript', PEER, false); // 'unchanged'
    await settle();
    evs = ofType(ENDORSEMENT_REMOVED_EVENT);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ tenantId: T, userId: U, endorserUserId: PEER, skill: 'TypeScript' });
    // An endorsement is a PEER action — no `updated` / `crossed` fanned out for it.
    expect(profileEvents().length - baseline).toBe(2);
    // A vanished skill / missing profile aborts silently.
    expect(await setEndorsement(T, U, 'Nope', PEER, true)).toBeNull();
    expect(await setEndorsement(T, 'user:nobody', 'TypeScript', PEER, true)).toBeNull();
    await settle();
    expect(profileEvents().length - baseline).toBe(2);
  });
});

describe('the demo people seed is silent end-to-end', () => {
  it('seedDemoPeople fans out ZERO host.profiles.* events for its N coworkers', async () => {
    const { seedDemoPeople } = await import('../src/host/demoPeopleSeed.js');
    const tenantId = 'org:profiles-events-seed';
    const r = await seedDemoPeople(tenantId);
    expect(r.created).toBeGreaterThan(0);
    await settle();
    expect(profileEvents()).toEqual([]);
  });
});

describe('payload discipline — no PII-shaped key or value ever leaves the emitter', () => {
  it('across every captured profiles event, no key matches bio|location|email|displayName|principalId and no bio text appears', async () => {
    await updateOwnProfile(T, U, { jobTitle: 'Producer', bio: 'PII-PROBE-BIO', contact: { location: 'PII-PROBE-LOC', links: [] } });
    await setOwnSkills(T, U, [{ name: 'Audio', proficiency: 2 }]);
    await setEndorsement(T, U, 'Audio', PEER, true);
    await settle();
    expect(profileEvents().length).toBeGreaterThanOrEqual(4);
    for (const ev of profileEvents()) {
      for (const key of Object.keys(ev.payload)) expect(key, `${ev.type} leaked key ${key}`).not.toMatch(/^(bio|location|email|displayName|principalId)$/i);
      expect(JSON.stringify(ev.payload)).not.toContain('PII-PROBE');
    }
  });
});
