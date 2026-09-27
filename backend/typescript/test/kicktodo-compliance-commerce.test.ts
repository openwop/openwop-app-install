/**
 * ADR 0458 Phase 0 — kicktodo-commerce compliance seam.
 *
 * The money adapter registers ONE subject-eraser that:
 *  - ANONYMIZES the per-buyer challenge entitlement (money-relevant evidence of a paid
 *    order — the row survives under a deterministic anonymized key, preserving
 *    orderId/challenge/state; the person↔entitlement link is severed), and
 *  - DELETES the subject↔affiliate-code linkage (the pure identity bridge).
 * There is NO retention-purger (no confidential-pii aged row) and NO subject-key
 * resolver (the identity bridge that backs one lives in kicktodo-core).
 *
 * Rows are seeded through minimal DurableCollections over the REAL namespaces (the
 * affiliate reverse index carries `tenantOf`, mirrored here so its tenant markers
 * exist for the eraser's indexed read).
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSubject, __resetSubjectErasers, __resetSubjectKeyResolvers } from '../src/host/subjectErasure.js';
import { registerKicktodoCommerceCompliance } from '../src/features/kicktodo-commerce/compliance.js';

const nowIso = new Date().toISOString();

const entCol = () => new DurableCollection<{ tenantId: string; buyerSubject: string; challengeId: string; challengeVersion: number; orderId: string; state: string; grantedAt: string }>(
  'kicktodo-entitlements', (e) => `${e.tenantId}::${e.buyerSubject}::${e.challengeId}::v${e.challengeVersion}`);
const affLinkCol = () => new DurableCollection<{ tenantId: string; ownerSubject: string; orgId: string; affiliateId: string; code: string; createdAt: string }>(
  'kicktodo-subject-affiliate', (l) => `${l.tenantId}::${l.ownerSubject}`, undefined, (l) => l.tenantId);
const codeIdxCol = () => new DurableCollection<{ tenantId: string; code: string; ownerSubject: string; affiliateId: string }>(
  'kicktodo-affiliate-code-subject', (c) => `${c.tenantId}::${c.code}`, undefined, (c) => c.tenantId);

const T = 'tenant-kt-commerce';
const T2 = 'tenant-kt-commerce-other';
const A = 'user:alice';
const B = 'user:bob';

const anonOf = (tenantId: string, subject: string): string =>
  `erased:${createHash('sha256').update(`${tenantId}::${subject}`).digest('hex').slice(0, 24)}`;

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  registerKicktodoCommerceCompliance();
});

describe('kicktodo-commerce subject eraser', () => {
  it('ANONYMIZES A\'s entitlements (money-truth preserved) and DELETES A\'s affiliate linkage; B + other tenant intact', async () => {
    await entCol().put({ tenantId: T, buyerSubject: A, challengeId: 'ch1', challengeVersion: 1, orderId: 'ord-A', state: 'active', grantedAt: nowIso });
    await entCol().put({ tenantId: T, buyerSubject: B, challengeId: 'ch1', challengeVersion: 1, orderId: 'ord-B', state: 'active', grantedAt: nowIso });
    await entCol().put({ tenantId: T2, buyerSubject: A, challengeId: 'ch1', challengeVersion: 1, orderId: 'ord-A2', state: 'active', grantedAt: nowIso });
    await affLinkCol().put({ tenantId: T, ownerSubject: A, orgId: 'org', affiliateId: 'aff-A', code: 'KT-AAA', createdAt: nowIso });
    await codeIdxCol().put({ tenantId: T, code: 'KT-AAA', ownerSubject: A, affiliateId: 'aff-A' });
    await affLinkCol().put({ tenantId: T, ownerSubject: B, orgId: 'org', affiliateId: 'aff-B', code: 'KT-BBB', createdAt: nowIso });
    await codeIdxCol().put({ tenantId: T, code: 'KT-BBB', ownerSubject: B, affiliateId: 'aff-B' });

    const res = await eraseSubject(T, A);
    expect(res.failed).toBe(0);

    // Entitlement anonymized, NOT deleted — the paid-order evidence survives under the token.
    expect(await entCol().get(`${T}::${A}::ch1::v1`)).toBeNull();
    const anon = await entCol().get(`${T}::${anonOf(T, A)}::ch1::v1`);
    expect(anon).toMatchObject({ orderId: 'ord-A', state: 'active', buyerSubject: anonOf(T, A) });

    // Affiliate linkage (both directions) deleted.
    expect(await affLinkCol().get(`${T}::${A}`)).toBeNull();
    expect(await codeIdxCol().get(`${T}::KT-AAA`)).toBeNull();

    // B intact.
    expect(await entCol().get(`${T}::${B}::ch1::v1`)).not.toBeNull();
    expect(await affLinkCol().get(`${T}::${B}`)).not.toBeNull();
    expect(await codeIdxCol().get(`${T}::KT-BBB`)).not.toBeNull();

    // A's OTHER-tenant entitlement untouched (tenant-scoped).
    expect(await entCol().get(`${T2}::${A}::ch1::v1`)).not.toBeNull();
  });

  it('is idempotent — a re-erase finds A already anonymized and changes nothing more', async () => {
    await entCol().put({ tenantId: T, buyerSubject: A, challengeId: 'ch1', challengeVersion: 1, orderId: 'ord-A', state: 'active', grantedAt: nowIso });
    await eraseSubject(T, A);
    await eraseSubject(T, A);
    // Exactly ONE anonymized row (no duplicate / re-anonymize churn).
    const rows = (await entCol().list()).filter((e) => e.tenantId === T && e.challengeId === 'ch1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.buyerSubject).toBe(anonOf(T, A));
  });
});
