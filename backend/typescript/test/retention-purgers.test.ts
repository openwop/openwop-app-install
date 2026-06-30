/**
 * ADR 0081 Phase 5 — retention-purger rollout (crm, profiles, comments).
 *
 * Each PII-bearing feature registers a RetentionPurger (ADR 0077 seam) that ages on
 * `updatedAt` (abandoned records, not merely old ones) and deletes only this tenant's
 * rows past the cutoff. Verifies per-feature: an aged row is purged, a fresh row is
 * retained, the classification + tenant guards (no internal purge, no cross-tenant,
 * fail-closed blank tenant). kb is deliberately NOT in scope (it holds tenant knowledge
 * content + a vector mirror, not data-subject PII — architect P5 correction).
 *
 * Importing each service module triggers its module-load purger registration; the test
 * seeds backdated rows through a DurableCollection over the SAME backend the purger reads,
 * then drives the host seam directly via `purgeRetained`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { purgeRetained, purgeRowsByAge, registerRetentionPurger } from '../src/host/retentionPurger.js';
import type { Storage } from '../src/storage/storage.js';

// Importing the services registers their purgers (module-load side-effect). The reset
// helpers also re-import them, but the import below guarantees registration regardless of
// ordering.
import { __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetProfiles } from '../src/features/profiles/profilesService.js';
import { __resetCommentsStore } from '../src/features/comments/commentsService.js';

const DAY = 86_400_000;
const now = 1_900_000_000_000;
const cutoffIso = new Date(now - 365 * DAY).toISOString();
const OLD = new Date(now - 400 * DAY).toISOString();
const FRESH = new Date(now - 10 * DAY).toISOString();

// Partial row shapes — the purgers read only { tenantId, updatedAt } + the key field, so a
// minimal row over the real collection name exercises the real delete path (no `as` cast).
const crmCol = () => new DurableCollection<{ contactId: string; tenantId: string; updatedAt: string }>('crm:contact', (c) => c.contactId);
const profileCol = () => new DurableCollection<{ userId: string; tenantId: string; updatedAt: string }>('profiles:profile', (p) => p.userId);
const commentCol = () => new DurableCollection<{ commentId: string; tenantId: string; updatedAt: string }>('comments:thread', (c) => c.commentId);

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetCrmStore();
  await __resetProfiles();
  await __resetCommentsStore();
  // Do NOT __resetRetentionPurgers here — the purgers register once at module load and
  // must stay registered for purgeRetained to reach them.
});

describe('ADR 0081 §5 — per-feature retention purgers', () => {
  it('crm: purges a contact not touched within the window, keeps a fresh one', async () => {
    const col = crmCol();
    await col.put({ contactId: 'crm:old', tenantId: 'tA', updatedAt: OLD });
    await col.put({ contactId: 'crm:fresh', tenantId: 'tA', updatedAt: FRESH });
    const results = await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(results.find((r) => r.feature === 'crm')).toMatchObject({ deleted: 1, ok: true });
    expect(await col.get('crm:old')).toBeNull();
    expect(await col.get('crm:fresh')).not.toBeNull();
  });

  it('profiles: purges a dormant profile, keeps a recently-updated one', async () => {
    const col = profileCol();
    await col.put({ userId: 'u-old', tenantId: 'tA', updatedAt: OLD });
    await col.put({ userId: 'u-fresh', tenantId: 'tA', updatedAt: FRESH });
    const results = await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(results.find((r) => r.feature === 'profiles')).toMatchObject({ deleted: 1, ok: true });
    expect(await col.get('u-old')).toBeNull();
    expect(await col.get('u-fresh')).not.toBeNull();
  });

  it('comments: purges a year-dormant thread, keeps a fresh one', async () => {
    const col = commentCol();
    await col.put({ commentId: 'c-old', tenantId: 'tA', updatedAt: OLD });
    await col.put({ commentId: 'c-fresh', tenantId: 'tA', updatedAt: FRESH });
    const results = await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(results.find((r) => r.feature === 'comments')).toMatchObject({ deleted: 1, ok: true });
    expect(await col.get('c-old')).toBeNull();
    expect(await col.get('c-fresh')).not.toBeNull();
  });

  it('never crosses tenants — an aged row in another tenant is untouched', async () => {
    const col = crmCol();
    await col.put({ contactId: 'crm:other', tenantId: 'tB', updatedAt: OLD });
    await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(await col.get('crm:other')).not.toBeNull(); // tA's sweep can't touch tB
  });

  it('classification guard: an `internal` sweep purges none of these PII features', async () => {
    await crmCol().put({ contactId: 'crm:old', tenantId: 'tA', updatedAt: OLD });
    await profileCol().put({ userId: 'u-old', tenantId: 'tA', updatedAt: OLD });
    const results = await purgeRetained('tA', 'internal', cutoffIso);
    for (const feature of ['crm', 'profiles', 'comments']) {
      expect(results.find((r) => r.feature === feature)?.deleted).toBe(0);
    }
    expect(await crmCol().get('crm:old')).not.toBeNull();
  });

  it('fail-closed: a blank tenant purges nothing', async () => {
    await crmCol().put({ contactId: 'crm:old', tenantId: 'tA', updatedAt: OLD });
    expect(await purgeRetained('', 'confidential-pii', cutoffIso)).toEqual([]);
    expect(await crmCol().get('crm:old')).not.toBeNull();
  });

  it('idempotent: a re-sweep deletes nothing new', async () => {
    const col = crmCol();
    await col.put({ contactId: 'crm:old', tenantId: 'tA', updatedAt: OLD });
    await purgeRetained('tA', 'confidential-pii', cutoffIso);
    const second = await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(second.find((r) => r.feature === 'crm')?.deleted).toBe(0);
  });

  it('boundary: a row whose updatedAt equals the cutoff is RETAINED (strict `<`)', async () => {
    const col = crmCol();
    await col.put({ contactId: 'crm:edge', tenantId: 'tA', updatedAt: cutoffIso });
    await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(await col.get('crm:edge')).not.toBeNull(); // not strictly older than cutoff
  });

  it('best-effort: one feature still purges if a sibling purger throws', async () => {
    registerRetentionPurger({ feature: 'boom-p5', async purge() { throw new Error('nope'); } });
    const col = crmCol();
    await col.put({ contactId: 'crm:old', tenantId: 'tA', updatedAt: OLD });
    const results = await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(results.find((r) => r.feature === 'boom-p5')).toMatchObject({ deleted: 0, ok: false, error: 'nope' });
    expect(results.find((r) => r.feature === 'crm')).toMatchObject({ deleted: 1, ok: true });
    expect(await col.get('crm:old')).toBeNull();
  });
});

// GOV-1 — the shared, partial-failure-resilient purge primitive every feature purger uses.
describe('GOV-1 — purgeRowsByAge resilience', () => {
  const rows = [
    { id: 'a', tenantId: 'tA', updatedAt: OLD },
    { id: 'boom', tenantId: 'tA', updatedAt: OLD },
    { id: 'c', tenantId: 'tA', updatedAt: OLD },
    { id: 'fresh', tenantId: 'tA', updatedAt: FRESH },
    { id: 'other', tenantId: 'tB', updatedAt: OLD },
  ];
  const rowOf = (r: { id: string; tenantId: string; updatedAt: string }) => r;

  it('a per-row delete failure does NOT abort the sweep — the rest still delete, count is honest', async () => {
    const deleted: string[] = [];
    const out = await purgeRowsByAge('t', rows, 'tA', cutoffIso, rowOf, async (id) => {
      if (id === 'boom') throw new Error('storage hiccup'); // one row fails mid-loop
      deleted.push(id);
    });
    // Without resilience the throw on `boom` would abort before `c` — assert it kept going.
    expect(deleted).toEqual(['a', 'c']); // both aged tA rows except the failing one
    expect(out).toEqual({ deleted: 2, failed: 1 });
  });

  it('only this tenant, only strictly-older rows (cross-tenant + fresh + cutoff-equal retained)', async () => {
    const deleted: string[] = [];
    const out = await purgeRowsByAge('t',
      [...rows, { id: 'edge', tenantId: 'tA', updatedAt: cutoffIso }],
      'tA', cutoffIso, rowOf, async (id) => { deleted.push(id); });
    expect(deleted.sort()).toEqual(['a', 'boom', 'c']); // not 'fresh', not 'other'(tB), not 'edge'(==cutoff)
    expect(out).toEqual({ deleted: 3, failed: 0 });
  });

  it('fail-closed on a blank tenant — deletes nothing', async () => {
    const deleted: string[] = [];
    const out = await purgeRowsByAge('t', rows, '', cutoffIso, rowOf, async (id) => { deleted.push(id); });
    expect(deleted).toEqual([]);
    expect(out).toEqual({ deleted: 0, failed: 0 });
  });

  it('the daemon sees failed rows: purgeRetained surfaces failed>0 with ok:true', async () => {
    registerRetentionPurger({
      feature: 'partial-gov1',
      async purge(tenantId, _classification, cutoff) {
        return purgeRowsByAge('partial-gov1', rows, tenantId, cutoff, rowOf, async (id) => {
          if (id === 'boom') throw new Error('hiccup');
        });
      },
    });
    const results = await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(results.find((r) => r.feature === 'partial-gov1')).toMatchObject({ deleted: 2, failed: 1, ok: true });
  });
});
