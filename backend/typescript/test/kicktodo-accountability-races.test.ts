/**
 * KickTodo wave 4B (slice A) — read-then-put races and non-idempotent mints in
 * kicktodo-accountability. Each case forces the interleaving deterministically
 * (a `lockstep` barrier on one storage key's read, or a held write) and asserts
 * the INVARIANT, not a happy path. What breaks each one:
 *
 *  - KTACC-3 (double hold): reverting `holdSeat`'s row write to a blind `put`
 *    lets both racers claim a seat — `seatsTaken` 3, not 2.
 *  - KTACC-3 (expired hold blocks a join): dropping the reap-on-full in
 *    `claimSeat` makes `joinCohort` throw CohortFullError on a free seat.
 *  - KTACC-4: removing the `unindexRevokedGrantee` call from the revoke route
 *    leaves the coach's caseload pointer row behind.
 *  - KTACC-5: ignoring the `Idempotency-Key` (or reverting the circle create to
 *    a random id) makes a double submit produce two circles.
 *  - KTA-3: reverting `acceptGrant` to get-then-put lets an accept that read
 *    `invited` overwrite a revoke that landed first — the grant ends `active`.
 *  - KTA-4: reverting `resolveProposal` to read/apply/put runs the commands twice
 *    (planRevision 3) on a double apply; dropping the propose CAS mints two
 *    proposals for one run-keyed replay.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { OpenwopError } from '../src/types.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import {
  createCircle, inviteToCircle, acceptGrant, revokeGrant, liveGrant, listCirclesOwnedBy, CircleDeniedError,
} from '../src/features/kicktodo-accountability/circleService.js';
import {
  createCohortDetail, getCohortDetail, holdSeat, joinCohort, proposePlanChange, resolveProposal,
  listProposalsFor, ProposalBusyError,
} from '../src/features/kicktodo-accountability/cohortService.js';
import { buildKicktodoAccountabilitySurface } from '../src/features/kicktodo-accountability/surface.js';
import { KICKTODO_CIRCLES_ROUTES } from '../src/features/kicktodo-accountability/routes.js';

vi.mock('../src/features/featureRoute.js', async (orig) => {
  const actual = await orig<typeof import('../src/features/featureRoute.js')>();
  return { ...actual, requireFeatureEnabled: vi.fn(async () => undefined) };
});

const T = 'tenant-kt4b-acc';
const OWNER = 'user:kt4b-owner';

let storage: Storage;
let restore: Array<() => void> = [];
let challengeId = '';

/** Hold the first `racers` reads of ONE storage key until all have arrived. */
function lockstep(key: string, racers: number): { arrivals: () => number } {
  const original = storage.kvGet.bind(storage);
  let arrivals = 0;
  let batch: Array<() => void> = [];
  const release = (): void => { const b = batch; batch = []; for (const f of b) f(); };
  const spy = vi.spyOn(storage, 'kvGet').mockImplementation(async (k: string) => {
    if (k === key && arrivals < racers) {
      arrivals += 1;
      await new Promise<void>((r) => {
        batch.push(r);
        if (batch.length === racers) release();
        else if (batch.length === 1) setTimeout(release, 2000);
      });
    }
    return original(k);
  });
  restore.push(() => spy.mockRestore());
  return { arrivals: () => arrivals };
}

async function ownerEnrollment(owner = OWNER): Promise<string> {
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId, challengeVersion: 1, timezone: 'UTC' });
  return enrollment.id;
}

/** A cohort with `buyerSeats` free seats (the owner holds one more). */
async function cohortWithSeats(buyerSeats: number): Promise<string> {
  const enrollmentId = await ownerEnrollment();
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId, ownerSubject: OWNER, name: 'Cohort' });
  await createCohortDetail({ circle, actorSubject: OWNER, capacity: buyerSeats + 1, startDateLocal: '2099-01-01' });
  return circle.id;
}

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Race', summary: 's', outcome: 'o', durationDays: 14,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  challengeId = draft.id;
});
afterEach(() => {
  for (const f of restore) f();
  restore = [];
});

