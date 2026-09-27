/**
 * KB-2 — tenant teardown reclaims the VECTOR MIRROR.
 *
 * The defect had two independent halves, and closing either alone leaves the data:
 *   (a) `deleteAllTenantData` introspects `information_schema` for `column_name =
 *       'tenant_id'`, while `host_vectors` names its column `tenant` — so the table
 *       was never enumerated, and on a separate `OPENWOP_VECTOR_PG_DSN` it was not
 *       even on the same database;
 *   (b) `VectorSurface` had no namespace- or tenant-clear at all (delete is by
 *       explicit id), so there was no mechanism to call even had teardown known.
 * KB chunk rows carry the chunk's FULL TEXT in `metadata`, so this was retained
 * customer content surviving account deletion.
 *
 * COVERAGE, STATED HONESTLY. The in-memory backend CAN model the invariant, so it is
 * driven end-to-end here with real KB ingest. The pgvector backend cannot be driven
 * in this environment (no Postgres+pgvector — the adapter's own header says so), so
 * it is covered exactly as the rest of that adapter is: the pure SQL builder is
 * pinned, and the purger is asserted to be registered ALONGSIDE the adapter, which
 * is the property that stops the two drifting apart. What is NOT proven here is that
 * a live pgvector executes the DELETE — that is the same residual the adapter has
 * carried since it shipped, and it is named rather than implied.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces, buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  purgeTenantVectors,
  registeredVectorPurgeBackends,
  registerVectorTenantPurger,
} from '../src/host/vector/vectorTenantPurge.js';
import { purgeTenantSql, deleteSql } from '../src/host/vector/pgVectorVector.js';
import { collectionNamespace, createCollection, ingestDocument, search } from '../src/features/kb/kbService.js';

const SECRET = 'Termination letter for employee 44120, effective immediately, code RRV-9033.';

describe('KB-2 — the vector mirror is reachable by tenant teardown', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbteardown-')) });
    initHostExtPersistence(await openStorage('memory://'));
  });

  it('the default (in-memory/durable) backend registers a purger at module load', () => {
    // Non-vacuity: if the registration is ever dropped, every assertion below would
    // pass trivially against an empty registry.
    expect(registeredVectorPurgeBackends()).toContain('memory');
  });

  it('purging a tenant removes its chunk vectors AND their metadata.text', async () => {
    const tenantId = `kbtd-${Date.now()}`;
    const orgId = 'org-a';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'HR' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Letter', text: SECRET });

    // Non-vacuity: the content must actually BE there and be retrievable first.
    const before = await search(tenantId, orgId, col.collectionId, 'termination code RRV-9033', 10, 'dense');
    expect(before.some((h) => h.text.includes('RRV-9033'))).toBe(true);

    const ns = collectionNamespace({ collectionId: col.collectionId, orgId } as never);
    const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
    const seeded = await vector.query({ namespace: ns, vector: new Array(256).fill(0.01), topK: 50 });
    expect((seeded.matches as unknown[]).length).toBeGreaterThan(0);

    const result = await purgeTenantVectors(tenantId);
    expect(result.failed, 'a partial teardown must never report as clean').toEqual([]);
    expect(result.purged).toBeGreaterThan(0);

    // Probe the STORE. A post-teardown search would rebuild the namespace from the
    // durable documents (which teardown deletes separately), so asking search would
    // conflate two mechanisms; ask the vector store what it still holds.
    const after = await vector.query({ namespace: ns, vector: new Array(256).fill(0.01), topK: 50 });
    const texts = (after.matches as Array<{ metadata?: { text?: string } }>).map((m) => m.metadata?.text ?? '');
    expect(after.matches as unknown[]).toEqual([]);
    expect(texts.join(' ')).not.toContain('RRV-9033');
  });

  it('another tenant\'s vectors are untouched (the purge is scoped, not a wildcard)', async () => {
    const keep = `kbtd-keep-${Date.now()}`;
    const drop = `kbtd-drop-${Date.now()}`;
    const orgId = 'org-a';
    const kept = await createCollection(keep, orgId, 'actor', { name: 'Keep' });
    await ingestDocument(keep, orgId, 'actor', kept.collectionId, { title: 'Keep', text: SECRET });
    const doomed = await createCollection(drop, orgId, 'actor', { name: 'Drop' });
    await ingestDocument(drop, orgId, 'actor', doomed.collectionId, { title: 'Drop', text: SECRET });

    await purgeTenantVectors(drop);

    const keptNs = collectionNamespace({ collectionId: kept.collectionId, orgId } as never);
    const still = await buildHostSurfaceBundle({ tenantId: keep }).db.vector.query({ namespace: keptNs, vector: new Array(256).fill(0.01), topK: 50 });
    expect((still.matches as unknown[]).length).toBeGreaterThan(0);
  });

  it('a falsy tenant is fail-closed (never a wildcard delete)', async () => {
    const res = await purgeTenantVectors('');
    expect(res).toEqual({ purged: 0, backends: [], failed: [] });
  });

  it('a failing backend is REPORTED, not folded into the success count', async () => {
    registerVectorTenantPurger('probe-broken', async () => { throw new Error('backend down'); });
    try {
      const res = await purgeTenantVectors(`kbtd-fail-${Date.now()}`);
      expect(res.failed).toContain('probe-broken');
      expect(res.backends).not.toContain('probe-broken');
    } finally {
      // Restore a no-op so the shared registry is left as this suite found it.
      registerVectorTenantPurger('probe-broken', async () => 0);
    }
  });

  it('the pgvector tenant DELETE is by the column that table actually has', () => {
    // The whole defect in one line: teardown looked for `tenant_id`, the table has
    // `tenant`. Pin the predicate so a rename cannot silently re-open it.
    const sql = purgeTenantSql('host_vectors');
    expect(sql).toBe('DELETE FROM host_vectors WHERE tenant = $1');
    expect(sql).not.toContain('tenant_id');
    // …and it is genuinely BROADER than the per-id delete that was the only tool
    // before — no namespace, no id list.
    expect(deleteSql('host_vectors')).toContain('namespace');
    expect(sql).not.toContain('namespace');
    // Table identifiers stay validated (no injection through OPENWOP_VECTOR_PG_TABLE).
    expect(() => purgeTenantSql('host_vectors; DROP TABLE runs')).toThrow(/unsafe table identifier/);
  });

  it('the pgvector adapter registers its purger BESIDE itself (so the two cannot drift)', async () => {
    // Source-level, because this environment has no pgvector to boot. The assertion
    // is about co-location: any future adapter registration that forgets the purger
    // reads as the coverage gap it is.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(__dirname, '..', 'src', 'host', 'vector', 'pgVectorVector.ts'), 'utf8');
    expect(/registerSurfaceAdapter\('vector', 'pgvector'/.test(src)).toBe(true);
    expect(/registerVectorTenantPurger\('pgvector'/.test(src)).toBe(true);
  });
});
