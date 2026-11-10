/**
 * The tenant-fold shapes for the bounded-read equality tests (fold-bounded-read*.test.ts):
 * a seed covering every rewrite path, the old whole-table pass computed purely, and the
 * store after a real `reassignTenant`.
 */
import { planHostExtRekey } from '../../src/storage/tenantMigration.js';
import type { Storage } from '../../src/storage/storage.js';

export const FOLD_TO = 'user:0123456789abcdef0123456789abcdef';
const SCAFFOLDING = ['hostext:access-orgs:', 'hostext:access-members:', 'hostextidx:access-orgs:', 'hostextidx:access-members:'];

/** Every key carries `ns`, so cases sharing one database read back only their own rows. */
export function foldSeed(from: string, ns: string): Record<string, string> {
  return {
    [`hostext:wf:own:${from}:id-${ns}`]: JSON.stringify({ name: 'key only' }),
    [`hostext:crm:contact:c1-${ns}`]: JSON.stringify({ tenantId: from, name: 'value only' }),
    [`hostext:crm:deal:d1-${ns}`]: JSON.stringify({ meta: { owner: { tenantId: from } } }),
    [`hostextidx:wf:${from}:id-${ns}`]: `${from}:id-${ns}`,
    [`hostext:crm:contact:c2-${ns}`]: JSON.stringify({ tenantId: `${from}2`, name: 'shares a prefix' }),
    [`hostext:crm:contact:c3-${ns}`]: JSON.stringify({ tenantId: 'user:someone-else' }),
    [`hostext:access-orgs:${from}:${ns}`]: JSON.stringify({ orgId: from }),
  };
}

/** What the old whole-table pass leaves behind. */
export function foldOldPass(rows: Record<string, string>, from: string): Record<string, string> {
  const out = { ...rows };
  for (const [k, v] of Object.entries(rows)) {
    if (SCAFFOLDING.some((p) => k.startsWith(p))) continue;
    const a = planHostExtRekey(k, v, from, FOLD_TO);
    if (a.kind === 'value') out[k] = a.v;
    if (a.kind === 'move') { delete out[k]; if (!(a.k in out)) out[a.k] = a.v; }
  }
  return out;
}

/** Reads every host-ext row back. Defaults to `kvList`; pg-mem passes a raw read,
 *  because it cannot parse the `LIKE … ESCAPE` that `kvList` sends. */
export type ReadAllKv = (storage: Storage) => Promise<ReadonlyArray<{ key: string; value: string }>>;
const readViaKvList: ReadAllKv = async (storage) => [...await storage.kvList('hostext:'), ...await storage.kvList('hostextidx:')];

export async function foldAfter(storage: Storage, rows: Record<string, string>, from: string, ns: string, readAll: ReadAllKv = readViaKvList): Promise<Record<string, string>> {
  for (const [k, v] of Object.entries(rows)) await storage.kvSet(k, v);
  await storage.reassignTenant(from, FOLD_TO);
  const all = await readAll(storage);
  return Object.fromEntries(all.filter((r) => r.key.includes(ns)).map((r) => [r.key, r.value]));
}

