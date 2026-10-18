/**
 * ADR 0458 Phase 0 — kicktodo-core compliance seam.
 *
 * The package registers ONE subject-eraser (enrollments + occurrences + check-ins +
 * evidence + invites + subject→contact link), ONE retention-purger (check-ins +
 * evidence, `confidential-pii`, aged on their natural timestamp), and ONE subject-key
 * resolver over the authoritative subject↔contact bridge (both directions).
 *
 * Rows are seeded through minimal DurableCollections over the REAL namespaces (the
 * `retention-purgers.test.ts` pattern) — the eraser/purger read the same backend — and
 * the contact link through the real write path so the tenant index markers exist.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import {
  eraseSubject,
  __resetSubjectErasers,
  __resetSubjectKeyResolvers,
} from '../src/host/subjectErasure.js';
import { purgeRetained, __resetRetentionPurgers } from '../src/host/retentionPurger.js';
import { registerKicktodoCoreCompliance } from '../src/features/kicktodo-core/compliance.js';
import {
  onEnrollmentDeleted,
  __resetEnrollmentLifecycleHooks,
  type EnrollmentDeletedEvent,
} from '../src/features/kicktodo-core/enrollmentLifecycle.js';
import {
  linkSubjectToContact,
  linkedContactIdsForSubject,
  subjectsForContact,
  __resetContactBridge,
} from '../src/features/kicktodo-core/contactBridgeService.js';
import { __test as enrollmentStore } from '../src/features/kicktodo-core/enrollmentService.js';
import type { ChallengeEnrollment, KickTodoActionOccurrence, CheckIn } from '../src/features/kicktodo-core/types.js';
import type { ProgressEvidenceSnapshot } from '../src/features/kicktodo-core/progressService.js';
import type { InviteRow } from '../src/features/kicktodo-core/inviteService.js';

const DAY = 86_400_000;
const now = 1_900_000_000_000;
const cutoffIso = new Date(now - 365 * DAY).toISOString();
const OLD = new Date(now - 400 * DAY).toISOString();
const FRESH = new Date(now - 10 * DAY).toISOString();

// The enrollment + occurrence stores are the product's own (`__test`); the other
// three stores export no seam, so they are opened over the REAL namespaces with the
// product's row TYPES (todayService/progressService/inviteService key formulas,
// copied — a renamed key there makes these reads miss and the case red, not green).
const enrollCol = () => enrollmentStore.enrollments;
const occCol = () => enrollmentStore.occurrences;
const checkCol = () => new DurableCollection<CheckIn>(
  'kicktodo-checkins', (c) => `${c.tenantId}::${c.enrollmentId}::${c.cardId}`);
const evidenceCol = () => new DurableCollection<ProgressEvidenceSnapshot>(
  'kicktodo-evidence', (s) => `${s.tenantId}::${s.enrollmentId}::${s.id}`);
const inviteCol = () => new DurableCollection<InviteRow>(
  'kicktodo-invites', (r) => r.tokenHash);
const inviteIdxCol = () => new DurableCollection<{ tenantId: string; challengeId: string; inviterSubject: string; tokenHash: string }>(
  'kicktodo-invite-index', (r) => `${r.tenantId}::${r.challengeId}::${r.inviterSubject}`);

const enrollmentRow = (id: string, tenantId: string, ownerSubject: string): ChallengeEnrollment => ({
  id, tenantId, ownerSubject, challengeId: 'ch1', challengeVersion: 1, challengeContentHash: 'sha256:x',
  state: 'active', goalId: `goal:${id}`, boardId: `board:${ownerSubject}`, planRevision: 1,
  timezone: 'UTC', startDateLocal: '2026-01-01', createdAt: FRESH,
});
const occurrenceRow = (tenantId: string, enrollmentId: string, cardId: string): KickTodoActionOccurrence => ({
  cardId, tenantId, enrollmentId, challengeVersion: 1, stableActivityId: 'a1',
  occurrenceDateLocal: '2026-01-01', planRevision: 1, evidencePolicy: 'attestation', createdAt: FRESH,
});
const checkInRow = (tenantId: string, enrollmentId: string, cardId: string, ownerSubject: string, createdAt: string): CheckIn => ({
  cardId, tenantId, enrollmentId, ownerSubject, note: 'my private note', createdAt,
});
const evidenceRow = (id: string, tenantId: string, enrollmentId: string, asOf: string): ProgressEvidenceSnapshot => ({
  id, tenantId, enrollmentId, challengeId: 'ch1', challengeVersion: 1, challengeContentHash: 'sha256:x',
  planRevision: 1, asOf, totalRequiredActivities: 1, completedActivities: 0, checkInCount: 0,
  occurrences: [], snapshotHash: 'sha256:y',
});

const T = 'tenant-kt-core';
const T2 = 'tenant-kt-core-other';
const A = 'user:alice';
const B = 'user:bob';

/** Seed the full footprint of one subject in one tenant. */
async function seedSubject(tenantId: string, subject: string, tag: string): Promise<void> {
  const enrollmentId = `enr:${tag}`;
  await enrollCol().put(enrollmentRow(enrollmentId, tenantId, subject));
  await occCol().put(occurrenceRow(tenantId, enrollmentId, `card:${tag}`));
  await checkCol().put(checkInRow(tenantId, enrollmentId, `card:${tag}`, subject, FRESH));
  await evidenceCol().put(evidenceRow(`ev:${tag}`, tenantId, enrollmentId, FRESH));
  await inviteCol().put({ tokenHash: `hash:${tag}`, tenantId, challengeId: 'ch1', inviterSubject: subject, createdAt: FRESH });
  await inviteIdxCol().put({ tenantId, challengeId: 'ch1', inviterSubject: subject, tokenHash: `hash:${tag}` });
  await linkSubjectToContact(tenantId, subject, `crm:${tag}`, 'paid-checkout');
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  __resetRetentionPurgers();
  __resetEnrollmentLifecycleHooks();
  await __resetContactBridge();
  registerKicktodoCoreCompliance();
});