describe('KTACC-3 — holdSeat', () => {
  it('two concurrent holds by ONE buyer take ONE seat (room for two)', async () => {
    const circleId = await cohortWithSeats(2);
    const buyer = 'user:kt4b-buyer';
    const race = lockstep(`hostext:kicktodo-seat-holds:${T}::${circleId}::${buyer}`, 2);
    const results = await Promise.allSettled([holdSeat(T, circleId, buyer), holdSeat(T, circleId, buyer)]);
    expect(race.arrivals(), 'the race was not forced — both holds must read the row before either writes').toBe(2);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true); // the loser converges, never errors
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2); // owner + ONE hold
  });

  it('…and on the LAST seat, the buyer racing their own hold is not told "full"', async () => {
    const circleId = await cohortWithSeats(1);
    const buyer = 'user:kt4b-buyer-last';
    const race = lockstep(`hostext:kicktodo-seat-holds:${T}::${circleId}::${buyer}`, 2);
    const results = await Promise.allSettled([holdSeat(T, circleId, buyer), holdSeat(T, circleId, buyer)]);
    expect(race.arrivals()).toBe(2);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2);
  });

  it('an EXPIRED hold on the last seat does not refuse a join as full', async () => {
    const circleId = await cohortWithSeats(1);
    await holdSeat(T, circleId, 'user:kt4b-abandoned', -1000); // already expired: an abandoned checkout
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2);
    const joiner = 'user:kt4b-joiner';
    await inviteToCircle(T, circleId, OWNER, joiner, ['progress-summary']);
    await joinCohort(circleId, joiner);
    expect(await liveGrant(T, circleId, joiner)).not.toBeNull();
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2); // owner + joiner; the dead hold is gone
  });
});

describe('KTA-3 — grant transitions are CAS', () => {
  it('an accept that read `invited` cannot overwrite a revoke that landed first', async () => {
    const enrollmentId = await ownerEnrollment();
    const circle = await createCircle({ tenantId: T, type: 'partner', enrollmentId, ownerSubject: OWNER, name: 'C' });
    const grantee = 'user:kt4b-partner';
    await inviteToCircle(T, circle.id, OWNER, grantee, ['progress-summary']);
    const grantKey = `hostext:kicktodo-grants:${T}::${circle.id}::${grantee}`;
    const race = lockstep(grantKey, 2);
    // Hold the ACCEPT's write until the revoke's write has landed (old code: a
    // blind kvSet of an `active` row; new code: a CAS against the `invited` row).
    let revokeLanded!: () => void;
    const revoked = new Promise<void>((r) => { revokeLanded = r; });
    const isActive = (v: string): boolean => v.includes('"state":"active"');
    const origSet = storage.kvSet.bind(storage);
    const origCas = storage.kvCompareAndSwap.bind(storage);
    const setSpy = vi.spyOn(storage, 'kvSet').mockImplementation(async (k, v, ...rest) => {
      if (k === grantKey && isActive(v)) await revoked;
      const out = await origSet(k, v, ...rest);
      if (k === grantKey && v.includes('"state":"revoked"')) revokeLanded();
      return out;
    });
    const casSpy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (k, exp, next) => {
      if (k === grantKey && isActive(next)) await revoked;
      const out = await origCas(k, exp, next);
      if (k === grantKey && next.includes('"state":"revoked"') && out.swapped) revokeLanded();
      return out;
    });
    restore.push(() => { setSpy.mockRestore(); casSpy.mockRestore(); });

    const [acc, rev] = await Promise.allSettled([acceptGrant(circle.id, grantee), revokeGrant(T, circle.id, OWNER, grantee)]);
    expect(race.arrivals(), 'both transitions must read `invited` before either writes').toBe(2);
    expect(rev.status).toBe('fulfilled');
    // The revoke was reported as done, so access must be gone — and the accept
    // must not have been reported as a success.
    expect(await liveGrant(T, circle.id, grantee)).toBeNull();
    expect(acc.status).toBe('rejected');
    expect((acc as PromiseRejectedResult).reason).toBeInstanceOf(CircleDeniedError);
  });
});

