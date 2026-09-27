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

const DAY = 86_400_000;
const now = 1_900_000_000_000;
const cutoffIso = new Date(now - 365 * DAY).toISOString();
const OLD = new Date(now - 400 * DAY).toISOString();
const FRESH = new Date(now - 10 * DAY).toISOString();

// Minimal shapes over the real namespaces — only the fields the eraser/purger read.
const enrollCol = () => new DurableCollection<{ id: string; tenantId: string; ownerSubject: string }>(
  'kicktodo-enrollments', (e) => `${e.tenantId}::${e.id}`);
const occCol = () => new DurableCollection<{ tenantId: string; enrollmentId: string; occurrenceDateLocal: string; stableActivityId: string; planRevision: number; cardId: string }>(
  'kicktodo-occurrences', (o) => `${o.tenantId}::${o.enrollmentId}::${o.occurrenceDateLocal}::${o.stableActivityId}::r${o.planRevision}`);
const checkCol = () => new DurableCollection<{ cardId: string; tenantId: string; enrollmentId: string; ownerSubject: string; note?: string; createdAt: string }>(
  'kicktodo-checkins', (c) => `${c.tenantId}::${c.enrollmentId}::${c.cardId}`);
const evidenceCol = () => new DurableCollection<{ id: string; tenantId: string; enrollmentId: string; asOf: string }>(
  'kicktodo-evidence', (s) => `${s.tenantId}::${s.enrollmentId}::${s.id}`);
const inviteCol = () => new DurableCollection<{ tokenHash: string; tenantId: string; challengeId: string; inviterSubject: string; createdAt: string }>(
  'kicktodo-invites', (r) => r.tokenHash);
const inviteIdxCol = () => new DurableCollection<{ tenantId: string; challengeId: string; inviterSubject: string; tokenHash: string }>(
  'kicktodo-invite-index', (r) => `${r.tenantId}::${r.challengeId}::${r.inviterSubject}`);

const T = 'tenant-kt-core';
const T2 = 'tenant-kt-core-other';
const A = 'user:alice';
const B = 'user:bob';

/** Seed the full footprint of one subject in one tenant. */
async function seedSubject(tenantId: string, subject: string, tag: string): Promise<void> {
  const enrollmentId = `enr:${tag}`;
  await enrollCol().put({ id: enrollmentId, tenantId, ownerSubject: subject });
  await occCol().put({ tenantId, enrollmentId, occurrenceDateLocal: '2026-01-01', stableActivityId: 'a1', planRevision: 1, cardId: `card:${tag}` });
  await checkCol().put({ cardId: `card:${tag}`, tenantId, enrollmentId, ownerSubject: subject, note: 'my private note', createdAt: FRESH });
  await evidenceCol().put({ id: `ev:${tag}`, tenantId, enrollmentId, asOf: FRESH });
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
    // The resolver expanded A → its linked contactId (so downstream erasers reach it).
    expect(res.keysResolved).toBeGreaterThanOrEqual(2);

    // A's rows in T are gone.
    expect(await enrollCol().get(`${T}::enr:alice`)).toBeNull();
    expect(await occCol().get(`${T}::enr:alice::2026-01-01::a1::r1`)).toBeNull();
    expect(await checkCol().get(`${T}::enr:alice::card:alice`)).toBeNull();
    expect(await evidenceCol().get(`${T}::enr:alice::ev:alice`)).toBeNull();
    expect(await inviteCol().get('hash:alice')).toBeNull();
    expect(await inviteIdxCol().get(`${T}::ch1::${A}`)).toBeNull();
    expect(await linkedContactIdsForSubject(T, A)).toEqual([]);

    // B's rows in T untouched.
    expect(await enrollCol().get(`${T}::enr:bob`)).not.toBeNull();
    expect(await checkCol().get(`${T}::enr:bob::card:bob`)).not.toBeNull();
    expect(await evidenceCol().get(`${T}::enr:bob::ev:bob`)).not.toBeNull();
    expect(await inviteCol().get('hash:bob')).not.toBeNull();

    // A's rows in the OTHER tenant untouched (tenant-scoped erasure).
    expect(await enrollCol().get(`${T2}::enr:alice-t2`)).not.toBeNull();
    expect(await checkCol().get(`${T2}::enr:alice-t2::card:alice-t2`)).not.toBeNull();
  });

  it('is idempotent — a second erase removes nothing new and does not throw', async () => {
    await seedSubject(T, A, 'alice');
    await eraseSubject(T, A);
    const res = await eraseSubject(T, A);
    expect(res.failed).toBe(0);
    expect(await enrollCol().get(`${T}::enr:alice`)).toBeNull();
  });
});

describe('kicktodo-core retention purger (check-ins + evidence, confidential-pii)', () => {
  it('deletes strictly-older rows, keeps fresh + cutoff-equal, no-ops on wrong classification / falsy tenant', async () => {
    // check-ins
    await checkCol().put({ cardId: 'c-old', tenantId: T, enrollmentId: 'e1', ownerSubject: A, createdAt: OLD });
    await checkCol().put({ cardId: 'c-fresh', tenantId: T, enrollmentId: 'e1', ownerSubject: A, createdAt: FRESH });
    await checkCol().put({ cardId: 'c-edge', tenantId: T, enrollmentId: 'e1', ownerSubject: A, createdAt: cutoffIso });
    // evidence
    await evidenceCol().put({ id: 'ev-old', tenantId: T, enrollmentId: 'e1', asOf: OLD });
    await evidenceCol().put({ id: 'ev-fresh', tenantId: T, enrollmentId: 'e1', asOf: FRESH });
    // other tenant, aged — must never be crossed
    await checkCol().put({ cardId: 'c-other', tenantId: T2, enrollmentId: 'e1', ownerSubject: A, createdAt: OLD });

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
  it('fires (tenantId + enrollmentId) AFTER an enrollment is deleted by the subject eraser', async () => {
    const fired: EnrollmentDeletedEvent[] = [];
    onEnrollmentDeleted('test-consumer', async (e) => { fired.push(e); });
    await enrollCol().put({ id: 'enr:zoe', tenantId: T, ownerSubject: A });

    await eraseSubject(T, A);

    expect(fired).toContainEqual({ tenantId: T, enrollmentId: 'enr:zoe' });
    expect(await enrollCol().get(`${T}::enr:zoe`)).toBeNull(); // row actually gone
  });

  it('a throwing handler does NOT break the deletion; other handlers still run', async () => {
    const ran: string[] = [];
    onEnrollmentDeleted('boom', async () => { throw new Error('nope'); });
    onEnrollmentDeleted('ok', async (e) => { ran.push(e.enrollmentId); });
    await enrollCol().put({ id: 'enr:kai', tenantId: T, ownerSubject: A });

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

    // forward
    expect(await linkedContactIdsForSubject(T, A)).toEqual(['crm:alice']);
    // reverse (bounded list + filter)
    expect((await subjectsForContact(T, 'crm:alice')).sort()).toEqual([A, B].sort());
    // tenant-scoped
    expect(await linkedContactIdsForSubject(T2, A)).toEqual([]);
  });
});
