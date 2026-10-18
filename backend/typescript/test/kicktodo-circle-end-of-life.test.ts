/**
 * KTACC-2 + KTA-11 (KickTodo wave 4C) — what happens to a circle when its owner
 * is erased, and what the enrollment-deleted signal cleans up.
 *
 * KTACC-2 was a PRODUCT decision (David, 2026-10-17): a circle SURVIVES its
 * owner's erasure. It passes to the longest-standing live member (earliest
 * join), or DISSOLVES — with its grants, cohort, seats, holds, caseload pointers
 * and sessions — when no live member remains. Neither the erased owner's subject
 * nor the free-text `name` they typed may remain on the circle or its grants.
 *
 * Before this wave the eraser deleted every grant the owner had ISSUED (all of
 * them: only the owner may invite) and kept the circle with its `ownerSubject`
 * and `name`, so every circle became an ownerless husk carrying the erased
 * person's subject key.
 *
 * KTA-11: proposals ABOUT an enrollment were reachable only through
 * `listEnrollmentsFor`, i.e. only when the accountability eraser happened to run
 * before kicktodo-core's. The `onEnrollmentDeleted` subscriptions close that
 * order dependence for proposals and for the circle anchored to the enrollment.
 *
 * What breaks these (sabotage-witnessed, each reverted and restored):
 *  - drop the `handOverCircles(...)` call from the eraser → the transfer test
 *    reds (owner stays the erased subject, member grants are deleted);
 *  - drop `dropDissolvedCircleCohortRows` / `dropDissolvedCircleSessions` from
 *    `handOverCircles` → the dissolve test reds on the cohort/seat/session rows;
 *  - drop the `onEnrollmentDeleted` registrations → the KTA-11 test reds;
 *  - drop the `c.ownerSubject === ownerSubject` filter in the circles
 *    subscription → the "handed-over circle is not handed over again" case reds.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { KICKTODO_REVOKED_ROW_RETENTION_DAYS } from '../src/features/kicktodo-core/types.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSubject, __resetSubjectErasers, __resetSubjectKeyResolvers } from '../src/host/subjectErasure.js';
import { __resetRetentionPurgers } from '../src/host/retentionPurger.js';
import { resetScheduling } from '../src/host/schedulingService.js';
import { fireEnrollmentDeleted, __resetEnrollmentLifecycleHooks } from '../src/features/kicktodo-core/enrollmentLifecycle.js';
import { registerKicktodoAccountabilityCompliance } from '../src/features/kicktodo-accountability/compliance.js';
import {
  GRANT_SCOPES,
  HANDED_OVER_CIRCLE_NAME,
  handOverCircle,
  type AccountabilityCircle,
  type AccountabilityGrant,
} from '../src/features/kicktodo-accountability/circleService.js';

const circleCol = () => new DurableCollection<AccountabilityCircle>('kicktodo-circles', (c) => `${c.tenantId}::${c.id}`);
const circleIdxCol = () => new DurableCollection<{ circleId: string; tenantId: string }>('kicktodo-circle-index', (r) => r.circleId);
const grantCol = () => new DurableCollection<AccountabilityGrant>('kicktodo-grants', (g) => `${g.tenantId}::${g.circleId}::${g.granteeSubject}`);
const cohortCol = () => new DurableCollection<{ tenantId: string; circleId: string; challengeId: string; challengeVersion: number; startDateLocal: string; capacity: number; seatsTaken: number }>(
  'kicktodo-cohorts', (c) => `${c.tenantId}::${c.circleId}`);
const granteeIdxCol = () => new DurableCollection<{ granteeSubject: string; circleId: string; tenantId: string }>(
  'kicktodo-grantee-index', (r) => `${r.granteeSubject}::${r.circleId}`);
const seatCol = () => new DurableCollection<{ tenantId: string; circleId: string; subject: string; claimedAt: string }>(
  'kicktodo-cohort-seats', (x) => `${x.tenantId}::${x.circleId}::${x.subject}`);
const holdCol = () => new DurableCollection<{ tenantId: string; circleId: string; buyerSubject: string; heldAt: string; expiresAt: string }>(
  'kicktodo-seat-holds', (h) => `${h.tenantId}::${h.circleId}::${h.buyerSubject}`);
const sessionCol = () => new DurableCollection<{ tenantId: string; circleId: string; atIso: string; title: string; createdBy: string; conversationId: string; createdAt: string }>(
  'kicktodo-cohort-sessions', (s) => `${s.tenantId}::${s.circleId}::${s.atIso}`);
const proposalCol = () => new DurableCollection<{ id: string; tenantId: string; circleId: string; enrollmentId: string; coachSubject: string; note: string; state: string; createdAt: string }>(
  'kicktodo-plan-proposals', (p) => `${p.tenantId}::${p.enrollmentId}::${p.id}`);

const T = 'tenant-kt-eol';
const T2 = 'tenant-kt-eol-other';
const OWNER = 'user:eol-owner';
const B = 'user:eol-bob';
const C = 'user:eol-carol';
const D = 'user:eol-dave';
const E = 'user:eol-erin';
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

async function seedCircle(tenantId: string, id: string, owner: string, enrollmentId: string, name = 'Owner private goals'): Promise<void> {
  await circleCol().put({ id, tenantId, type: 'cohort', enrollmentId, ownerSubject: owner, name, conversationId: `cv-${id}`, createdAt: at(0) });
  await circleIdxCol().put({ circleId: id, tenantId });
  await grantCol().put({
    tenantId, circleId: id, enrollmentId, grantorSubject: owner, granteeSubject: owner,
    scopes: [...GRANT_SCOPES], state: 'active', invitedAt: at(0), acceptedAt: at(0),
  });
}

async function member(tenantId: string, circleId: string, owner: string, subject: string, over: Partial<AccountabilityGrant>): Promise<void> {
  await grantCol().put({
    tenantId, circleId, enrollmentId: 'enrO', grantorSubject: owner, granteeSubject: subject,
    scopes: ['message'], state: 'active', invitedAt: at(1), ...over,
  });
}

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  __resetRetentionPurgers();
  __resetEnrollmentLifecycleHooks();
  await resetScheduling();
  registerKicktodoAccountabilityCompliance();
});

describe('KTACC-2 — a circle survives its owner\'s erasure', () => {
  it('passes to the longest-standing LIVE member and leaves no trace of the erased owner', async () => {
    await seedCircle(T, 'circ1', OWNER, 'enrO');
    await member(T, 'circ1', OWNER, B, { acceptedAt: at(30), invitedAt: at(2) });  // joined late
    await member(T, 'circ1', OWNER, C, { acceptedAt: at(20), invitedAt: at(5) });  // earliest LIVE join → heir
    await member(T, 'circ1', OWNER, D, { state: 'invited', invitedAt: at(3) });    // never joined
    await member(T, 'circ1', OWNER, E, { acceptedAt: at(10), state: 'revoked', revokedAt: at(11) }); // left
    await cohortCol().put({ tenantId: T, circleId: 'circ1', challengeId: 'ch', challengeVersion: 1, startDateLocal: '2026-01-05', capacity: 5, seatsTaken: 3 });

    expect((await eraseSubject(T, OWNER)).failed).toBe(0);

    const circle = await circleCol().get(`${T}::circ1`);
    expect(circle?.ownerSubject).toBe(C);
    expect(circle?.name).toBe(HANDED_OVER_CIRCLE_NAME);
    // The heir holds the owner's full scopes; the circle is still reachable.
    expect((await grantCol().get(`${T}::circ1::${C}`))?.scopes).toEqual([...GRANT_SCOPES]);
    expect(await circleIdxCol().get('circ1')).toMatchObject({ tenantId: T });
    expect(await cohortCol().get(`${T}::circ1`)).not.toBeNull();
    // Members' grants SURVIVE (before: deleted as "issued by the erased owner"),
    // re-attributed to the heir; the owner's own grant is gone.
    const rows = await grantCol().listByPrefix(`${T}::circ1::`);
    expect(rows.map((g) => g.granteeSubject).sort()).toEqual([B, C, D, E].sort());
    expect(rows.every((g) => g.grantorSubject === C)).toBe(true);
    // No row of the circle mentions the erased subject or their free text.
    const dump = JSON.stringify([circle, ...rows]);
    expect(dump).not.toContain(OWNER);
    expect(dump).not.toContain('Owner private goals');
  });

  it('DISSOLVES when no live member remains, taking every child row with it; another tenant is untouched', async () => {
    await seedCircle(T, 'circ2', OWNER, 'enrO');
    await member(T, 'circ2', OWNER, E, { acceptedAt: at(10), state: 'revoked', revokedAt: at(11) });
    await member(T, 'circ2', OWNER, B, { acceptedAt: at(12), expiresAt: at(13) }); // expired ⇒ not live
    await cohortCol().put({ tenantId: T, circleId: 'circ2', challengeId: 'ch', challengeVersion: 1, startDateLocal: '2026-01-05', capacity: 5, seatsTaken: 1 });
    await seatCol().put({ tenantId: T, circleId: 'circ2', subject: B, claimedAt: at(12) });
    await holdCol().put({ tenantId: T, circleId: 'circ2', buyerSubject: D, heldAt: at(12), expiresAt: at(50) });
    await granteeIdxCol().put({ granteeSubject: B, circleId: 'circ2', tenantId: T });
    await sessionCol().put({ tenantId: T, circleId: 'circ2', atIso: at(40), title: 't', createdBy: B, conversationId: 'cv', createdAt: at(1) });
    // The same ids in another tenant must survive.
    await seedCircle(T2, 'circ2', OWNER, 'enrO');
    await sessionCol().put({ tenantId: T2, circleId: 'circ2', atIso: at(40), title: 't', createdBy: B, conversationId: 'cv', createdAt: at(1) });

    expect((await eraseSubject(T, OWNER)).failed).toBe(0);

    expect(await circleCol().get(`${T}::circ2`)).toBeNull();
    expect(await grantCol().listByPrefix(`${T}::circ2::`)).toEqual([]);
    expect(await cohortCol().get(`${T}::circ2`)).toBeNull();
    expect(await seatCol().get(`${T}::circ2::${B}`)).toBeNull();
    expect(await holdCol().get(`${T}::circ2::${D}`)).toBeNull();
    expect(await granteeIdxCol().get(`${B}::circ2`)).toBeNull();
    expect(await sessionCol().get(`${T}::circ2::${at(40)}`)).toBeNull();
    // The circle-index pointer is keyed by circle id alone, and T2's seed (written
    // last) owns it: dissolving T's circle must not delete another tenant's pointer.
    expect(await circleIdxCol().get('circ2')).toMatchObject({ tenantId: T2 });
    expect(await circleCol().get(`${T2}::circ2`)).toMatchObject({ ownerSubject: OWNER });
    expect(await sessionCol().get(`${T2}::circ2::${at(40)}`)).not.toBeNull();
  });

  it('two concurrent handovers settle on ONE heir (CAS), and a re-run is a no-op', async () => {
    await seedCircle(T, 'circ3', OWNER, 'enrO');
    await member(T, 'circ3', OWNER, B, { acceptedAt: at(9) });
    await member(T, 'circ3', OWNER, C, { acceptedAt: at(8) });
    const [r1, r2] = await Promise.all([handOverCircle(T, 'circ3', OWNER), handOverCircle(T, 'circ3', OWNER)]);
    const outcomes = [r1, r2].filter((r) => r !== null);
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    for (const r of outcomes) expect(r).toMatchObject({ outcome: 'transferred', newOwner: C });
    expect((await circleCol().get(`${T}::circ3`))?.ownerSubject).toBe(C);
    expect(await handOverCircle(T, 'circ3', OWNER)).toBeNull(); // no longer theirs
  });
});

describe('KTA-11 — circles + proposals prune on onEnrollmentDeleted', () => {
  it('hands over the circle anchored to the deleted enrollment and deletes that enrollment\'s proposals', async () => {
    await seedCircle(T, 'circ4', OWNER, 'enrO');
    await member(T, 'circ4', OWNER, B, { acceptedAt: at(5) });
    await proposalCol().put({ id: 'p1', tenantId: T, circleId: 'circ4', enrollmentId: 'enrO', coachSubject: B, note: 'about the owner', state: 'proposed', createdAt: at(6) });
    await proposalCol().put({ id: 'p2', tenantId: T, circleId: 'circ9', enrollmentId: 'enrOther', coachSubject: B, note: 'n', state: 'proposed', createdAt: at(6) });

    await fireEnrollmentDeleted({ tenantId: T, enrollmentId: 'enrO', ownerSubject: OWNER });

    expect((await circleCol().get(`${T}::circ4`))?.ownerSubject).toBe(B);
    expect(await proposalCol().get(`${T}::enrO::p1`)).toBeNull();
    expect(await proposalCol().get(`${T}::enrOther::p2`)).not.toBeNull();
  });

  it('does not hand a circle away from its NEW owner when the old anchor enrollment is deleted later', async () => {
    // Already handed over to B, still anchored to the departed owner's enrollment.
    await seedCircle(T, 'circ5', B, 'enrO', HANDED_OVER_CIRCLE_NAME);
    await member(T, 'circ5', B, C, { acceptedAt: at(5) });
    await fireEnrollmentDeleted({ tenantId: T, enrollmentId: 'enrO', ownerSubject: OWNER });
    expect((await circleCol().get(`${T}::circ5`))?.ownerSubject).toBe(B);
  });
});

/**
 * KTACC-6 — revoked grants past the retention window are reclaimed by the
 * default-on kvAgeOut lane; live, invited and recently revoked grants are not.
 * Breaks if the `kicktodo-grants:revoked` registration is removed (the old
 * grant survives) or re-keyed on a field live grants carry (`invitedAt` — the
 * live grant is deleted).
 */
