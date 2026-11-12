/** ADR 0951 P2: a recording grant is a revocable generation, never a boolean
 * copied back over withdrawal. Two real SQLite connections exercise lost CAS
 * and withdrawal between read and write; only the interleaving is injected.
 *
 * Sabotage witnesses (w103; src/features/consent/consentService.ts):
 * keeping a generation through withdrawal, dropping it on an unrelated write,
 * minting a fixed id, or minting for a non-visitor write (w103-cg-*-gen);
 * dropping generations from the history entry (w103-cg-history); checking
 * visitor-only grants on the first attempt only (w103-cg-visitor-first-only);
 * a wrong grant budget, reason, retry bound or refusal test (w103-cg-budget-*,
 * w103-cg-reason, w103-cg-off-by-one, w103-cg-revokes-every); and removing the
 * affirmation re-check on either lane or its revision clause (w103-cg-affirm-*). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  MERGE_REVOKE_ATTEMPTS, getConsent, mergeConsentCategories, recordConsent, type ConsentRecord,
} from '../src/features/consent/consentService.js';
import { setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let b: Storage;
let dir: string;
const tenantId = 'replay-consent-test';
const subjectKey = 'visitor:recording';
const key = `hostext:consent:record:${tenantId}:${subjectKey}`;
const generation = (record: ConsentRecord | null) => record?.strictGrantGenerations?.['analytics.replay'];
const merge = (categories: Record<string, boolean>, source = 'public:client-a') => mergeConsentCategories({ tenantId, subjectKey, categories, source });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-consent-generation-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  b = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
});
// ADR 0951 P2.5: recordings need both replay toggles ON (helpers/replayToggles.ts).
beforeEach(async () => { await setReplayToggles('on'); });
afterEach(async () => {
  vi.restoreAllMocks();
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ADR 0951 P2 — consent-owned recording generations', () => {
  it('unrelated writes preserve a grant; withdrawal and re-grant cannot reopen its generation', async () => {
    const first = await merge({ 'analytics.replay': true });
    const original = generation(first);
    expect(original).toMatch(/^[a-f0-9-]{36}$/);
    expect(generation(await merge({ marketing: false }, 'operator'))).toBe(original);
    expect(generation(await merge({ 'analytics.replay': false }))).toBeUndefined();
    const renewed = await merge({ 'analytics.replay': true });
    expect(generation(renewed)).toMatch(/^[a-f0-9-]{36}$/);
    expect(generation(renewed)).not.toBe(original);
    expect(renewed.history?.[0]).toMatchObject({ strictGrantGenerations: { 'analytics.replay': generation(renewed) } });
  });

  it('a legacy boolean grant needs a fresh visitor affirmation before it has a recording generation', async () => {
    const legacy: ConsentRecord = { tenantId, subjectKey, categories: { necessary: true, analytics: true, marketing: false, 'analytics.replay': true }, source: 'public:client-a', ts: '2026-01-01T00:00:00Z' };
    await b.kvSet(key, JSON.stringify(legacy));
    expect(generation(await merge({ marketing: false }, 'operator'))).toBeUndefined();
    const affirmed = await merge({ 'analytics.replay': true });
    expect(generation(affirmed)).toMatch(/^[a-f0-9-]{36}$/);
    expect(affirmed.history?.[0]).toMatchObject({ strictGrantGenerations: { 'analytics.replay': generation(affirmed) } });
  });

  it('a wholesale carry-forward cannot resurrect a grant withdrawn by another storage client', async () => {
    await merge({ 'analytics.replay': true });
    let withdrew = false;
    const withdraw = async (target: string) => {
      if (target !== key || withdrew) return;
      withdrew = true;
      const raw = await b.kvGet(key);
      expect(raw).not.toBeNull();
      const current = JSON.parse(raw!) as ConsentRecord;
      await b.kvSet(key, JSON.stringify({ ...current, categories: { ...current.categories, 'analytics.replay': false }, strictGrantGenerations: {}, source: 'public:withdrawal' }));
    };
    const set = a.kvSet.bind(a);
    vi.spyOn(a, 'kvSet').mockImplementation(async (...args) => { await withdraw(args[0]); return set(...args); });
    const cas = a.kvCompareAndSwap.bind(a);
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => { await withdraw(args[0]); return cas(...args); });
    await expect(recordConsent({ tenantId, subjectKey, categories: { analytics: true, 'analytics.replay': true }, source: 'operator' }))
      .rejects.toMatchObject({ httpStatus: 400, details: { field: 'categories.analytics.replay' } });
    expect(withdrew).toBe(true);
    const stored = await getConsent(tenantId, subjectKey);
    expect(stored?.categories['analytics.replay']).toBe(false);
    expect(stored?.source).toBe('public:withdrawal');
    expect(generation(stored)).toBeUndefined();
  });

  it('five real CAS conflicts return a retryable conflict without a blind overwrite', async () => {
    await merge({ 'analytics.replay': true });
    let collisions = 0;
    const cas = a.kvCompareAndSwap.bind(a);
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === key) {
        const raw = await b.kvGet(key);
        const current = JSON.parse(raw!) as ConsentRecord;
        collisions += 1;
        await b.kvSet(key, JSON.stringify({ ...current, source: `other-writer-${collisions}` }));
      }
      return cas(...args);
    });
    await expect(merge({ marketing: true }, 'operator')).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'consent_write_contended' } });
    expect(collisions).toBe(5);
    expect((await getConsent(tenantId, subjectKey))?.categories.marketing).toBe(false);
    expect((await getConsent(tenantId, subjectKey))?.source).toBe('other-writer-5');
  });

  it.each(['merge', 'replace'] as const)('an in-flight visitor %s cannot retry its old affirmation over a later withdrawal', async (lane) => {
    await merge({ 'analytics.replay': true });
    let raced = false;
    const cas = a.kvCompareAndSwap.bind(a);
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === key && !raced) {
        raced = true;
        initHostExtPersistence(b);
        try { await merge({ 'analytics.replay': false }); }
        finally { initHostExtPersistence(a); }
      }
      return cas(...args);
    });
    const pending = lane === 'merge' ? merge({ 'analytics.replay': true })
      : recordConsent({ tenantId, subjectKey, categories: { 'analytics.replay': true }, source: 'public:client-a' });
    await expect(pending).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'consent_write_contended' } });
    expect(raced).toBe(true);
    expect((await getConsent(tenantId, subjectKey))?.categories['analytics.replay']).toBe(false);
    expect(generation(await getConsent(tenantId, subjectKey))).toBeUndefined();
    // A new visitor choice after observing the refusal is a legitimate grant.
    expect(generation(await merge({ 'analytics.replay': true }))).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('a revoke-only write outlasts contention a grant would give up on, and still never writes blind', async () => {
    await merge({ 'analytics.replay': true, marketing: true });
    let collisions = 0;
    const cas = a.kvCompareAndSwap.bind(a);
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === key && collisions < 12) {
        const current = JSON.parse((await b.kvGet(key))!) as ConsentRecord;
        collisions += 1;
        await b.kvSet(key, JSON.stringify({ ...current, source: `other-writer-${collisions}` }));
      }
      return cas(...args);
    });
    // A STOP-style revocation lands after 12 real conflicts (a grant stops at 5).
    const revoked = await merge({ marketing: false }, 'keyword:STOP');
    expect(collisions).toBe(12);
    expect(revoked.categories.marketing).toBe(false);
    expect((await getConsent(tenantId, subjectKey))?.categories.marketing).toBe(false);
    // Through CAS on the latest row: the replay grant another writer kept is intact.
    expect((await getConsent(tenantId, subjectKey))?.categories['analytics.replay']).toBe(true);
  });

  // ADR 0951 P2 review #7: the banner's choice is one write carrying grants AND
  // refusals ("analytics yes, recording no"). It got the 5-attempt grant budget,
  // and the SPA did not retry the 409, so the refusal was lost to contention.
  it('a mixed write that carries a refusal gets the revoke budget too', async () => {
    await merge({ 'analytics.replay': true });
    let collisions = 0;
    const cas = a.kvCompareAndSwap.bind(a);
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === key && collisions < 12) {
        const current = JSON.parse((await b.kvGet(key))!) as ConsentRecord;
        collisions += 1;
        await b.kvSet(key, JSON.stringify({ ...current, source: `other-writer-${collisions}` }));
      }
      return cas(...args);
    });
    const written = await merge({ analytics: true, 'analytics.replay': false });
    expect(collisions).toBe(12);
    expect(written.categories['analytics.replay']).toBe(false);
    expect((await getConsent(tenantId, subjectKey))?.categories['analytics.replay']).toBe(false);
  });

  it('a revoke-only write that is contended on every attempt still fails explicitly', async () => {
    await merge({ marketing: true });
    let collisions = 0;
    const cas = a.kvCompareAndSwap.bind(a);
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === key) {
        const current = JSON.parse((await b.kvGet(key))!) as ConsentRecord;
        collisions += 1;
        await b.kvSet(key, JSON.stringify({ ...current, source: `other-writer-${collisions}` }));
      }
      return cas(...args);
    });
    await expect(merge({ marketing: false }, 'keyword:STOP')).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'consent_write_contended' } });
    expect(collisions).toBe(MERGE_REVOKE_ATTEMPTS);
    // No blind put after the budget: the last other writer's row stands.
    const stored = await getConsent(tenantId, subjectKey);
    expect(stored?.categories.marketing).toBe(true);
    expect(stored?.source).toBe(`other-writer-${MERGE_REVOKE_ATTEMPTS}`);
  }, 20_000);

  it('a refused → granted → refused race cannot hide behind the same final boolean', async () => {
    await merge({ 'analytics.replay': false });
    let raced = false;
    const cas = a.kvCompareAndSwap.bind(a);
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === key && !raced) {
        raced = true;
        initHostExtPersistence(b);
        try { await merge({ 'analytics.replay': true }); await merge({ 'analytics.replay': false }); }
        finally { initHostExtPersistence(a); }
      }
      return cas(...args);
    });
    await expect(merge({ 'analytics.replay': true })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'consent_write_contended' } });
    expect(raced).toBe(true);
    expect((await getConsent(tenantId, subjectKey))?.categories['analytics.replay']).toBe(false);
    expect(generation(await getConsent(tenantId, subjectKey))).toBeUndefined();
  });
});