describe('KTA-4 — proposals', () => {
  async function coachedProposal(): Promise<{ enrollmentId: string; proposalId: string }> {
    const enrollmentId = await ownerEnrollment();
    const circle = await createCircle({ tenantId: T, type: 'coach', enrollmentId, ownerSubject: OWNER, name: 'C' });
    const coach = 'user:kt4b-coach';
    await inviteToCircle(T, circle.id, OWNER, coach, ['progress-summary', 'coach-plan-proposal']);
    await acceptGrant(circle.id, coach);
    const p = await proposePlanChange(circle.id, coach, 'Mornings.', [{ lane: 'schedule', daypart: 'morning' }]);
    return { enrollmentId, proposalId: p.id };
  }

  it('a double APPLY executes the commands once', async () => {
    const { enrollmentId, proposalId } = await coachedProposal();
    const race = lockstep(`hostext:kicktodo-plan-proposals:${T}::${enrollmentId}::${proposalId}`, 2);
    const results = await Promise.allSettled([
      resolveProposal(T, enrollmentId, proposalId, OWNER, 'apply'),
      resolveProposal(T, enrollmentId, proposalId, OWNER, 'apply'),
    ]);
    expect(race.arrivals()).toBe(2);
    expect((await getEnrollment(T, enrollmentId))?.planRevision).toBe(2); // ONE revision, not two
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof resolveProposal>>> => r.status === 'fulfilled');
    expect(fulfilled.some((r) => r.value.state === 'applied')).toBe(true);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ProposalBusyError);
    expect((await listProposalsFor(T, enrollmentId))[0]).toMatchObject({ state: 'applied' });
    expect((await listProposalsFor(T, enrollmentId))[0]!.applyingAt).toBeUndefined();
  });

  it('APPLY racing DISMISS: the stored outcome always matches what happened to the plan', async () => {
    const { enrollmentId, proposalId } = await coachedProposal();
    const race = lockstep(`hostext:kicktodo-plan-proposals:${T}::${enrollmentId}::${proposalId}`, 2);
    await Promise.allSettled([
      resolveProposal(T, enrollmentId, proposalId, OWNER, 'apply'),
      resolveProposal(T, enrollmentId, proposalId, OWNER, 'dismiss'),
    ]);
    expect(race.arrivals()).toBe(2);
    const stored = (await listProposalsFor(T, enrollmentId))[0]!;
    const rev = (await getEnrollment(T, enrollmentId))?.planRevision;
    expect(stored.state === 'applied').toBe(rev === 2); // never 'dismissed' over a changed plan
  });

  it('a run-keyed propose replay returns the first proposal (surface lane)', async () => {
    const enrollmentId = await ownerEnrollment();
    const circle = await createCircle({ tenantId: T, type: 'coach', enrollmentId, ownerSubject: OWNER, name: 'C' });
    const coach = 'user:kt4b-coach2';
    await inviteToCircle(T, circle.id, OWNER, coach, ['progress-summary', 'coach-plan-proposal']);
    await acceptGrant(circle.id, coach);
    const surface = buildKicktodoAccountabilitySurface({ tenantId: T, runId: 'run-kt4b-1' });
    const args = { circleId: circle.id, coachSubject: coach, note: 'Try evenings.' };
    const [a, b] = await Promise.all([surface.propose!(args), surface.propose!(args)]);
    expect((a as { proposal: { id: string } }).proposal.id).toBe((b as { proposal: { id: string } }).proposal.id);
    expect(await listProposalsFor(T, enrollmentId)).toHaveLength(1);
    // A different run is a different ask.
    await buildKicktodoAccountabilitySurface({ tenantId: T, runId: 'run-kt4b-2' }).propose!(args);
    expect(await listProposalsFor(T, enrollmentId)).toHaveLength(2);
  });
});

describe('routes — KTACC-4 caseload pointer + KTACC-5 idempotent create', () => {
  let server: http.Server;
  let base = '';
  let caller = OWNER;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request & { tenantId?: string; userId?: string }, _res, next) => { req.tenantId = T; req.userId = caller; next(); });
    for (const row of KICKTODO_CIRCLES_ROUTES) {
      app[row.method](row.path, (req: Request, res: Response, next: NextFunction) => { row.handler(req, res).catch(next); });
    }
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err instanceof OpenwopError ? err.httpStatus : 500).json({ error: String(err) });
    });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(() => { caller = OWNER; });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/host/openwop-app/kicktodo/circles${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  }

  it('KTACC-5: a double submit with one Idempotency-Key makes ONE circle; no key keeps today\'s behaviour', async () => {
    const enrollmentId = await ownerEnrollment();
    const body = { enrollmentId, type: 'partner', name: 'Mine' };
    const [a, b] = await Promise.all([
      post('', body, { 'Idempotency-Key': 'k-1' }),
      post('', body, { 'Idempotency-Key': 'k-1' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.json.id).toBe(b.json.id);
    expect(await listCirclesOwnedBy(T, OWNER)).toHaveLength(1);
    // The circle is fully formed: the owner holds the implicit full grant.
    expect(await liveGrant(T, a.json.id as string, OWNER)).not.toBeNull();

    await post('', body);
    await post('', body);
    expect(await listCirclesOwnedBy(T, OWNER)).toHaveLength(3); // keyless = fresh each call
  });

  it('KTACC-4: revoking a coach drops their caseload pointer; a re-invite restores it', async () => {
    const enrollmentId = await ownerEnrollment();
    const created = await post('', { enrollmentId, type: 'coach' });
    const circleId = created.json.id as string;
    const coach = 'user:kt4b-coach3';
    expect((await post(`/${encodeURIComponent(circleId)}/invite`, { granteeSubject: coach, scopes: ['coach-plan-proposal'] })).status).toBe(200);
    const pointerKey = `hostext:kicktodo-grantee-index:${coach}::${circleId}`;
    expect(await storage.kvGet(pointerKey)).not.toBeNull();

    expect((await post(`/${encodeURIComponent(circleId)}/revoke`, { granteeSubject: coach })).status).toBe(200);
    expect(await storage.kvGet(pointerKey)).toBeNull();

    await post(`/${encodeURIComponent(circleId)}/invite`, { granteeSubject: coach, scopes: ['coach-plan-proposal'] });
    expect(await storage.kvGet(pointerKey)).not.toBeNull();
  });
});