describe('KTACC-6 — revoked grants age out', () => {
  it('deletes only grants revoked longer ago than the window', async () => {
    const NOW = new Date('2026-10-01T00:00:00.000Z');
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
    const W = KICKTODO_REVOKED_ROW_RETENTION_DAYS;
    await member(T, 'circ6', OWNER, B, { state: 'revoked', invitedAt: daysAgo(400), acceptedAt: daysAgo(400), revokedAt: daysAgo(W + 1) });
    await member(T, 'circ6', OWNER, C, { state: 'revoked', invitedAt: daysAgo(400), revokedAt: daysAgo(W - 1) });
    await member(T, 'circ6', OWNER, D, { state: 'active', invitedAt: daysAgo(400), acceptedAt: daysAgo(400) });
    await member(T, 'circ6', OWNER, E, { state: 'invited', invitedAt: daysAgo(400) });

    const res = (await __runKvAgeOutOnce(storage, NOW)).find((r) => r.id === 'kicktodo-grants:revoked');
    expect(res).toMatchObject({ deleted: 1 });
    expect(await grantCol().get(`${T}::circ6::${B}`)).toBeNull();
    expect(await grantCol().get(`${T}::circ6::${C}`)).not.toBeNull();
    expect(await grantCol().get(`${T}::circ6::${D}`)).not.toBeNull();
    expect(await grantCol().get(`${T}::circ6::${E}`)).not.toBeNull();
  });
});
