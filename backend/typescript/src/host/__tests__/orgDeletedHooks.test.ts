/**
 * ADR 1161 — org-deleted hooks: a feature's per-org rows that carry no `orgId`
 * (so the refuse-while-populated guard cannot see them) go with the org.
 *
 *  1. hooks run AFTER the org is gone (a hook sees `getOrg` → null);
 *  2. a throwing hook does not stop the next hook or the delete; the failure is
 *     audited (ids only) and kept for retry;
 *  3. the default-window sweep re-runs only the failed hook, clears it on
 *     success, and stops after ORG_DELETED_HOOK_MAX_ATTEMPTS (gave up, audited);
 *  4. registering the same id twice runs it once;
 *  5. a delete refused by the guard (business rows with `orgId`) runs no hook.
 *
 * Sabotage notes: calling the hooks before `orgs.delete` reds 1; letting a hook's
 * throw escape `runOneOrgDeletedHook` reds 2; never deleting the retry row on
 * success reds 3's "cleared".
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOrg, deleteOrg, getOrg, onOrgDeleted, retryFailedOrgDeletedHooks, ORG_DELETED_HOOK_MAX_ATTEMPTS,
  __listOrgDeletedRetriesForTests, __resetOrgDeletedHooksForTests,
} from '../accessControlService.js';
import { listChain } from '../auditChainService.js';
import { DurableCollection, initHostExtPersistence } from '../hostExtPersistence.js';
import { openStorage } from '../../storage/index.js';

interface BizRow { id: string; tenantId: string; orgId: string }
let biz: DurableCollection<BizRow>;
beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  biz = new DurableCollection<BizRow>('adr1161-test-business', (r) => r.id, undefined, (r) => r.tenantId);
});
beforeEach(() => { __resetOrgDeletedHooksForTests(); });

let n = 0;
const newOrg = async () => {
  const tenantId = `t-1161-${n++}`;
  const { orgId } = await createOrg({ tenantId, createdBy: 'own', name: 'W', ownerSubject: 'own' });
  return { tenantId, orgId };
};

describe('ADR 1161 — org-deleted hooks', () => {
  it('1. run after the org is gone', async () => {
    const o = await newOrg();
    const seen: Array<boolean> = [];
    onOrgDeleted('t.after', async (d) => { seen.push((await getOrg(d.orgId)) === null); return 1; });
    expect((await deleteOrg(o.orgId)).org).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('2. a throwing hook stops neither the others nor the delete, and is audited', async () => {
    const o = await newOrg();
    const ran: string[] = [];
    onOrgDeleted('t.throws', async () => { ran.push('throws'); throw new Error('store down'); });
    onOrgDeleted('t.next', async () => { ran.push('next'); return 2; });
    expect((await deleteOrg(o.orgId)).org).toBe(true);
    expect(await getOrg(o.orgId)).toBeNull();
    expect(ran).toEqual(['throws', 'next']);
    const retry = (await __listOrgDeletedRetriesForTests()).find((r) => r.orgId === o.orgId);
    expect(retry).toMatchObject({ tenantId: o.tenantId, hookId: 't.throws', attempts: 1 });
    const audit = (await listChain(o.tenantId)).map((e) => JSON.stringify(e));
    expect(audit.some((e) => e.includes('org.deleted.hook-failed') && e.includes('t.throws'))).toBe(true);
    expect(audit.some((e) => e.includes('store down')), 'ids only: no error text in the chain').toBe(false);
  });

  it('3. the sweep re-runs only the failed hook, clears it on success, and gives up after the cap', async () => {
    const o = await newOrg();
    let fail = true; let okRuns = 0; let flakyRuns = 0;
    onOrgDeleted('t.flaky', async () => { flakyRuns++; if (fail) throw new Error('x'); return 1; });
    onOrgDeleted('t.ok', async () => { okRuns++; return 1; });
    await deleteOrg(o.orgId);
    expect([flakyRuns, okRuns]).toEqual([1, 1]);
    fail = false;
    await retryFailedOrgDeletedHooks();
    expect([flakyRuns, okRuns], 'only the failed hook re-runs').toEqual([2, 1]);
    expect((await __listOrgDeletedRetriesForTests()).some((r) => r.orgId === o.orgId), 'cleared').toBe(false);

    const p = await newOrg();
    let stuckRuns = 0;
    onOrgDeleted('t.stuck', async () => { stuckRuns++; throw new Error('always'); });
    await deleteOrg(p.orgId);
    for (let i = 0; i < ORG_DELETED_HOOK_MAX_ATTEMPTS + 3; i++) await retryFailedOrgDeletedHooks();
    expect(stuckRuns).toBe(ORG_DELETED_HOOK_MAX_ATTEMPTS);
    expect((await __listOrgDeletedRetriesForTests()).find((r) => r.orgId === p.orgId && r.hookId === 't.stuck')).toMatchObject({ gaveUp: true, attempts: ORG_DELETED_HOOK_MAX_ATTEMPTS });
    expect((await listChain(p.tenantId)).some((e) => JSON.stringify(e).includes('org.deleted.hook-gave-up'))).toBe(true);
  });

  it('4. registering one id twice runs it once', async () => {
    const o = await newOrg();
    let runs = 0;
    const hook = async () => { runs++; return 0; };
    onOrgDeleted('t.once', hook); onOrgDeleted('t.once', hook);
    await deleteOrg(o.orgId);
    expect(runs).toBe(1);
  });

  it('5. a delete the guard refuses runs no hook', async () => {
    const o = await newOrg();
    await biz.put({ id: `b-${n++}`, tenantId: o.tenantId, orgId: o.orgId });
    let runs = 0;
    onOrgDeleted('t.blocked', async () => { runs++; return 0; });
    const r = await deleteOrg(o.orgId);
    expect(r.blocked?.rows).toBeGreaterThan(0);
    expect(runs).toBe(0);
    expect(await getOrg(o.orgId)).not.toBeNull();
  });
});
