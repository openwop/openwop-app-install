/**
 * GEN-1b — the tenant-fold KEY-rewrite in `reassignTenant`.
 *
 * The anon→user adopt fold historically rewrote SQL `tenant_id` columns and the
 * JSON `tenantId`/`orgId` VALUES of host-ext KV rows, but never the tenant-
 * embedded row KEY nor the `hostextidx:` secondary-index markers. That stranded
 * ~224 collections on every fold: mechanism A (`hostext:<name>:${tenant}:${id}`
 * PK rows → unreachable even by id) and mechanism B (`tenantOf`-indexed
 * collections → `listForTenantIndexed` permanently empty for folded rows, since
 * the fleet-wide backfill sentinel blocks re-heal).
 *
 * This suite has two halves:
 *  1. PURE — `planHostExtRekey`/`rekeyTenantSegment`/`rekeyHostExtMarkerValue`,
 *     pinning the lookaround-regex correctness (the personal-workspace DOUBLE
 *     embed, `::` delimiters, leading/trailing segments, false-positive safety).
 *     A naive `replaceAll(':'+from+':', …)` FAILS the double-embed case.
 *  2. FULL-BOOT — a real sqlite-backed `openStorage('memory://')` + a
 *     `DurableCollection`, seeding the source tenant and asserting the fold moves
 *     both PK rows and index markers, dedups on collision, and leaves no
 *     `:${from}:` key behind.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import {
  planHostExtRekey,
  rekeyTenantSegment,
  rekeyHostExtMarkerValue,
} from '../src/storage/tenantMigration.js';
import type { Storage } from '../src/storage/storage.js';

const FROM = 'anon:sidABC';
const TO = 'user:0123456789abcdef0123456789abcdef';

describe('GEN-1b (pure) — rekeyTenantSegment', () => {
  it('rewrites a LEADING, MIDDLE, and TRAILING tenant segment', () => {
    expect(rekeyTenantSegment(`${FROM}:wf.x`, FROM, TO)).toBe(`${TO}:wf.x`);
    expect(rekeyTenantSegment(`hostext:workflow:ownership:${FROM}:wf.x`, FROM, TO)).toBe(
      `hostext:workflow:ownership:${TO}:wf.x`,
    );
    expect(rekeyTenantSegment(`hostext:audit:head:${FROM}`, FROM, TO)).toBe(`hostext:audit:head:${TO}`);
  });

  it('rewrites BOTH occurrences of a personal-workspace double-embed (org === tenant)', () => {
    // `${tenant}:${org===tenant}:${user}` — the case a replaceAll(':'+from+':')
    // silently half-rewrites (it consumes the shared middle colon).
    const key = `hostext:commerce:cart:${FROM}:${FROM}:u1`;
    expect(rekeyTenantSegment(key, FROM, TO)).toBe(`hostext:commerce:cart:${TO}:${TO}:u1`);
  });

  it('handles `::` double-delimited keys (the CDP/campaign key style)', () => {
    expect(rekeyTenantSegment(`hostext:cdp:event-schema:${FROM}::evt::1`, FROM, TO)).toBe(
      `hostext:cdp:event-schema:${TO}::evt::1`,
    );
  });

  it('does NOT rewrite a non-tenant segment that merely SHARES a prefix', () => {
    // `anon:sidABC2` is a different token → must not match `anon:sidABC`.
    expect(rekeyTenantSegment(`hostext:x:${FROM}2:y`, FROM, TO)).toBe(`hostext:x:${FROM}2:y`);
  });

  it('leaves a subject-ref segment (user:<uid>) that is not the tenant untouched', () => {
    // consent:record key `${tenant}:${subjectRef}` where subjectRef is a DIFFERENT user:<uid>.
    const key = `hostext:consent:record:${FROM}:user:some-firebase-uid`;
    expect(rekeyTenantSegment(key, FROM, TO)).toBe(`hostext:consent:record:${TO}:user:some-firebase-uid`);
  });

  it('returns the input unchanged when the tenant does not appear', () => {
    expect(rekeyTenantSegment('hostext:foo:bar:baz', FROM, TO)).toBe('hostext:foo:bar:baz');
  });
});

describe('GEN-1b (pure) — rekeyHostExtMarkerValue', () => {
  it('rewrites a bare-id marker value', () => {
    expect(rekeyHostExtMarkerValue(`${FROM}:wf.x`, FROM, TO)).toBe(`${TO}:wf.x`);
  });

  it('rewrites the id inside a {id,p} marker and DROPS the projection (self-heal)', () => {
    const marker = JSON.stringify({ id: `${FROM}:wf.x`, p: { title: 'stale' } });
    expect(rekeyHostExtMarkerValue(marker, FROM, TO)).toBe(`${TO}:wf.x`);
  });
});

describe('GEN-1b (pure) — planHostExtRekey', () => {
  it('MOVES a tenant-embedded primary PK row, rewriting content fields too', () => {
    const k = `hostext:workflow:ownership:${FROM}:wf.x`;
    const v = JSON.stringify({ tenantId: FROM, workflowId: 'wf.x' });
    const action = planHostExtRekey(k, v, FROM, TO);
    expect(action.kind).toBe('move');
    if (action.kind !== 'move') throw new Error('unreachable');
    expect(action.k).toBe(`hostext:workflow:ownership:${TO}:wf.x`);
    expect(JSON.parse(action.v)).toEqual({ tenantId: TO, workflowId: 'wf.x' });
  });

  it('UPDATES-in-place a primary row whose tenant lives only in CONTENT', () => {
    const k = 'hostext:cms:page:random-uuid';
    const v = JSON.stringify({ tenantId: FROM, orgId: FROM, slug: 'home' });
    const action = planHostExtRekey(k, v, FROM, TO);
    expect(action.kind).toBe('value');
    if (action.kind !== 'value') throw new Error('unreachable');
    expect(JSON.parse(action.v)).toEqual({ tenantId: TO, orgId: TO, slug: 'home' });
  });

  it('MOVES a hostextidx marker to the destination slice with a projection-dropped value', () => {
    const k = `hostextidx:media:asset:${FROM}:${FROM}:a1`;
    const v = JSON.stringify({ id: `${FROM}:a1`, p: { name: 'pic' } });
    const action = planHostExtRekey(k, v, FROM, TO);
    expect(action.kind).toBe('move');
    if (action.kind !== 'move') throw new Error('unreachable');
    expect(action.k).toBe(`hostextidx:media:asset:${TO}:${TO}:a1`);
    expect(action.v).toBe(`${TO}:a1`); // projection dropped
  });

  it('leaves a tenant-agnostic sentinel (hostextidxmeta) alone', () => {
    expect(planHostExtRekey('hostextidxmeta:media:asset:backfilled', '1', FROM, TO)).toEqual({ kind: 'none' });
  });

  it('leaves a marker for a DIFFERENT tenant alone', () => {
    const k = 'hostextidx:media:asset:user:other:x';
    expect(planHostExtRekey(k, 'user:other:x', FROM, TO)).toEqual({ kind: 'none' });
  });
});

// ─── Full-boot integration against the real sqlite-backed KV store ───

interface OwnRow { id: string; tenantId: string; wf: string }
// Mechanism A + B together: a tenant-PREFIXED PK (`${tenant}:${wf}`) WITH a
// tenantOf index — the workflow:ownership shape.
const ownership = () =>
  new DurableCollection<OwnRow>('gen1b:ownership', (r) => r.id, undefined, (r) => r.tenantId);

interface DocRow { id: string; tenantId: string; body: string }
// Mechanism B only: a random-id PK (tenant only in content) WITH a tenantOf index.
const docs = () =>
  new DurableCollection<DocRow>('gen1b:doc', (r) => r.id, undefined, (r) => r.tenantId);

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('GEN-1b (full-boot) — reassignTenant moves tenant-embedded keys + markers', () => {
  it('mechanism A: a PK-embedded row is reachable under the destination via BOTH reads, no source key left', async () => {
    const own = ownership();
    await own.put({ id: `${FROM}:wf.x`, tenantId: FROM, wf: 'wf.x' });

    const res = await storage.reassignTenant(FROM, TO);
    expect(res.hostExtKeysRekeyed).toBeGreaterThanOrEqual(1);

    // Reachable via the prefix scan (listByPrefix) …
    expect((await own.listByPrefix(`${TO}:`)).map((r) => r.id)).toEqual([`${TO}:wf.x`]);
    // … and via the tenant secondary index (the mechanism-B pin).
    expect((await own.listForTenantIndexed(TO)).map((r) => r.wf)).toEqual(['wf.x']);
    // Content re-keyed, and nothing left under the source tenant.
    expect((await own.get(`${TO}:wf.x`))?.tenantId).toBe(TO);
    expect(await own.listByPrefix(`${FROM}:`)).toEqual([]);
    expect(await own.listForTenantIndexed(FROM)).toEqual([]);
    // No raw `:${FROM}:`-bearing key survives in EITHER keyspace.
    const stray = (await storage.kvList('hostext')).filter((r) => r.key.includes(`:${FROM}:`) || r.key.endsWith(`:${FROM}`));
    expect(stray).toEqual([]);
  });

  it('mechanism B: a random-id indexed row shows under the destination index after the fold', async () => {
    const d = docs();
    await d.put({ id: 'doc-1', tenantId: FROM, body: 'hi' });

    await storage.reassignTenant(FROM, TO);

    // The primary key is unchanged (random id), but content + marker moved tenant.
    expect((await d.get('doc-1'))?.tenantId).toBe(TO);
    expect((await d.listForTenantIndexed(TO)).map((r) => r.id)).toEqual(['doc-1']);
    expect(await d.listForTenantIndexed(FROM)).toEqual([]);
    // Marker physically moved to the destination slice.
    expect(await storage.kvGet(`hostextidx:gen1b:doc:${TO}:doc-1`)).not.toBeNull();
    expect(await storage.kvGet(`hostextidx:gen1b:doc:${FROM}:doc-1`)).toBeNull();
  });

  it('collision on a deterministic id dedups in the destination`s favour and counts the drop', async () => {
    const own = ownership();
    // Same deterministic id owned by BOTH tenants (the wf.seed.x fold-collision).
    await own.put({ id: `${TO}:wf.seed.x`, tenantId: TO, wf: 'target-wins' });
    await own.put({ id: `${FROM}:wf.seed.x`, tenantId: FROM, wf: 'source-loses' });

    const res = await storage.reassignTenant(FROM, TO);
    // Two physical keys dropped on collision: the primary row AND its tenant-index marker.
    expect(res.hostExtKeysDeduped).toBe(2);

    // Exactly one row, and it is the destination's own (source dropped).
    const rows = await own.listByPrefix(`${TO}:wf.seed.x`);
    expect(rows).toHaveLength(1);
    expect(rows[0].wf).toBe('target-wins');
    expect(await own.listForTenantIndexed(FROM)).toEqual([]);
  });

  it('is idempotent — a second fold finds nothing under the source and moves zero keys', async () => {
    const own = ownership();
    await own.put({ id: `${FROM}:wf.x`, tenantId: FROM, wf: 'wf.x' });
    await storage.reassignTenant(FROM, TO);
    const again = await storage.reassignTenant(FROM, TO);
    expect(again.hostExtKeysRekeyed).toBe(0);
    expect(again.hostExtKeysDeduped).toBe(0);
    expect((await own.listForTenantIndexed(TO)).map((r) => r.wf)).toEqual(['wf.x']);
  });
});