describe('kicktodo-core subject eraser', () => {
  it('erases ALL of subject A; leaves B and the other tenant intact', async () => {
    await seedSubject(T, A, 'alice');
    await seedSubject(T, B, 'bob');
    await seedSubject(T2, A, 'alice-t2');

    const res = await eraseSubject(T, A);
    expect(res.failed).toBe(0);
    // The resolver expanded A → its linked contactId (A + crm:alice; the second hop
    // from crm:alice finds only A again), so downstream erasers reach it.
    expect(res.keysResolved).toBe(2);

    // A's rows in T are gone — every store the eraser claims, read back.
    expect(await enrollCol().get(`${T}::enr:alice`)).toBeNull();
    expect(await occCol().get(`${T}::enr:alice::2026-01-01::a1::r1`)).toBeNull();
    expect(await checkCol().get(`${T}::enr:alice::card:alice`)).toBeNull();
    expect(await evidenceCol().get(`${T}::enr:alice::ev:alice`)).toBeNull();
    expect(await inviteCol().get('hash:alice')).toBeNull();
    expect(await inviteIdxCol().get(`${T}::ch1::${A}`)).toBeNull();
    expect(await linkedContactIdsForSubject(T, A)).toEqual([]);

    // Co-subject B's rows in T untouched — the same seven stores.
    expect(await enrollCol().get(`${T}::enr:bob`)).not.toBeNull();
    expect(await occCol().get(`${T}::enr:bob::2026-01-01::a1::r1`)).not.toBeNull();
    expect(await checkCol().get(`${T}::enr:bob::card:bob`)).not.toBeNull();
    expect(await evidenceCol().get(`${T}::enr:bob::ev:bob`)).not.toBeNull();
    expect(await inviteCol().get('hash:bob')).not.toBeNull();
    expect(await inviteIdxCol().get(`${T}::ch1::${B}`)).not.toBeNull();
    expect(await linkedContactIdsForSubject(T, B)).toEqual(['crm:bob']);

    // The SAME subject A in the OTHER tenant untouched (tenant-scoped erasure) — the
    // same seven stores. The invite store is scanned GLOBALLY (`invites.list()`), so
    // only its tenant filter keeps hash:alice-t2 alive.
    expect(await enrollCol().get(`${T2}::enr:alice-t2`)).not.toBeNull();
    expect(await occCol().get(`${T2}::enr:alice-t2::2026-01-01::a1::r1`)).not.toBeNull();
    expect(await checkCol().get(`${T2}::enr:alice-t2::card:alice-t2`)).not.toBeNull();
    expect(await evidenceCol().get(`${T2}::enr:alice-t2::ev:alice-t2`)).not.toBeNull();
    expect(await inviteCol().get('hash:alice-t2')).not.toBeNull();
    expect(await inviteIdxCol().get(`${T2}::ch1::${A}`)).not.toBeNull();
    expect(await linkedContactIdsForSubject(T2, A)).toEqual(['crm:alice-t2']);
  });

  it('is idempotent — a second erase removes nothing new and does not throw', async () => {
    await seedSubject(T, A, 'alice');
    await seedSubject(T, B, 'bob');
    await eraseSubject(T, A);
    const res = await eraseSubject(T, A);
    expect(res.failed).toBe(0);
    expect(await enrollCol().get(`${T}::enr:alice`)).toBeNull();
    // The repeat pass did not over-reach onto the co-subject.
    expect(await enrollCol().get(`${T}::enr:bob`)).not.toBeNull();
    expect(await checkCol().get(`${T}::enr:bob::card:bob`)).not.toBeNull();
  });
});

