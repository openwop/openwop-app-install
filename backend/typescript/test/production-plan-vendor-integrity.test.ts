/**
 * PIC-1 — plan→vendor referential integrity. The production-intelligence plan
 * path (`savePlan` → `cleanRecommendations`) persisted any
 * `matchingVendors[].vendorId` verbatim, so a model-fabricated vendor
 * (`vnd:ghost-does-not-exist`, no directory row) survived the durable write and
 * rendered as a real recommendation. This pins the fix: a recommended vendorId
 * that is not in the tenant/org vendor directory is DROPPED (a dangling
 * reference is never persisted); real vendors are kept.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createVendor, savePlan, getPlan } from '../src/features/production/productionService.js';

const TENANT = 'default';
let server: http.Server;
let orgId: string;
let realVendorId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
  const v = await createVendor({
    tenantId: TENANT, orgId, type: 'agency', name: 'Real Vendor',
    capabilities: [], priceRanges: [], createdBy: 'u-1',
  });
  realVendorId = v.vendorId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('PIC-1 — plan→vendor referential integrity', () => {
  it('drops a fabricated matchingVendor (no directory row) but keeps the real one', async () => {
    const plan = await savePlan({
      tenantId: TENANT, orgId,
      strategySummary: 'Strategy',
      recommendations: [{
        assetType: 'video', executionRoute: 'contractor', rationale: 'r',
        matchingVendors: [
          { vendorId: realVendorId, name: 'Real Vendor', type: 'agency', matchReason: 'in the directory' },
          { vendorId: 'vnd:ghost-does-not-exist', name: 'Ghost Co', type: 'agency', matchReason: 'hallucinated' },
        ],
      }],
    });
    const persisted = await getPlan(TENANT, orgId, plan.planId);
    const ids = (persisted?.recommendations[0]?.matchingVendors ?? []).map((mv) => mv.vendorId);
    expect(ids, 'the real vendor must survive (no over-drop)').toContain(realVendorId);
    expect(ids, 'the fabricated vendor must be dropped — a dangling reference is never persisted')
      .not.toContain('vnd:ghost-does-not-exist');
  });
});
