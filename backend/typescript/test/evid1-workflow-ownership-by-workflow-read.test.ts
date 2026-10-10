/**
 * EVID-1 — the by-workflow ownership questions never read the whole table.
 *
 * Production (2026-10-02 evidence cut): `GET /v1/workflows/conformance-…` took
 * 15–33 s and one answered 500 "canceling statement due to statement timeout",
 * stack `kvList ← DurableCollection.list ← isAuthoredByOtherTenant`. The key is
 * `${tenantId}:${workflowId}` and the only index is by tenant, so "does another
 * tenant own this id?" was a full `workflow:ownership` scan on every by-id read
 * of a workflow the caller does not own. Quiet production: 1.2 s per read.
 *
 * The witness makes a full scan of that namespace behave as it did (it throws
 * the statement-timeout error) and asserts the three request-path questions
 * still answer — and answer EXACTLY what the scan answered, on the ids built to
 * fool a text pre-filter.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  getOwned, isAuthoredByAnyTenant, isAuthoredByOtherTenant, listOwned, recordOwnership, removeOwnershipByWorkflowId,
} from '../src/host/workflowOwnership.js';

const PREFIX = 'hostext:workflow:ownership:';
let armed = false;
const fullScans: string[] = [];
const narrowed: Array<{ needle: string; candidates: number }> = [];

beforeAll(async () => {
  const real = await openStorage('memory://');
  const trapped = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'kvList') {
        return async (prefix: string) => {
          if (armed && prefix === PREFIX) {
            fullScans.push(prefix);
            throw new Error('canceling statement due to statement timeout');
          }
          return target.kvList(prefix);
        };
      }
      if (prop === 'kvListContaining') {
        return async (prefix: string, needle: string) => {
          const rows = await target.kvListContaining!(prefix, needle);
          if (prefix === PREFIX) narrowed.push({ needle, candidates: rows.length });
          return rows;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Storage;
  initHostExtPersistence(trapped);

  // A table with many unrelated rows, plus the ids built to fool a text filter.
  for (let i = 0; i < 40; i += 1) await recordOwnership(`ws:bulk-${i}`, `bulk-workflow-${i}`, { name: `Bulk ${i}`, nodeCount: 1 });
  await recordOwnership('user:alice', 'report', { name: 'Report', nodeCount: 1 });
  await recordOwnership('user:bob', 'report-weekly', { name: 'Report weekly', nodeCount: 1 });        // a LONGER id containing `report`
  await recordOwnership('ws:report', 'unrelated', { name: 'Tenant named like an id', nodeCount: 1 }); // a TENANT id containing `report`
  await recordOwnership('user:carol', 'shared-twice', { name: 'A', nodeCount: 1 });
  await recordOwnership('user:dave', 'shared-twice', { name: 'B', nodeCount: 1 });
  await recordOwnership('user:erin', 'naïve-flow', { name: 'Non-ASCII id', nodeCount: 1 });
});

describe('EVID-1 — by-workflow ownership reads are narrowed in the database', () => {
  it('PREMISE: the trap fires — a full scan of the namespace throws while armed', async () => {
    armed = true;
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const probe = new DurableCollection<{ key: string }>('workflow:ownership', (r) => r.key);
    await expect(probe.list()).rejects.toThrow(/statement timeout/);
    armed = false; fullScans.length = 0;
  });

  it('isAuthoredByOtherTenant answers without a full scan, and reads only candidate rows', async () => {
    armed = true; narrowed.length = 0;
    expect(await isAuthoredByOtherTenant('user:zed', 'report')).toBe(true);       // alice owns it
    expect(await isAuthoredByOtherTenant('user:alice', 'report')).toBe(false);    // only its owner
    expect(await isAuthoredByOtherTenant('user:zed', 'nobody-owns-this')).toBe(false);
    expect(await isAuthoredByOtherTenant('user:carol', 'shared-twice')).toBe(true); // dave also owns it
    armed = false;
    expect(fullScans).toEqual([]);
    expect(narrowed.length).toBe(4);
    // 46 rows in the table; a question about one id never pulls more than a handful.
    expect(Math.max(...narrowed.map((n) => n.candidates))).toBeLessThanOrEqual(3);
  });

  it('a row that merely CONTAINS the id is a candidate, never an owner', async () => {
    // `report-weekly` (bob) and tenant `ws:report` both contain the text `report`.
    // Only alice owns the workflow `report`.
    expect(await isAuthoredByOtherTenant('user:alice', 'report')).toBe(false);
    expect(await isAuthoredByAnyTenant('report-week')).toBe(false); // a PREFIX of a real id is not an id
    expect(await isAuthoredByAnyTenant('report-weekly')).toBe(true);
    expect(await isAuthoredByOtherTenant('user:bob', 'report-weekly')).toBe(false);
  });

  it('isAuthoredByAnyTenant and removeOwnershipByWorkflowId take the same narrowed read', async () => {
    armed = true;
    expect(await isAuthoredByAnyTenant('shared-twice')).toBe(true);
    expect(await isAuthoredByAnyTenant('nobody-owns-this')).toBe(false);
    expect(await removeOwnershipByWorkflowId('shared-twice')).toBe(2);
    armed = false;
    expect(fullScans).toEqual([]);
    expect(await getOwned('user:carol', 'shared-twice')).toBeNull();
    expect(await getOwned('user:dave', 'shared-twice')).toBeNull();
    // Nothing else was removed.
    expect((await listOwned('user:alice')).map((r) => r.workflowId)).toEqual(['report']);
    expect(await getOwned('user:bob', 'report-weekly')).not.toBeNull();
  });

  it('an id the text filter cannot narrow losslessly falls back to the full scan and is still CORRECT', async () => {
    // Fail-closed: a non-ASCII id must never be answered "nobody owns it" by a
    // filter that could not see it. Unarmed, so the fallback scan is allowed.
    fullScans.length = 0;
    expect(await isAuthoredByOtherTenant('user:zed', 'naïve-flow')).toBe(true);
    expect(await isAuthoredByOtherTenant('user:erin', 'naïve-flow')).toBe(false);
  });

  it('an empty id owns nothing', async () => {
    expect(await isAuthoredByAnyTenant('')).toBe(false);
  });
});
