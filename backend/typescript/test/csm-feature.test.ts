/**
 * CSM feature (ADR 0001 §6 Phase 6) — the second feature, proving the contract
 * is additive (wired by appending to BACKEND_FEATURES only) and works for a
 * plain on/off feature with no variants/packs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetCsmStore,
  createAccount,
  getAccountForTenant,
  setAccountHealthForTenant,
  scrubCrmRefsForDeletedCompany,
} from '../src/features/csm/accountsService.js';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { buildCsmSurface } from '../src/features/csm/surface.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
import { createCompany, tombstoneCompany, __resetCrmEntities } from '../src/features/crm/crmEntitiesService.js';

describe('CSM feature (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __clearToggleStore();
    await __resetCsmStore();
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string> ?? {}) },
    });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  it('is registered as a backend feature (additive — appended to BACKEND_FEATURES)', () => {
    expect(BACKEND_FEATURES.some((f) => f.id === 'csm')).toBe(true);
  });

  it('404s while off, CRUD works once enabled', async () => {
    expect((await jf('/v1/host/openwop-app/csm/accounts')).status).toBe(404);
    const on = await jf('/v1/host/openwop-app/feature-toggles/admin/configs/csm', {
      method: 'PUT',
      body: JSON.stringify({ status: 'on', bucketUnit: 'tenant', salt: 'csm' }),
    });
    expect(on.status).toBe(200);

    const created = await jf<{ accountId: string; healthScore: number }>('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme', healthScore: 42 }),
    });
    expect(created.status).toBe(201);
    expect(created.body.healthScore).toBe(42);

    const list = await jf<{ accounts: { accountId: string }[] }>('/v1/host/openwop-app/csm/accounts');
    expect(list.body.accounts.some((a) => a.accountId === created.body.accountId)).toBe(true);
  });

  it('advertises the ctx.features.csm surface at /.well-known/openwop (ADR 0014)', async () => {
    const disco = await jf<{ hostExtensions?: { featureSurfaces?: string[] } }>('/.well-known/openwop');
    expect(disco.status).toBe(200);
    // The surface is registered at boot (csmFeature.surface), so it's advertised
    // regardless of toggle state; per-tenant gating is enforced at use, not here.
    expect(disco.body.hostExtensions?.featureSurfaces).toContain('host.sample.csm');
  });
});

describe('CSM extension surface (ADR 0014 — ctx.features.csm + nodes)', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await __resetCsmStore();
  });

  it('getAccountForTenant is tenant-guarded (cross-tenant id → null)', async () => {
    const a = await createAccount({ tenantId: 't1', name: 'Acme', healthScore: 30 });
    expect((await getAccountForTenant('t1', a.accountId))?.accountId).toBe(a.accountId);
    expect(await getAccountForTenant('t2', a.accountId)).toBeNull(); // CTI-1: no cross-tenant probe
  });

  it('setAccountHealthForTenant is tenant-guarded + idempotent (replay-safe)', async () => {
    const a = await createAccount({ tenantId: 't1', name: 'Beta', healthScore: 80 });
    expect(await setAccountHealthForTenant('t2', a.accountId, { healthScore: 10 })).toBeNull();
    const r1 = await setAccountHealthForTenant('t1', a.accountId, { healthScore: 12 });
    const r2 = await setAccountHealthForTenant('t1', a.accountId, { healthScore: 12 });
    expect(r1?.healthScore).toBe(12);
    expect(r2?.healthScore).toBe(12); // same inputs → same result (fork/replay never duplicates)
  });

  it('buildCsmSurface projects internal fields + tenant-isolates', async () => {
    await __resetCsmStore();
    const a = await createAccount({ tenantId: 't1', name: 'Gamma', healthScore: 5 });
    await createAccount({ tenantId: 't2', name: 'Other', healthScore: 5 });
    const surf = buildCsmSurface({ tenantId: 't1' });
    const { accounts } = (await surf.listAccounts({})) as { accounts: Record<string, unknown>[] };
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountId).toBe(a.accountId);
    expect(accounts[0].tenantId).toBeUndefined(); // internal column projected out
    const got = (await surf.getAccount({ accountId: a.accountId })) as { account: Record<string, unknown> | null };
    expect(got.account?.name).toBe('Gamma');
  });

  it('feature.csm.nodes read/set run over a stub ctx.features.csm', async () => {
    await __resetCsmStore();
    const mod = await import('../../../packs/feature.csm.nodes/index.mjs');
    const a = await createAccount({ tenantId: 't1', name: 'Delta', healthScore: 90 });
    const surf = buildCsmSurface({ tenantId: 't1' });
    const ctx = (inputs: Record<string, unknown>) => ({ features: { csm: surf }, inputs });
    const read = await mod.nodes['feature.csm.nodes.health-read'](ctx({}));
    expect(read.status).toBe('success');
    const set = await mod.nodes['feature.csm.nodes.health-set'](ctx({ accountId: a.accountId, healthScore: 20 }));
    expect(set.status).toBe('success');
    expect((await getAccountForTenant('t1', a.accountId))?.healthScore).toBe(20);
  });
});

describe('CSM↔CRM linkage (ADR 0212)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __clearToggleStore();
    await __resetCsmStore();
    await __resetCrmEntities();
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
    await jf('/v1/host/openwop-app/feature-toggles/admin/configs/csm', {
      method: 'PUT',
      body: JSON.stringify({ status: 'on', bucketUnit: 'tenant', salt: 'csm' }),
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string> ?? {}) },
    });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  it('§1: POST /accounts 404s on a dangling crmRef (company not found)', async () => {
    const res = await jf('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Dangling', crmRef: { orgId: 'org-1', companyId: 'cmp:does-not-exist' } }),
    });
    expect(res.status).toBe(404);
  });

  it('§1: POST /accounts 400s on a half-ref (orgId without companyId)', async () => {
    const res = await jf('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'HalfRef', crmRef: { orgId: 'org-1' } }),
    });
    expect(res.status).toBe(400);
  });

  it('§1: a real, same-tenant company links; a cross-tenant company 404s fail-closed', async () => {
    const company = await createCompany({ tenantId: 'default', orgId: 'org-1', name: 'Real Co', createdBy: 'user:test' });
    const created = await jf<{ accountId: string; crmRef?: { orgId: string; companyId: string } }>('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Linked', crmRef: { orgId: 'org-1', companyId: company.companyId } }),
    });
    expect(created.status).toBe(201);
    expect(created.body.crmRef).toEqual({ orgId: 'org-1', companyId: company.companyId });

    // A company that exists, but under a DIFFERENT tenant, reads as not-found
    // for 'default' (CTI-1) — never leak/link across tenants.
    const otherTenantCompany = await createCompany({ tenantId: 'other-tenant', orgId: 'org-1', name: 'Other Tenant Co', createdBy: 'user:test' });
    const crossTenant = await jf('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'ShouldFail', crmRef: { orgId: 'org-1', companyId: otherTenantCompany.companyId } }),
    });
    expect(crossTenant.status).toBe(404);
  });

  it('§1: a merge-tombstoned company fails closed (not just missing)', async () => {
    const company = await createCompany({ tenantId: 'default', orgId: 'org-1', name: 'Soon Tombstoned', createdBy: 'user:test' });
    await tombstoneCompany('default', 'org-1', company.companyId, 'cmp:survivor');
    const res = await jf('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'ShouldFail', crmRef: { orgId: 'org-1', companyId: company.companyId } }),
    });
    expect(res.status).toBe(404);
  });

  // CSMWF-2 / ADR 0645 D2 — a MERGED company must not yield a fabricated score.
  // `mergeCompany` tombstones without firing `fireCrmRecordDeleted`, so `crmRef`
  // keeps pointing at the tombstone; `listDeals`/`listTasks` FILTER without
  // validating existence and return [], so both fan-ins are present, every
  // ADR 0582 §4 guard passes, and `100 - 0 - 0` gets stamped as a real
  // measurement — the greenest chip on the page. That is ADR 0582's own headline
  // defect arriving through a different door: `portfolioArrAtRisk` counts `< 70`,
  // so the executive summary gets QUIETER exactly when measurement breaks.
  it('CSMWF-2: a merge-tombstoned company REFUSES to score instead of writing 100', async () => {
    const company = await createCompany({ tenantId: 'default', orgId: 'org-1', name: 'Merges Later', createdBy: 'user:test' });
    const created = await jf<{ accountId: string }>('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'MergeVictim', crmRef: { orgId: 'org-1', companyId: company.companyId } }),
    });
    const id = created.body.accountId;

    // Non-vacuity: while the company is live, a computed set IS accepted.
    const ok = await setAccountHealthForTenant('default', id, {
      healthScore: 42, factors: [{ factor: 'openDeals', weight: 8, value: 7 }],
      method: 'penalty-sum', computedForCompanyId: company.companyId,
    });
    expect(ok?.healthScore).toBe(42);

    await tombstoneCompany('default', 'org-1', company.companyId, 'cmp:survivor');

    // Now the SAME payload — exactly what the chain sends for an empty fan-in —
    // must be refused, RECORDED, and then FAIL TYPED.
    //
    // CSMCD-1 correction: the first cut of this fix RETURNED the marker row.
    // That row is truthy, so the surface handed the node a non-null `{account}`
    // and the node reported `status:'success'` — the run completed GREEN while
    // its declared output was a row that had never been rescored. Recording the
    // refusal and failing typed is the shape the pack's own `refuseToScore`
    // already uses; both halves are asserted here, because the throw alone would
    // leave the console showing a stale green score forever.
    await expect(setAccountHealthForTenant('default', id, {
      healthScore: 100, factors: [{ factor: 'openDeals', weight: 8, value: 0 }],
      method: 'penalty-sum', computedForCompanyId: company.companyId,
    })).rejects.toMatchObject({ code: 'validation_error' });
    const after = await getAccountForTenant('default', id);
    expect(after?.healthMeasureFailedReason, 'must record WHY it stopped measuring').toBeTruthy();
    expect(after?.healthMeasureFailedAt).toBeTruthy();
    // The fabricated 100 must NOT land. The last honest score survives, which is
    // the existing `measureFailed` contract — the row keeps its last real number
    // and the recorded failure outranks it in the UI
    // (`csmMeasurementHonesty.test.tsx:81`). What must never happen is the empty
    // fan-in overwriting it with a fresh, greener, fictional measurement.
    expect(after?.healthScore, 'the empty fan-in must not overwrite the last honest score').toBe(42);
  });

  // CSMWF-2 second half — on the DELETE path the cascade scrubs `crmRef`, after
  // which the service THREW rather than routing through the refusal, so the
  // durable "why I stopped measuring" marker was never written and the account
  // kept its last score and stamp forever. The whole point of `measureFailed` is
  // defeated on the one path where the link is legitimately gone.
  it('CSMWF-2: a scrubbed crmRef records the refusal rather than throwing', async () => {
    const company = await createCompany({ tenantId: 'default', orgId: 'org-1', name: 'Deleted Later', createdBy: 'user:test' });
    const created = await jf<{ accountId: string }>('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'DeleteVictim', crmRef: { orgId: 'org-1', companyId: company.companyId } }),
    });
    const id = created.body.accountId;
    await scrubCrmRefsForDeletedCompany('default', company.companyId, 'org-1');

    await expect(setAccountHealthForTenant('default', id, {
      healthScore: 100, factors: [{ factor: 'openDeals', weight: 8, value: 0 }],
      method: 'penalty-sum', computedForCompanyId: company.companyId,
    })).rejects.toMatchObject({ code: 'validation_error' });
    const after = await getAccountForTenant('default', id);
    expect(after?.healthMeasureFailedReason).toBeTruthy();
    expect(after?.healthMeasureFailedAt).toBeTruthy();
  });

  // CSMCD-1 — THE SEAM WITNESS whose absence let the Blocker through. Both D2
  // tests above call the SERVICE directly, and `csm-packs.test.ts` stubs
  // `setHealth`, so nothing in the repo drove the NODE against a REAL service
  // refusal. That is exactly where the defect lived: the service returned a
  // truthy marker row, the surface passed it on, and `healthSet` reported
  // `status:'success'` — a run that completed green having never rescored.
  it('CSMCD-1: the NODE fails when the real service refuses — no success-with-empty', async () => {
    const { healthSet } = (await import(
      pathToFileURL(join(REPO_ROOT, 'packs', 'feature.csm.nodes', 'index.mjs')).href
    )) as { healthSet: (ctx: unknown) => Promise<{ status: string }> };

    const company = await createCompany({ tenantId: 'default', orgId: 'org-1', name: 'Seam Co', createdBy: 'user:test' });
    const created = await jf<{ accountId: string }>('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'SeamVictim', crmRef: { orgId: 'org-1', companyId: company.companyId } }),
    });
    const surface = buildCsmSurface({ tenantId: 'default' } as never);
    const ctx = {
      features: { csm: surface },
      inputs: { accountId: created.body.accountId, deals: [], tasks: [], companyId: company.companyId },
      config: {},
    };

    // Non-vacuity: while the company is LIVE the node succeeds through the very
    // same wiring, so a failure below cannot be blamed on the harness.
    const okRun = await healthSet(ctx);
    expect(okRun.status).toBe('success');

    await tombstoneCompany('default', 'org-1', company.companyId, 'cmp:survivor2');

    // Now the service refuses. The node MUST fail — not return success carrying
    // a row it never rescored.
    await expect(healthSet(ctx)).rejects.toBeTruthy();
    // …and the durable marker must still be there, because the run failing is
    // invisible from the CSM console.
    const after = await getAccountForTenant('default', created.body.accountId);
    expect(after?.healthMeasureFailedReason).toBeTruthy();
  });

  it('§1: PATCH with crmRef: null clears an existing link', async () => {
    const company = await createCompany({ tenantId: 'default', orgId: 'org-1', name: 'Clear Me Co', createdBy: 'user:test' });
    const created = await jf<{ accountId: string }>('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'ToClear', crmRef: { orgId: 'org-1', companyId: company.companyId } }),
    });
    const cleared = await jf<{ crmRef?: unknown }>(`/v1/host/openwop-app/csm/accounts/${created.body.accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ crmRef: null }),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.crmRef).toBeUndefined();
  });

  /** ADR 0582 §4 — a COMPUTED set must name the company it measured and that
   *  company must be the account's own link, so the fixture needs a real one. */
  async function linkedAccount(name: string): Promise<{ accountId: string; companyId: string }> {
    const company = await createCompany({ tenantId: 'default', orgId: 'org-1', name: `${name} Co`, createdBy: 'user:test' });
    const created = await jf<{ accountId: string }>('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name, crmRef: { orgId: 'org-1', companyId: company.companyId } }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return { accountId: created.body.accountId, companyId: company.companyId };
  }

  it('§2: the surface setHealth with `factors` sets healthFactors + stamps healthComputedAt (computed)', async () => {
    const { accountId, companyId } = await linkedAccount('ComputedHealth');
    const surf = buildCsmSurface({ tenantId: 'default' });
    const out = (await surf.setHealth({
      accountId,
      healthScore: 55,
      factors: [{ factor: 'openDeals', weight: 8, value: 2 }],
      companyId,
      method: 'penalty-sum',
    })) as { account: { healthFactors?: unknown[]; healthComputedAt?: string; healthScore?: number; healthMethod?: string } };
    expect(out.account.healthScore).toBe(55);
    expect(out.account.healthFactors).toEqual([{ factor: 'openDeals', weight: 8, value: 2 }]);
    expect(out.account.healthComputedAt).toBeTruthy();
    // ADR 0582 §5 — the arithmetic rides with the numbers.
    expect(out.account.healthMethod).toBe('penalty-sum');
  });

  it('§2/ADR 0582 §4: a computed set for a DIFFERENT company than the account is linked to is refused', async () => {
    const { accountId } = await linkedAccount('MisScoped');
    const surf = buildCsmSurface({ tenantId: 'default' });
    // The `csm-ops.health-from-crm` chain takes orgId/companyId/accountId as
    // three INDEPENDENT run parameters; nothing used to check they agreed, so a
    // mis-parameterised run scored an account from another customer's deals and
    // stamped the result as computed.
    await expect(surf.setHealth({
      accountId, healthScore: 90, factors: [{ factor: 'openDeals', weight: 8, value: 0 }],
      companyId: 'cmp:some-other-company', method: 'penalty-sum',
    })).rejects.toMatchObject({ code: 'validation_error' });
    // ...and omitting the company entirely is refused too (no silent skip).
    await expect(surf.setHealth({
      accountId, healthScore: 90, factors: [{ factor: 'openDeals', weight: 8, value: 0 }], method: 'penalty-sum',
    })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('§2: a MANUAL PATCH healthScore (no factors — the only shape the HTTP route sends) clears prior computed factors', async () => {
    const { accountId, companyId } = await linkedAccount('WasComputed');
    const surf = buildCsmSurface({ tenantId: 'default' });
    await surf.setHealth({ accountId, healthScore: 40, factors: [{ factor: 'openTasks', weight: 3, value: 5 }], companyId, method: 'penalty-sum' });

    const patched = await jf<{ healthFactors?: unknown; healthComputedAt?: unknown; healthScore?: number; healthMethod?: unknown }>(
      `/v1/host/openwop-app/csm/accounts/${accountId}`,
      { method: 'PATCH', body: JSON.stringify({ healthScore: 10 }) },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.healthScore).toBe(10);
    expect(patched.body.healthFactors).toBeUndefined();
    expect(patched.body.healthComputedAt).toBeUndefined();
    expect(patched.body.healthMethod).toBeUndefined();
  });

  it('§2: healthFactors is bounded — >12 entries or an oversized factor name is a validation_error', async () => {
    const surf = buildCsmSurface({ tenantId: 'default' });
    const tooMany = Array.from({ length: 13 }, (_, i) => ({ factor: `f${i}`, weight: 1, value: 1 }));
    await expect(surf.setHealth({ accountId: 'csm:nonexistent', healthScore: 1, factors: tooMany, method: 'penalty-sum' })).rejects.toThrow();
    const tooLongName = [{ factor: 'x'.repeat(65), weight: 1, value: 1 }];
    await expect(surf.setHealth({ accountId: 'csm:nonexistent', healthScore: 1, factors: tooLongName, method: 'penalty-sum' })).rejects.toThrow();
  });
});

describe('R2 csm honesty ratchets (UX_UPGRADE-csm XCS-2/3)', () => {
  it('factors WITHOUT healthScore are rejected fail-closed (CS-SP-4 — they minted a fresh computed stamp on a stale score)', async () => {
    const { createAccount, setAccountHealthForTenant } = await import('../src/features/csm/accountsService.js');
    const company = await createCompany({ tenantId: 't-r2', orgId: 'org-r2', name: 'Stamp Co', createdBy: 'user:test' });
    const a = await createAccount({ tenantId: 't-r2', name: 'StampCo', healthScore: 60, crmRef: { orgId: 'org-r2', companyId: company.companyId } });
    await expect(setAccountHealthForTenant('t-r2', a.accountId, {
      factors: [{ factor: 'Usage', weight: 100, value: 10 }],
      computedForCompanyId: company.companyId,
      method: 'weighted-mean',
    })).rejects.toMatchObject({ code: 'validation_error' });
    // The accept polarity: score + factors + the company measured + the method.
    const ok = await setAccountHealthForTenant('t-r2', a.accountId, {
      healthScore: 10,
      factors: [{ factor: 'Usage', weight: 100, value: 10 }],
      computedForCompanyId: company.companyId,
      method: 'weighted-mean',
    });
    expect(ok?.healthFactors).toHaveLength(1);
    expect(ok?.healthComputedAt).toBeDefined();
    expect(ok?.healthMethod).toBe('weighted-mean');
  });

  it('ADR 0582 §5: a factor breakdown with no stated arithmetic is refused (the two in-tree producers disagree under identical headers)', async () => {
    const { createAccount, setAccountHealthForTenant } = await import('../src/features/csm/accountsService.js');
    const company = await createCompany({ tenantId: 't-r2', orgId: 'org-r2', name: 'Method Co', createdBy: 'user:test' });
    const a = await createAccount({ tenantId: 't-r2', name: 'MethodCo', crmRef: { orgId: 'org-r2', companyId: company.companyId } });
    await expect(setAccountHealthForTenant('t-r2', a.accountId, {
      healthScore: 70,
      factors: [{ factor: 'Usage', weight: 100, value: 70 }],
      computedForCompanyId: company.companyId,
    })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('arrCurrency validates, uppercases, clears with null, and never survives without an amount (CS-SP-2)', async () => {
    const { createAccount, updateAccount } = await import('../src/features/csm/accountsService.js');
    const a = await createAccount({ tenantId: 't-r2', name: 'CurCo', arr: 1000, arrCurrency: 'eur' });
    expect(a.arrCurrency).toBe('EUR'); // uppercased at the boundary
    await expect(createAccount({ tenantId: 't-r2', name: 'BadCo', arr: 1, arrCurrency: 'NOPE!' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    // A currency without an amount is never stored.
    const noAmount = await createAccount({ tenantId: 't-r2', name: 'UnitOnly', arrCurrency: 'USD' });
    expect(noAmount.arrCurrency).toBeUndefined();
    // null clears the unit; clearing the amount drops the unit with it.
    const cleared = await updateAccount(a.accountId, { arrCurrency: null });
    expect(cleared?.arrCurrency).toBeUndefined();
    const b = await updateAccount(a.accountId, { arr: 500, arrCurrency: 'USD' });
    expect(b?.arrCurrency).toBe('USD');
    const dropped = await updateAccount(a.accountId, { arr: null });
    expect(dropped?.arr).toBeUndefined();
    expect(dropped?.arrCurrency).toBeUndefined(); // a row without an amount carries no unit
  });
});

