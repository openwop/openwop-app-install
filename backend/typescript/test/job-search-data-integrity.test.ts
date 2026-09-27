/**
 * Job-search data-integrity batch (DATA-ASSESSMENT-job-search-vertical):
 *
 *  - JS-RI-1 — deleting a CRM deal cascades to follow-ups, drafts and digests
 *    (mechanism + the ADR 0283 seam wiring, both polarities: the other deal's
 *    rows and non-deal entities survive).
 *  - JS-DATA-3 / JS-RI-2 — ERASURE deletes the attestation hash-index rows
 *    (tokens stop resolving entirely); REVOCATION keeps them (revoked must
 *    stay distinguishable from unknown through the same lookup).
 *  - JS-DATA-1 — the answers collection is module-private; `putAnswerRow` (the
 *    one direct write path) re-checks the special-category refusal.
 *  - The purger misbinding regression: the seam calls
 *    `purge(tenantId, CLASSIFICATION, cutoffIso)`; the old two-param binding
 *    compared timestamps against the classification STRING, so one sweep of
 *    any classification deleted the store's every row. Pinned by the only
 *    case that discriminates: a PAST cutoff must retain fresh rows.
 *  - JS-DATA-5 — digests age out under `internal` (business content), not
 *    under a subject sweep.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  issueAttestation, resolveAttestation, revokeAttestation, eraseSubjectAttestations,
  __hashIndexCountForTest, type IssueResult,
} from '../src/features/job-search/attestation/token.js';
import { createApplyGrant, consumeSubmit } from '../src/host/applyGrant.js';
import { cascadeDealDeletion, registerJobSearchCrmCascade } from '../src/features/job-search/lifecycle/crmCascade.js';
import { followUps } from '../src/features/job-search/lifecycle/followUps.js';
import { drafts } from '../src/features/job-search/lifecycle/drafts.js';
import { jobDigests, type JobDigest } from '../src/features/job-search/domain/digest.js';
import { recordAnswer, listAnswers, putAnswerRow } from '../src/features/job-search/autopilot/answerBank.js';
import { fireCrmRecordDeleted, __resetCrmRecordLifecycleHooks } from '../src/host/crmRecordLifecycle.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-jsdata';
const ME = 'subj-1';
const NOW = new Date().toISOString();

const followUp = (dealId: string, stage = 'applied') => ({
  tenantId: T, dealId, stage, subjectId: ME, dueAt: NOW, createdAt: NOW,
});
const draft = (dealId: string) => ({
  tenantId: T, dealId, kind: 'prep-sheet' as const, subjectId: ME, body: 'prep', createdAt: NOW,
});
const digest = (dealId: string, version = 1): JobDigest => ({
  dealId, tenantId: T, version, title: 'SWE', companyName: 'Acme', location: null,
  remote: null, skills: [], requirements: [], responsibilities: [], descriptionExcerpt: '',
  employmentType: 'unknown', sponsorship: 'silent', citizenshipRequirementQuote: null,
  clearanceRequirementQuote: null, sponsorshipQuote: null, salaryMin: null, salaryMax: null,
  currency: null, sourceUrl: null, capturedAt: NOW,
});

async function seedDealRows(dealId: string): Promise<void> {
  await followUps.put(followUp(dealId));
  await drafts.put(draft(dealId));
  await jobDigests.put(digest(dealId));
}
async function rowsFor(dealId: string): Promise<number> {
  const f = (await followUps.listByPrefix(`${T}:`)).filter((r) => r.dealId === dealId).length;
  const d = (await drafts.listByPrefix(`${T}:`)).filter((r) => r.dealId === dealId).length;
  const g = (await jobDigests.listByPrefix(`${T}:${dealId}:`)).length;
  return f + d + g;
}

beforeEach(() => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(':memory:'));
  __resetCrmRecordLifecycleHooks();
});

describe('JS-RI-1 — deal-deletion cascade', () => {
  it('deletes the deal\'s follow-ups, drafts and digests; the OTHER deal\'s rows survive', async () => {
    await seedDealRows('deal:gone');
    await seedDealRows('deal:kept');
    expect(await rowsFor('deal:gone')).toBe(3);
    const removed = await cascadeDealDeletion(T, 'deal:gone');
    expect(removed).toBe(3);
    expect(await rowsFor('deal:gone')).toBe(0);
    expect(await rowsFor('deal:kept')).toBe(3); // untouched
  });

  it('is idempotent and fail-closed on falsy ids', async () => {
    await seedDealRows('deal:x');
    await cascadeDealDeletion(T, 'deal:x');
    expect(await cascadeDealDeletion(T, 'deal:x')).toBe(0); // second run: nothing left
    await seedDealRows('deal:y');
    expect(await cascadeDealDeletion('', 'deal:y')).toBe(0); // falsy tenant: no sweep
    expect(await rowsFor('deal:y')).toBe(3);
  });

  it('rides the ADR 0283 seam: a deal deletion fires it; a CONTACT deletion does not', async () => {
    registerJobSearchCrmCascade();
    await seedDealRows('deal:seam');
    await fireCrmRecordDeleted({ tenantId: T, entity: 'contact', recordId: 'deal:seam' });
    expect(await rowsFor('deal:seam')).toBe(3); // wrong entity: untouched
    await fireCrmRecordDeleted({ tenantId: T, entity: 'deal', recordId: 'deal:seam' });
    expect(await rowsFor('deal:seam')).toBe(0);
  });
});

describe('JS-DATA-3 / JS-RI-2 — hash index vs erasure vs revocation', () => {
  async function issuedAttestation(dealId: string, subjectId = ME): Promise<IssueResult> {
    const g = await createApplyGrant({
      tenantId: T, orgId: 'org-1', subjectId, grantedBy: 'user-auth',
      campaignId: 'camp-1', maxSubmits: 20, maxPrepared: 5, ratePerHour: 4,
      origins: ['boards.example.com'], resumePolicy: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await consumeSubmit(T, g.grantId, Date.now(), dealId);
    const r = await issueAttestation({ tenantId: T, dealId, issuedBy: subjectId, now: Date.now() });
    if ('refused' in r) throw new Error(`refused: ${r.refused}`);
    return r;
  }

  it('REVOCATION keeps the index row (revoked ≠ unknown); ERASURE deletes it (tokens stop resolving)', async () => {
    const a = await issuedAttestation('deal:att');
    expect(await __hashIndexCountForTest(T)).toBe(1);
    await revokeAttestation(T, a.attestationId, Date.now());
    // The revoked record must stay REACHABLE through the same lookup.
    expect(await __hashIndexCountForTest(T)).toBe(1);
    await eraseSubjectAttestations(T, ME);
    expect(await __hashIndexCountForTest(T)).toBe(0); // the index does not outlive erasure
    expect(await resolveAttestation(a.token)).toBeNull();
  });

  it('erasing one subject leaves another subject\'s index rows alone', async () => {
    // BOTH subjects hold an attestation — a probe proved the empty-erasure
    // variant of this test cannot see an over-broad delete (erasedIds is
    // empty for a subject with no attestations, so the loop never runs).
    await issuedAttestation('deal:mine', ME);
    await issuedAttestation('deal:theirs', 'subj-2');
    expect(await __hashIndexCountForTest(T)).toBe(2);
    await eraseSubjectAttestations(T, ME);
    expect(await __hashIndexCountForTest(T)).toBe(1); // subj-2's row survives
  });
});

describe('JS-DATA-1 — the guarded direct write path', () => {
  it('putAnswerRow refuses a special-category question and stores nothing', async () => {
    const out = await putAnswerRow({
      tenantId: T, subjectId: ME, questionKey: 'k', questionText: 'Do you have a disability?',
      value: 'x', source: 'user', confirmedAt: NOW, usageCount: 0, updatedAt: NOW,
    });
    expect(out).toEqual({ refused: 'special-category' });
    expect(await listAnswers(T, ME)).toEqual([]);
  });

  it('putAnswerRow stores an innocuous row (the positive polarity)', async () => {
    const out = await putAnswerRow({
      tenantId: T, subjectId: ME, questionKey: 'links.portfolio', questionText: 'Portfolio URL',
      value: 'https://me.example', source: 'user', confirmedAt: NOW, usageCount: 0, updatedAt: NOW,
    });
    expect('refused' in out).toBe(false);
    expect((await listAnswers(T, ME)).length).toBe(1);
  });
});

describe('retention purgers — classification-gated with a REAL cutoff (the misbinding regression)', () => {
  it('a PAST cutoff retains fresh rows on every job-search store (the only discriminating case)', async () => {
    const r = await recordAnswer({ tenantId: T, subjectId: ME, questionText: 'Years of experience', value: '9', source: 'user', confirmed: true, now: Date.now() });
    expect('refused' in r).toBe(false);
    await seedDealRows('deal:ret');
    // Under the old binding the classification string arrived as the cutoff and
    // every ISO date sorts before 'confidential-pii' — everything died.
    await purgeRetained(T, 'confidential-pii', '2000-01-01T00:00:00.000Z');
    expect((await listAnswers(T, ME)).length).toBe(1);
    expect(await rowsFor('deal:ret')).toBe(3);
  });

  it('a FUTURE cutoff purges PII stores under confidential-pii but not the internal digest — and vice versa', async () => {
    await recordAnswer({ tenantId: T, subjectId: ME, questionText: 'Years of experience', value: '9', source: 'user', confirmed: true, now: Date.now() });
    await seedDealRows('deal:cls');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await purgeRetained(T, 'confidential-pii', future);
    expect((await listAnswers(T, ME)).length).toBe(0);          // PII store purged
    expect((await followUps.listByPrefix(`${T}:`)).length).toBe(0);
    expect((await drafts.listByPrefix(`${T}:`)).length).toBe(0);
    expect((await jobDigests.listByPrefix(`${T}:deal:cls:`)).length).toBe(1); // internal digest survives a PII sweep
    await purgeRetained(T, 'internal', future);
    expect((await jobDigests.listByPrefix(`${T}:deal:cls:`)).length).toBe(0); // JS-DATA-5 — ages out as internal
  });
});
