/**
 * IDN-3 — expired `orgs:invite` rows age out via the ADR 0380 kvAgeOut lane.
 *
 * An expired invite is dead (acceptInvitation rejects `expiresAt < now`; an accepted invite
 * is deleted at accept time), so the store only accrues expired-never-accepted rows. The
 * registration ages on `expiresAt` with a 30-day grace. Importing the service triggers its
 * module-load registration; the test seeds rows over the real collection and drives the sweep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { __runKvAgeOutOnce, __listKvAgeOutForTest, registerKvAgeOut } from '../src/host/kvAgeOut.js';
import type { Storage } from '../src/storage/storage.js';

// Import for the module-load side-effect: registers the `orgs:invite` kvAgeOut.
import '../src/features/orgs/invitationsService.js';

const DAY = 86_400_000;
const NOW = new Date('2026-07-16T12:00:00.000Z');
const at = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * DAY).toISOString();

// Partial row over the REAL collection — kvAgeOut reads only `expiresAt` from the JSON.
const inviteCol = () => new DurableCollection<{ inviteId: string; expiresAt: string }>('orgs:invite', (i) => i.inviteId);

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('IDN-3 — orgs:invite kvAgeOut', () => {
  it('registers the orgs:invite store on the size-hygiene lane', () => {
    const reg = __listKvAgeOutForTest().find((r) => r.id === 'orgs:invite');
    expect(reg).toMatchObject({ prefix: 'hostext:orgs:invite:', ttlDays: 30, timestampField: 'expiresAt' });
  });

  it('registers the hash index in lockstep, and (WF-ORGINV-1) its rows write NO tenant-index markers', async () => {
    const reg = __listKvAgeOutForTest().find((r) => r.id === 'orgs:invite-hashidx');
    expect(reg).toMatchObject({ prefix: 'hostext:orgs:invite-hashidx:', ttlDays: 30, timestampField: 'expiresAt' });

    // The collection is INDEX-FREE now — a put mints no `hostextidx:` marker,
    // so a daemon age-out has nothing to strand.
    const idx = new DurableCollection<{ key: string; inviteId: string; tenantId: string; expiresAt: string }>('orgs:invite-hashidx', (r) => r.key);
    await idx.put({ key: 'h1', inviteId: 'inv:1', tenantId: 't', expiresAt: at(-40) });
    expect((await storage.kvList('hostextidx:orgs:invite-hashidx:')).length).toBe(0);

    await __runKvAgeOutOnce(storage, NOW);
    expect(await idx.get('h1')).toBeNull(); // aged out with its invite's TTL
    expect((await storage.kvList('hostextidx:orgs:invite-hashidx:')).length).toBe(0); // and still no markers
  });

  it('purges an invite expired beyond the grace, keeps a live one and one recently expired', async () => {
    const col = inviteCol();
    await col.put({ inviteId: 'inv-long-dead', expiresAt: at(-40) }); // expired 40d ago → past the 30d grace
    await col.put({ inviteId: 'inv-recently-expired', expiresAt: at(-10) }); // expired 10d ago → within grace
    await col.put({ inviteId: 'inv-live', expiresAt: at(3) }); // not yet expired

    await __runKvAgeOutOnce(storage, NOW);

    expect(await col.get('inv-long-dead')).toBeNull();          // aged out
    expect(await col.get('inv-recently-expired')).not.toBeNull(); // grace buffer preserved
    expect(await col.get('inv-live')).not.toBeNull();            // a pending invite is never touched
  });
});

describe('WF-ORGINV-1 — the kvAgeOut index-free tripwire + marker-aware sweep', () => {
  it('registering a tenant-indexed collection trips the registration-time warn; an index-free one does not', () => {
    // The defect shape: a collection WITH a tenantOf secondary index, put on
    // the raw-kv age-out lane.
    new DurableCollection<{ id: string; tenantId: string; at: string }>('test:wforginv1-indexed', (r) => r.id, undefined, (r) => r.tenantId);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    try {
      registerKvAgeOut({ id: 'test:wforginv1-indexed', prefix: 'hostext:test:wforginv1-indexed:', ttlDays: 1, timestampField: 'at' });
      new DurableCollection<{ id: string; at: string }>('test:wforginv1-plain', (r) => r.id);
      registerKvAgeOut({ id: 'test:wforginv1-plain', prefix: 'hostext:test:wforginv1-plain:', ttlDays: 1, timestampField: 'at' });
      // Review F3 — an ACKNOWLEDGED indexed registration is silent (no
      // boot-time alarm fatigue for a known, accepted state).
      new DurableCollection<{ id: string; tenantId: string; at: string }>('test:wforginv1-acked', (r) => r.id, undefined, (r) => r.tenantId);
      registerKvAgeOut({ id: 'test:wforginv1-acked', prefix: 'hostext:test:wforginv1-acked:', ttlDays: 1, timestampField: 'at', acceptIndexed: true });
    } finally {
      spy.mockRestore();
    }
    const logged = writes.join('');
    expect(logged).toContain('kv_age_out_indexed_collection');
    expect(logged).toContain('test:wforginv1-indexed');
    expect(logged).not.toContain('test:wforginv1-plain'); // index-free registrations stay silent
    expect(logged).not.toContain('test:wforginv1-acked'); // acknowledged-indexed too (F3)
  });

  it('the sweep deletes an indexed collection VIA the collection — no stranded hostextidx: markers', async () => {
    const col = new DurableCollection<{ id: string; tenantId: string; at: string }>('test:wforginv1-sweep', (r) => r.id, undefined, (r) => r.tenantId);
    registerKvAgeOut({ id: 'test:wforginv1-sweep', prefix: 'hostext:test:wforginv1-sweep:', ttlDays: 1, timestampField: 'at' });
    await col.put({ id: 'old', tenantId: 't', at: at(-3) });
    await col.put({ id: 'fresh', tenantId: 't', at: at(0) });
    // Precondition: the tenant index minted one marker per row.
    expect((await storage.kvList('hostextidx:test:wforginv1-sweep:')).length).toBe(2);

    await __runKvAgeOutOnce(storage, NOW);

    expect(await col.get('old')).toBeNull();
    expect(await col.get('fresh')).not.toBeNull();
    // The load-bearing assertion: the aged-out row's marker went WITH it (the
    // old raw-kv delete stranded it until the ghost-marker sweeper).
    const markers = (await storage.kvList('hostextidx:test:wforginv1-sweep:')).map((r) => r.key);
    expect(markers).toEqual(['hostextidx:test:wforginv1-sweep:t:fresh']);
  });
});

describe('F2 (review) — app migration 17 drops the indexed-era hashidx markers', () => {
  it('deletes legacy hostextidx markers + the backfill sentinel; rows and neighbor namespaces untouched; idempotent', async () => {
    const { APP_MIGRATIONS } = await import('../src/host/appMigrations.js');
    const mig = APP_MIGRATIONS.find((m) => m.name === 'drop-orphaned-invite-hashidx-markers');
    expect(mig, 'migration 17 must exist').toBeTruthy();

    // Legacy-shaped markers the tenantOf era minted, the one-time backfill
    // sentinel, and a NEIGHBOR namespace marker that must survive.
    await storage.kvSet('hostextidx:orgs:invite-hashidx:t1:hashA', 'hashA');
    await storage.kvSet('hostextidx:orgs:invite-hashidx:t2:hashB', 'hashB');
    await storage.kvSet('hostextidxmeta:orgs:invite-hashidx:backfilled', '1');
    await storage.kvSet('hostextidx:orgs:other:t1:x', 'x');
    // A live hashidx ROW (content keyspace) must be untouched.
    const idx = new DurableCollection<{ key: string; inviteId: string }>('orgs:invite-hashidx', (r) => r.key);
    await idx.put({ key: 'hashC', inviteId: 'inv:c' });

    await mig!.run(storage);

    expect((await storage.kvList('hostextidx:orgs:invite-hashidx:')).length).toBe(0);
    expect(await storage.kvGet('hostextidxmeta:orgs:invite-hashidx:backfilled')).toBeNull();
    expect(await storage.kvGet('hostextidx:orgs:other:t1:x')).not.toBeNull();
    expect(await idx.get('hashC')).not.toBeNull();

    // Idempotent (the runner's contract): a re-run is a no-op.
    await mig!.run(storage);
    expect((await storage.kvList('hostextidx:orgs:invite-hashidx:')).length).toBe(0);
  });
});
