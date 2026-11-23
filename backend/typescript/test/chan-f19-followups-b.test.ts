/**
 * CHAN-F19 follow-up B (ADR 0464 §9, user decisions 2026-11-22): three stores no eraser
 * reached, and one the census counted as covered when nothing touched it.
 *
 *  - `crm:booking-link` / `crm:booking-link-slug`: a link the erased member OWNS is
 *    disabled, its owner and creator are replaced, and its public slug (which the owner may
 *    have typed with their name) is replaced by a neutral one; the old slug is released. A
 *    link they only CREATED for someone else keeps running with `createdBy` replaced.
 *  - `crm:territory-rule`: a filter literal equal to the subject (an `eq` value or an `in`
 *    element) is rewritten; the rule and its other literals are kept.
 *  - `sales-maps:geocode`: no row holds an address (the key carries a hash, the row no raw
 *    field), every row ages out after `CACHE_TTL_DAYS`, a legacy raw-address row ages out
 *    on the same lane, and the miss error no longer echoes the address.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the `owns` branch skipped in eraseBookingLinkSubject       → "disabled, renamed"
 *  - the old slug's index row not released                       → "the old slug is free"
 *  - the call in eraseCrmTaskAssignees removed                   → "disabled, renamed"
 *  - `scrub` returning the value unchanged                       → "rewritten, kept"
 *  - the array branch scrubbing nothing                          → "an `in` element"
 *  - the __eraseRuleLiterals call in eraseSubjectTerritories cut → "rewritten, kept"
 *  - the raw address put back into the row                       → "holds no address"
 *  - the registerKvAgeOut line removed                           → "ages out"
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __listKvAgeOutForTest, __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { createBookingLink, getBookingLink, getPublishedBookingLinkBySlug, ERASED_BOOKING_ACTOR } from '../src/features/crm/entities/bookingLinks.js';
import { eraseCrmTaskAssignees } from '../src/features/crm/erasure.js';
import { createModel, createTerritory } from '../src/features/territories/entities/territories.js';
import { createRule, listRules } from '../src/features/territories/entities/assignment.js';
import { eraseSubjectTerritories } from '../src/features/territories/erasure.js';
import { ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';
import { geocode, getCachedGeocode, CACHE_TTL_DAYS } from '../src/features/sales-maps/entities/geocode.js';

const T = 'org:f19b';
const O = 'org:f19b';
const SUBJECT = 'user-erased-f19b';
const OTHER = 'user-kept-f19b';
const DAY = 86_400_000;

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

const link = (ownerUserId: string, createdBy: string, slug: string) => createBookingLink({
  tenantId: T, orgId: O, ownerUserId, createdBy, title: 'Intro call', slug, status: 'published',
  timezone: 'UTC', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], durations: [30],
});

describe('booking links: the erased member’s own links leave public view', () => {
  it('an owned link is disabled, renamed and de-attributed; a link for another owner keeps running', async () => {
    const own = await link(SUBJECT, SUBJECT, 'jane-doe-intro');
    const forOther = await link(OTHER, SUBJECT, 'team-intro');
    const untouched = await link(OTHER, OTHER, 'other-intro');

    await eraseCrmTaskAssignees(T, SUBJECT);

    const a = await getBookingLink(T, O, own.bookingLinkId);
    expect(a).toMatchObject({ status: 'disabled', ownerUserId: ERASED_BOOKING_ACTOR, createdBy: ERASED_BOOKING_ACTOR });
    expect(a!.slug).not.toBe('jane-doe-intro');
    expect(a!.slug).toMatch(/^meeting-[0-9a-f]{8}/);
    expect(await getPublishedBookingLinkBySlug('jane-doe-intro')).toBeNull();

    const b = await getBookingLink(T, O, forOther.bookingLinkId);
    expect(b).toMatchObject({ status: 'published', ownerUserId: OTHER, createdBy: ERASED_BOOKING_ACTOR, slug: 'team-intro' });
    expect(await getBookingLink(T, O, untouched.bookingLinkId)).toMatchObject({ ownerUserId: OTHER, createdBy: OTHER, slug: 'other-intro' });
  });

  it('the old slug is free: a new link can claim it, and a second erasure changes nothing', async () => {
    const own = await link(SUBJECT, SUBJECT, 'jane-doe-intro');
    await eraseCrmTaskAssignees(T, SUBJECT);
    const renamed = (await getBookingLink(T, O, own.bookingLinkId))!.slug;
    expect((await link(OTHER, OTHER, 'jane-doe-intro')).slug).toBe('jane-doe-intro');
    await eraseCrmTaskAssignees(T, SUBJECT);
    expect((await getBookingLink(T, O, own.bookingLinkId))!.slug).toBe(renamed);
  });
});

describe('territory rules: a filter literal naming the subject is rewritten', () => {
  async function model(): Promise<{ modelId: string; territoryId: string }> {
    const m = await createModel(T, O, { name: 'FY27' }, OTHER);
    const t = await createTerritory(T, O, m.modelId, { name: 'West' }, OTHER);
    return { modelId: m.modelId, territoryId: t.territoryId };
  }

  it('an `eq` literal is rewritten, kept, and the rule stays', async () => {
    const { modelId, territoryId } = await model();
    await createRule(T, O, modelId, { territoryId, target: 'deal', filter: { all: [{ field: 'owner', op: 'eq', value: SUBJECT }, { field: 'currency', op: 'eq', value: 'USD' }] } });
    await createRule(T, O, modelId, { territoryId, target: 'deal', filter: { field: 'owner', op: 'eq', value: OTHER } });

    await eraseSubjectTerritories(T, SUBJECT);

    const rules = await listRules(T, O, modelId);
    expect(rules).toHaveLength(2);
    const filters = rules.map((r) => JSON.stringify(r.filter));
    expect(filters.join()).not.toContain(SUBJECT);
    expect(filters).toContain(JSON.stringify({ all: [{ field: 'owner', op: 'eq', value: ERASED_USER_REF }, { field: 'currency', op: 'eq', value: 'USD' }] }));
    expect(filters).toContain(JSON.stringify({ field: 'owner', op: 'eq', value: OTHER }));
  });

  it('an `in` element is rewritten and the other elements are kept', async () => {
    const { modelId, territoryId } = await model();
    await createRule(T, O, modelId, { territoryId, target: 'deal', filter: { field: 'owner', op: 'in', value: [OTHER, SUBJECT] } });
    await eraseSubjectTerritories(T, SUBJECT);
    const [r] = await listRules(T, O, modelId);
    expect(r!.filter).toEqual({ field: 'owner', op: 'in', value: [OTHER, ERASED_USER_REF] });
  });
});

describe('geocode cache: no row holds an address, and every row ages out', () => {
  it('holds no address: the key hashes it, the row has no raw field, the caller still gets it back', async () => {
    const out = await geocode(T, O, { address: '12 Elm Street, Springfield', lat: 1, lng: 2 });
    expect(out.address).toBe('12 Elm Street, Springfield');
    const rows = await storage.kvList('hostext:sales-maps:geocode:');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key.toLowerCase()).not.toContain('elm');
    expect(rows[0]!.value.toLowerCase()).not.toContain('elm');
    expect(await getCachedGeocode(T, O, '  12 elm street,   springfield ')).toMatchObject({ lat: 1, lng: 2 });
  });

  it('a miss does not echo the address into the error details', async () => {
    const err = await geocode(T, O, { address: '9 Oak Lane' }).then(() => null, (e: unknown) => e as { httpStatus?: number; details?: unknown });
    expect(err?.httpStatus).toBe(503);
    expect(JSON.stringify(err?.details ?? {})).not.toContain('Oak');
  });

  it('ages out: manual rows and legacy raw-address rows go after CACHE_TTL_DAYS', async () => {
    expect(__listKvAgeOutForTest().find((r) => r.id === 'sales-maps:geocode')).toMatchObject({ prefix: 'hostext:sales-maps:geocode:', ttlDays: CACHE_TTL_DAYS, timestampField: 'at' });
    const now = new Date();
    const old = new Date(now.getTime() - (CACHE_TTL_DAYS + 1) * DAY).toISOString();
    const legacyKey = `g1|${T.length}|${T}|${O.length}|${O}|12 elm street`;
    await storage.kvSet(`hostext:sales-maps:geocode:${legacyKey}`, JSON.stringify({ cacheKey: legacyKey, tenantId: T, orgId: O, address: '12 Elm Street', lat: 1, lng: 2, source: 'manual', at: old }));
    await geocode(T, O, { address: '1 Fresh Road', lat: 3, lng: 4 });
    await __runKvAgeOutOnce(storage, now);
    const keys = (await storage.kvList('hostext:sales-maps:geocode:')).map((r) => r.key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('elm');
  });

  it('an aged-out row leaves the tenant index too (acceptIndexed: the sweep deletes through the collection)', async () => {
    await geocode(T, O, { address: '7 Birch Way', lat: 5, lng: 6 });
    const idx = () => storage.kvList(`hostextidx:sales-maps:geocode:${T}:`);
    expect(await idx()).toHaveLength(1);
    await __runKvAgeOutOnce(storage, new Date(Date.now() + (CACHE_TTL_DAYS + 1) * DAY));
    expect(await storage.kvList('hostext:sales-maps:geocode:')).toHaveLength(0);
    expect(await idx()).toHaveLength(0);
    expect(await getCachedGeocode(T, O, '7 Birch Way')).toBeNull();
  });
});