describe('kicktodo-core retention purger (check-ins + evidence, confidential-pii)', () => {
  it('deletes strictly-older rows, keeps fresh + cutoff-equal, no-ops on wrong classification / falsy tenant', async () => {
    // check-ins
    await checkCol().put(checkInRow(T, 'e1', 'c-old', A, OLD));
    await checkCol().put(checkInRow(T, 'e1', 'c-fresh', A, FRESH));
    await checkCol().put(checkInRow(T, 'e1', 'c-edge', A, cutoffIso));
    // evidence
    await evidenceCol().put(evidenceRow('ev-old', T, 'e1', OLD));
    await evidenceCol().put(evidenceRow('ev-fresh', T, 'e1', FRESH));
    // other tenant, aged — must never be crossed
    await checkCol().put(checkInRow(T2, 'e1', 'c-other', A, OLD));

    // wrong classification → no-op
    const internalRun = await purgeRetained(T, 'internal', cutoffIso);
    expect(internalRun.find((r) => r.feature === 'kicktodo-core')?.deleted).toBe(0);
    // falsy tenant → no-op
    expect(await purgeRetained('', 'confidential-pii', cutoffIso)).toEqual([]);

    const run = await purgeRetained(T, 'confidential-pii', cutoffIso);
    expect(run.find((r) => r.feature === 'kicktodo-core')).toMatchObject({ deleted: 2, ok: true }); // c-old + ev-old

    expect(await checkCol().get(`${T}::e1::c-old`)).toBeNull();
    expect(await checkCol().get(`${T}::e1::c-fresh`)).not.toBeNull();
    expect(await checkCol().get(`${T}::e1::c-edge`)).not.toBeNull(); // equal to cutoff → retained (strict <)
    expect(await evidenceCol().get(`${T}::e1::ev-old`)).toBeNull();
    expect(await evidenceCol().get(`${T}::e1::ev-fresh`)).not.toBeNull();
    expect(await checkCol().get(`${T2}::e1::c-other`)).not.toBeNull(); // other tenant intact
  });
});

describe('kicktodo-core onEnrollmentDeleted lifecycle seam', () => {
  // KTA-11 / KTINT-1 (KickTodo wave 4C) — the event also carries the deleted row's
  // owner: consumers that act FOR the participant (calendar removal) or tell their
  // rows from a later owner's (a handed-over circle) cannot read it back.
  it('fires (tenantId + enrollmentId + ownerSubject) AFTER an enrollment is deleted by the subject eraser', async () => {
    const fired: EnrollmentDeletedEvent[] = [];
    onEnrollmentDeleted('test-consumer', async (e) => { fired.push(e); });
    await enrollCol().put(enrollmentRow('enr:zoe', T, A));

    await eraseSubject(T, A);

    expect(fired).toContainEqual({ tenantId: T, enrollmentId: 'enr:zoe', ownerSubject: A });
    expect(await enrollCol().get(`${T}::enr:zoe`)).toBeNull(); // row actually gone
  });

  it('a throwing handler does NOT break the deletion; other handlers still run', async () => {
    const ran: string[] = [];
    onEnrollmentDeleted('boom', async () => { throw new Error('nope'); });
    onEnrollmentDeleted('ok', async (e) => { ran.push(e.enrollmentId); });
    await enrollCol().put(enrollmentRow('enr:kai', T, A));

    const res = await eraseSubject(T, A);
    expect(res.failed).toBe(0);
    expect(await enrollCol().get(`${T}::enr:kai`)).toBeNull(); // deletion completed despite the throw
    expect(ran).toContain('enr:kai');                          // best-effort sibling still ran
  });
});

describe('kicktodo-core subject-key resolver (contact bridge, both directions)', () => {
  it('forward: a subject resolves to its linked contactId; reverse: a contactId resolves to its subject(s)', async () => {
    await linkSubjectToContact(T, A, 'crm:alice', 'paid-checkout');
    await linkSubjectToContact(T, B, 'crm:alice', 'reminder-consent'); // two subjects → one contact
    const C = 'user:carol';
    await linkSubjectToContact(T, C, 'crm:carol', 'paid-checkout');   // a link to a DIFFERENT contact
    await linkSubjectToContact(T2, 'user:dave', 'crm:alice', 'paid-checkout'); // same contact id, other tenant

    // forward
    expect(await linkedContactIdsForSubject(T, A)).toEqual(['crm:alice']);
    // reverse (bounded list + filter): exactly the two subjects on crm:alice — not C
    // (positive control: C's link exists), not the other tenant's dave.
    expect(await linkedContactIdsForSubject(T, C)).toEqual(['crm:carol']);
    expect((await subjectsForContact(T, 'crm:alice')).sort()).toEqual([A, B].sort());
    // tenant-scoped
    expect(await linkedContactIdsForSubject(T2, A)).toEqual([]);
  });

  it('a DSAR keyed on the CONTACT id reaches the linked subject\'s KickTodo footprint (reverse hop through eraseSubject)', async () => {
    await seedSubject(T, A, 'alice'); // links A → crm:alice
    await seedSubject(T, B, 'bob');   // links B → crm:bob

    const res = await eraseSubject(T, 'crm:alice');
    expect(res.failed).toBe(0);
    expect(res.keysResolved).toBe(2); // crm:alice + A

    expect(await enrollCol().get(`${T}::enr:alice`)).toBeNull();
    expect(await checkCol().get(`${T}::enr:alice::card:alice`)).toBeNull();
    expect(await linkedContactIdsForSubject(T, A)).toEqual([]);
    // B (a different contact) is untouched.
    expect(await enrollCol().get(`${T}::enr:bob`)).not.toBeNull();
    expect(await linkedContactIdsForSubject(T, B)).toEqual(['crm:bob']);
  });
});
