/**
 * ADR 0541 P1 — the apply grant.
 *
 * The grant exists so that auto-apply does NOT become "a second browser driver
 * that isn't bound by the commit gate". So the tests that matter are the ones
 * that prove it cannot be turned into an unbounded authority: a grant with no
 * ceiling is refused, a purchase is never grantable, and the ceiling holds under
 * concurrency rather than on average.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createApplyGrant, consultApplyGrant, consumeSubmit, consumePrepared,
  claimSubmission, revokeApplyGrant, applyGrants, submissionClaims, eraseSubjectApplyGrants,
} from '../src/host/applyGrant.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { listChain } from '../src/host/auditChainService.js';

const TENANT = 'user:t-grant';
const BASE = {
  tenantId: TENANT, orgId: 'org-1', subjectId: 'subj-1', grantedBy: 'user-1',
  campaignId: 'camp-1', maxSubmits: 5, maxPrepared: 3, ratePerHour: 4,
  origins: ['boards.example.com'], resumePolicy: 'default',
};
const future = () => new Date(Date.now() + 86_400_000).toISOString();

const mint = (over: Partial<Parameters<typeof createApplyGrant>[0]> = {}) =>
  createApplyGrant({ ...BASE, expiresAt: future(), ...over });

const consult = (over: Partial<Parameters<typeof consultApplyGrant>[0]> = {}) =>
  consultApplyGrant({
    tenantId: TENANT, subjectId: 'subj-1', campaignId: 'camp-1',
    origin: 'boards.example.com', commitClass: 'submit', tier: 'A', now: Date.now(), ...over,
  });

describe('ADR 0541 D1 — every field is a bound; the schema refuses a non-grant', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it.each([
    ['maxSubmits 0', { maxSubmits: 0 }],
    ['maxSubmits negative', { maxSubmits: -1 }],
    ['maxPrepared 0', { maxPrepared: 0 }],
    ['ratePerHour 0', { ratePerHour: 0 }],
  ])('refuses %s — a grant without a ceiling is the gate turned off', async (_l, over) => {
    await expect(mint(over as never)).rejects.toThrow(/ceiling|positive/i);
  });

  it('refuses an UNSCOPED grant (no origins)', async () => {
    await expect(mint({ origins: [] })).rejects.toThrow(/origins/);
  });

  it('refuses a grant with no expiry — a grant always dies', async () => {
    await expect(mint({ expiresAt: 'not-a-date' })).rejects.toThrow(/expiresAt/);
  });

  it('refuses an unattributable grant', async () => {
    await expect(mint({ grantedBy: '' })).rejects.toThrow(/attributable/);
  });

  it('defaults to tier A only — B is opt-in, C is not representable', async () => {
    const g = await mint();
    expect(g.tiers).toEqual(['A']);
  });
});

describe('ADR 0541 D2 — the gate consults; every refusal is the same outcome', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('allows an in-scope submit', async () => {
    await mint();
    const d = await consult();
    expect(d.allowed).toBe(true);
    expect(d.grantId).not.toBeNull();
  });

  it('NEVER grants a purchase — a grant cannot authorise spending money', async () => {
    await mint();
    // This is the structural check: even with a valid, in-scope, unexhausted
    // grant, a purchase is refused on CLASS before anything else is consulted.
    const d = await consult({ commitClass: 'purchase' });
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe('wrong-class');
  });

  it.each(['download', 'new-origin'] as const)('never grants %s', async (cls) => {
    await mint();
    expect((await consult({ commitClass: cls })).allowed).toBe(false);
  });

  it('never grants tier C — that tier is the human’s by definition', async () => {
    await mint({ tiers: ['A', 'B'] });
    expect((await consult({ tier: 'C' })).allowed).toBe(false);
  });

  it('refuses tier B unless the grant opted in', async () => {
    await mint(); // tiers: ['A']
    expect((await consult({ tier: 'B' })).allowed).toBe(false);
    await mint({ tiers: ['B'], campaignId: 'camp-b' });
    expect((await consult({ tier: 'B', campaignId: 'camp-b' })).allowed).toBe(true);
  });

  it('refuses an out-of-scope origin', async () => {
    await mint();
    const d = await consult({ origin: 'evil.example.com' });
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe('out-of-scope');
  });

  it('refuses an expired grant', async () => {
    await mint({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await consult()).refusal).toBe('expired');
  });

  it('refuses after revocation, immediately', async () => {
    const g = await mint();
    expect((await consult()).allowed).toBe(true);
    await revokeApplyGrant(TENANT, 'org-1', g.grantId, Date.now());
    expect((await consult()).allowed).toBe(false);
  });

  it('consulting NEVER consumes budget — asking is not spending', async () => {
    const g = await mint();
    for (let i = 0; i < 5; i += 1) await consult();
    const after = await applyGrants.get(`${TENANT}:${g.grantId}`);
    expect(after?.submitsUsed).toBe(0);
  });
});

describe('ADR 0541 D3 — the ceiling is a TRUE ceiling', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('stops at maxSubmits, not around it', async () => {
    // ratePerHour raised past the ceiling so THIS test isolates the total —
    // the pace window has its own suite below (WF-JS-1 P1a).
    const g = await mint({ maxSubmits: 3, ratePerHour: 10 });
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await consumeSubmit(TENANT, g.grantId, Date.now()));
    expect(results.filter(Boolean).length).toBe(3);
    expect((await applyGrants.get(`${TENANT}:${g.grantId}`))?.submitsUsed).toBe(3);
  });

  it('holds under CONCURRENCY — the CAS is what makes it a ceiling', async () => {
    // A read-then-write would let parallel claimants overshoot. This is the test
    // that distinguishes a real compare-and-swap from a counter that usually works.
    const g = await mint({ maxSubmits: 4, ratePerHour: 20 });
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => consumeSubmit(TENANT, g.grantId, Date.now())),
    );
    expect(outcomes.filter(Boolean).length, 'more grants than the ceiling allows').toBe(4);
    expect((await applyGrants.get(`${TENANT}:${g.grantId}`))?.submitsUsed).toBe(4);
  });

  it('enforces ratePerHour INSIDE one epoch-hour — the promise the UI makes (WF-JS-1 P1a)', async () => {
    // The grant STORED a rate and nothing kept it: the Authority page says
    // "at most N per hour" and, before P1a, a campaign pass could spend the
    // whole ceiling in one minute. Pin the promise.
    const g = await mint({ maxSubmits: 10, ratePerHour: 2 });
    const now = 7_200_000_000; // an exact hour boundary, deterministic
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await consumeSubmit(TENANT, g.grantId, now + i));
    expect(results, 'the third submit in the hour must refuse').toEqual([true, true, false, false]);
    // …and consult REPORTS the paced state before a caller does any work.
    const decision = await consult({ now: now + 5 });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('paced');
  });

  it('the pace window RESETS on the next epoch-hour; the total ceiling still binds', async () => {
    const g = await mint({ maxSubmits: 3, ratePerHour: 2 });
    const hour0 = 7_200_000_000;
    expect(await consumeSubmit(TENANT, g.grantId, hour0)).toBe(true);
    expect(await consumeSubmit(TENANT, g.grantId, hour0 + 1)).toBe(true);
    expect(await consumeSubmit(TENANT, g.grantId, hour0 + 2)).toBe(false); // paced
    const hour1 = hour0 + 3_600_000;
    expect(await consumeSubmit(TENANT, g.grantId, hour1)).toBe(true); // window reset
    // maxSubmits (3) is now exhausted — the TOTAL ceiling outranks a fresh window.
    expect(await consumeSubmit(TENANT, g.grantId, hour1 + 1)).toBe(false);
    expect((await applyGrants.get(`${TENANT}:${g.grantId}`))?.submitsUsed).toBe(3);
  });

  it('pace holds under CONCURRENCY — racing consumers cannot share the last slot', async () => {
    const g = await mint({ maxSubmits: 10, ratePerHour: 3 });
    const now = 7_200_000_000;
    const outcomes = await Promise.all(
      Array.from({ length: 9 }, (_, i) => consumeSubmit(TENANT, g.grantId, now + i)),
    );
    expect(outcomes.filter(Boolean).length, 'more submits than the hour allows').toBe(3);
    const row = await applyGrants.get(`${TENANT}:${g.grantId}`);
    expect(row?.paceUsed).toBe(3);
    expect(row?.submitsUsed).toBe(3);
  });

  it('bounds the PREPARED backlog separately from submits', async () => {
    // Two ceilings because two things need bounding: a user must never discover
    // that "auto-apply" quietly became a review backlog.
    const g = await mint({ maxSubmits: 10, maxPrepared: 2 });
    const prepared = [];
    for (let i = 0; i < 5; i += 1) prepared.push(await consumePrepared(TENANT, g.grantId, Date.now()));
    expect(prepared.filter(Boolean).length).toBe(2);
    // …and the submit budget is untouched by preparation.
    expect((await applyGrants.get(`${TENANT}:${g.grantId}`))?.submitsUsed).toBe(0);
  });

  it('a revoked grant consumes nothing, even mid-campaign', async () => {
    const g = await mint();
    await revokeApplyGrant(TENANT, 'org-1', g.grantId, Date.now());
    expect(await consumeSubmit(TENANT, g.grantId, Date.now())).toBe(false);
  });
});

describe('ADR 0541 D3b — never apply twice to the same job', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('a second claim for the same (subject, listing) is refused', async () => {
    const g = await mint();
    expect(await claimSubmission(TENANT, 'subj-1', 'listing-1', g.grantId)).toBe(true);
    expect(await claimSubmission(TENANT, 'subj-1', 'listing-1', g.grantId)).toBe(false);
  });

  it('CONCURRENT claims resolve to exactly one winner', async () => {
    // The duplicate must be refused at the store, not discovered at the employer.
    const g = await mint();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => claimSubmission(TENANT, 'subj-1', 'listing-race', g.grantId)),
    );
    expect(outcomes.filter(Boolean).length).toBe(1);
  });

  it('different listings and different subjects claim independently', async () => {
    const g = await mint();
    expect(await claimSubmission(TENANT, 'subj-1', 'listing-a', g.grantId)).toBe(true);
    expect(await claimSubmission(TENANT, 'subj-1', 'listing-b', g.grantId)).toBe(true);
    expect(await claimSubmission(TENANT, 'subj-2', 'listing-a', g.grantId)).toBe(true);
  });
});


describe('ADR 0464 — subject erasure actually erases', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('deletes the subject’s grants and claims — a classification entry is a promise, this is the proof', async () => {
    const g = await mint();
    await claimSubmission(TENANT, 'subj-1', 'listing-1', g.grantId);
    expect(await applyGrants.get(`${TENANT}:${g.grantId}`)).toBeTruthy();

    await eraseSubjectApplyGrants(TENANT, 'subj-1');

    // DELETED, not redacted: a tombstone that still authorises submissions on a
    // person's behalf is worse than no record at all.
    expect(await applyGrants.get(`${TENANT}:${g.grantId}`)).toBeFalsy();
    expect(await submissionClaims.get(`${TENANT}:subj-1:listing-1`)).toBeFalsy();
  });

  it('erases a grant naming the subject as the AUTHORISER too', async () => {
    // `grantedBy` is a person as well; leaving them named on a live authority
    // record would be a partial erasure that reads as complete.
    const g = await mint({ subjectId: 'other-subj', grantedBy: 'user-erased' });
    await eraseSubjectApplyGrants(TENANT, 'user-erased');
    expect(await applyGrants.get(`${TENANT}:${g.grantId}`)).toBeFalsy();
  });

  it('leaves OTHER subjects untouched — erasure must not over-reach', async () => {
    const mine = await mint({ subjectId: 'subj-keep', campaignId: 'camp-keep' });
    await eraseSubjectApplyGrants(TENANT, 'subj-1');
    expect(await applyGrants.get(`${TENANT}:${mine.grantId}`)).toBeTruthy();
  });
});


describe('ADR 0541 D4/D5 — replay spends nothing; every spend is attributable', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('a REPLAYED consult is refused before any store read', async () => {
    await mint();
    const live = await consult();
    expect(live.allowed).toBe(true);
    const replayed = await consult({ isReplay: true });
    expect(replayed.allowed).toBe(false);
    expect(replayed.refusal).toBe('replay');
  });

  it('a forked run consumes ZERO budget', async () => {
    const g = await mint();
    // The fork path consults and is refused, so it never reaches consume.
    const d = await consult({ isReplay: true });
    expect(d.grantId).toBeNull();
    expect((await applyGrants.get(`${TENANT}:${g.grantId}`))?.submitsUsed).toBe(0);
  });

  it('every consumption writes an attributable audit row', async () => {
    // D5 — a user must be able to answer "what did it submit on my behalf, and
    // under what authority" without reading logs.
    const g = await mint();
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:app-1');
    const rows = (await listChain(TENANT)).filter((r) => r.kind === 'job-search.grant.consumed');
    expect(rows).toHaveLength(1);
    const p = rows[0]!.payload as Record<string, unknown>;
    expect(p.grantId).toBe(g.grantId);
    expect(p.subjectId).toBe('subj-1');
    expect(p.grantedBy, 'WHO authorised it must be on the row').toBe('user-1');
    expect(p.dealId).toBe('deal:app-1');
    expect(p.submitsUsed).toBe(1);
  });

  it('a REFUSED consumption writes NO audit row — the ledger records spends, not attempts', async () => {
    const g = await mint({ maxSubmits: 1 });
    await consumeSubmit(TENANT, g.grantId, Date.now());
    await consumeSubmit(TENANT, g.grantId, Date.now()); // over the ceiling
    const rows = (await listChain(TENANT)).filter((r) => r.kind === 'job-search.grant.consumed');
    expect(rows, 'an attempt that spent nothing must not appear as a spend').toHaveLength(1);
  });
});


describe('/code-review — revoke is ORG-scoped, not merely tenant-scoped', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('a caller authorised on another org cannot revoke this grant', async () => {
    // The key is tenant-scoped, so a cross-TENANT id was already unreachable.
    // The gap was INSIDE a tenant: the list route filters on orgId and revoke
    // did not, so read and write disagreed about who owns a grant.
    const g = await mint({ orgId: 'org-1' });
    expect(await revokeApplyGrant(TENANT, 'org-2', g.grantId, Date.now()), 'cross-org revoke must fail').toBe(false);
    expect((await applyGrants.get(`${TENANT}:${g.grantId}`))?.revokedAt).toBeUndefined();
    // …and the rightful org still can.
    expect(await revokeApplyGrant(TENANT, 'org-1', g.grantId, Date.now())).toBe(true);
  });
});
