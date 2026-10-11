/**
 * PRJC-2 + PRJC-3 — the list route's scan cost, MEASURED (deterministic
 * storage-call counts, not wall time).
 *
 * Before: the list loop re-fetched each row inside `resolveProjectAccess` AND
 * re-ran `resolveEffectiveAccess` (which full-scans members/customRoles/groups)
 * per project, plus the route's second `getProject` per row — worst case
 * ~PROJECT_CAP(200) × 3 host-collection scans per request (the `host_ext_kv`
 * incident's class). After: ONE bounded tenant-indexed list + ONE access
 * resolution per (caller, org).
 *
 * The OLD shape is simulated with the still-exported per-id door
 * (`resolveProjectAccess` + `getProject`), which is byte-for-byte what the old
 * route loop did — so the A/B runs on one tree with one storage.
 *
 * Sabotage-witnessed (grade-tests w13): dropping the per-org memo
 * (`accessByOrg.set`) reds both cases; one global memo (ignoring the org) reds
 * case 2's `read` level; a per-row re-`getProject` reds case 1's kvGet bound.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { createMember } from '../src/host/accessControlService.js';
import {
  listProjects, listVisibleProjects, resolveProjectAccess, getProject, type Project,
} from '../src/features/projects/projectsService.js';

const T = 'org:scan-cost';
const ORG = 'org:scan-cost'; // workspace-root style: orgId === tenantId
const CALLER = 'user:caller-hash';
const N = 50;

let storage: Storage;
const counts = { kvGet: 0, kvList: 0 };

beforeEach(async () => {
  storage = await openStorage('memory://');
  const counted: Storage = new Proxy(storage, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === 'kvGet') return (...a: unknown[]) => { counts.kvGet += 1; return (v as (...x: unknown[]) => unknown).apply(target, a); };
      if (prop === 'kvList') return (...a: unknown[]) => { counts.kvList += 1; return (v as (...x: unknown[]) => unknown).apply(target, a); };
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  });
  initHostExtPersistence(counted);

  await createMember({ tenantId: T, orgId: ORG, subject: CALLER, displayName: 'C', roles: ['editor'] });
  const col = new DurableCollection<Project>('projects:project', (p) => p.id, undefined, (p) => p.tenantId);
  for (let i = 0; i < N; i++) {
    await col.put({
      id: `project-${String(i).padStart(3, '0')}`, tenantId: T, orgId: ORG, name: `P${i}`,
      workflows: [], members: [], visibility: 'org', createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, updatedAt: 'u',
    });
  }
  // Warm the tenant index (the one-time sentinel-guarded backfill) so the
  // measurement below is the steady-state request cost, not the migration.
  await listProjects(T);
  counts.kvGet = 0; counts.kvList = 0;
});
afterEach(() => { __resetHostExtPersistence(); });

const snap = (): { kvGet: number; kvList: number } => ({ ...counts });
const reset = (): void => { counts.kvGet = 0; counts.kvList = 0; };

describe('PRJC-2/PRJC-3 — measured storage-call costs of the list scan', () => {
  it('the shared listVisibleProjects does O(1) collection scans; the old loop did O(N)', async () => {
    // OLD route shape: list, then per project resolveProjectAccess (getProject +
    // resolveEffectiveAccess: members+customRoles+groups scans) + view's re-getProject.
    reset();
    const oldVisible: string[] = [];
    for (const p of await listProjects(T)) {
      const level = await resolveProjectAccess(T, p.id, CALLER);
      if (level === 'none') continue;
      const again = await getProject(T, p.id); // view()'s re-fetch
      if (again) oldVisible.push(again.id);
    }
    const oldCost = snap();

    // NEW shape.
    reset();
    const visible = await listVisibleProjects(T, CALLER);
    const newCost = snap();

    // Same answer…
    expect(visible.map((v) => v.project.id).sort()).toEqual(oldVisible.sort());
    expect(visible).toHaveLength(N);
    expect(visible.every((v) => v.level === 'write')).toBe(true);

    // …at a structurally different cost. The old loop scans the three access
    // collections once PER PROJECT (3N + the row list); the new one scans them
    // ONCE for the single org. MEASURED (CODEBASE-ASSESSMENT PRJC-3, N=50):
    // OLD kvList=151, kvGet=151 · NEW kvList=4, kvGet=51.
    const measured = `OLD ${JSON.stringify(oldCost)} · NEW ${JSON.stringify(newCost)}`;
    expect(oldCost.kvList, `old loop must show the O(N) collection-scan shape — ${measured}`).toBeGreaterThanOrEqual(3 * N);
    expect(newCost.kvList, `new scan must be O(1) in collection scans (index slice + 3 access scans + slack) — ${measured}`).toBeLessThanOrEqual(8);
    // The per-project double row re-read is gone too: the index reads each row
    // ONCE (N) plus the slice. A bound relative to the old loop (`< oldCost`)
    // stayed green with one re-read per row back (~2N < 3N) — w13 probe
    // `ls-reread` — so the bound is absolute.
    expect(newCost.kvGet, `one row read per project, no per-row re-get — ${measured}`).toBeLessThanOrEqual(N + 3);
  });

  it('the memoization is per (caller, org) — a second org costs ONE more resolution, not N more', async () => {
    const col = new DurableCollection<Project>('projects:project', (p) => p.id, undefined, (p) => p.tenantId);
    await createMember({ tenantId: T, orgId: 'org-b', subject: CALLER, displayName: 'C', roles: ['viewer'] });
    await col.put({ id: 'project-org-b', tenantId: T, orgId: 'org-b', name: 'B', workflows: [], members: [], visibility: 'org', createdAt: '2026-02-01T00:00:00Z', updatedAt: 'u' });

    reset();
    const visible = await listVisibleProjects(T, CALLER);
    const cost = snap();
    expect(visible).toHaveLength(N + 1);
    expect(visible.find((v) => v.project.id === 'project-org-b')?.level).toBe('read'); // viewer in org-b, editor in ORG
    // Two orgs ⇒ two access resolutions (each 3 scans) + the index slice — still O(#orgs), not O(N).
    expect(cost.kvList).toBeLessThanOrEqual(11);
  });
});
