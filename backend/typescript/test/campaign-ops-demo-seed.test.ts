/**
 * ADR 0927 D2 — the synthetic agency demo seeder: idempotent seed, skipped while
 * the toggle is off, every client labelled synthetic, and a clear that removes
 * the demo rows (and only those) so one command resets the demo.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createWorkspace, getOrg, listMembers } from '../src/host/accessControlService.js';
import { createPage, getPage } from '../src/features/cms/cmsService.js';
import { EXAMPLE_DATA_SEEDERS } from '../src/host/exampleDataSeeders.js';
import { AGENCY_OPS_DEMO_CLIENTS } from '../src/host/demoAgencyOpsSeed.js';
import { getClient, listClients } from '../src/features/campaign-ops/clientService.js';
import { listAssets } from '../src/features/campaign-ops/assetService.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
let TENANT: string;
const seeder = () => EXAMPLE_DATA_SEEDERS.find((s) => s.id === 'demo-agency-ops')!;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  const d = getToggleDefault('cms'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  TENANT = (await createWorkspace({ name: 'Demo Agency', ownerSubject: 'user:demo-owner' })).tenantId;
});

describe('ADR 0927 D2 — demo-agency-ops seeder', () => {
  it('is registered and skips while campaign-ops is off', async () => {
    const off = getToggleDefault('campaign-ops')!;
    await saveConfig({ ...off, status: 'off' }, 'test');
    const r = await seeder().seed(TENANT, storage);
    expect(r.created).toBe(0);
    expect(r.details).toMatchObject({ skipped: expect.any(String) });
    expect(await listClients(TENANT)).toEqual([]);
    await saveConfig({ ...off, status: 'on' }, 'test');
  });

  it('seeds two synthetic live clients, each with a live page asset, idempotently', async () => {
    expect((await seeder().seed(TENANT, storage)).created).toBe(2);
    expect((await seeder().seed(TENANT, storage)).created).toBe(0);
    expect(await seeder().count(TENANT, storage)).toBe(2);
    for (const c of AGENCY_OPS_DEMO_CLIENTS) {
      const client = await getClient(TENANT, c.orgId);
      expect(client).toMatchObject({ synthetic: true, mode: 'live', status: 'active' });
      expect(client!.displayName).toContain('(synthetic)');
      const assets = await listAssets(TENANT, c.orgId);
      expect(assets).toHaveLength(1);
      const page = await getPage(TENANT, c.orgId, (assets[0].locator as { pageId: string }).pageId);
      expect(page?.status).toBe('published');
      // The workspace owner can approve and write for the demo client.
      expect((await listMembers(TENANT, c.orgId)).some((m) => m.subject === 'user:demo-owner' && m.roles.includes('admin'))).toBe(true);
    }
  });

  it('clear removes the demo rows and leaves everything else alone', async () => {
    const other = (await createOrg({ tenantId: TENANT, createdBy: 'x', name: 'Real client' })).orgId;
    const keep = await createPage({ tenantId: TENANT, orgId: other, title: 'Keep me', createdBy: 'x', sections: [{ type: 'hero', data: { heading: 'Mine' } }] });
    const r = await seeder().clear(TENANT, storage);
    expect(r.cleared).toBeGreaterThan(0);
    expect(await seeder().count(TENANT, storage)).toBe(0);
    for (const c of AGENCY_OPS_DEMO_CLIENTS) expect(await getOrg(c.orgId)).toBeNull();
    expect(await getPage(TENANT, other, keep.pageId)).not.toBeNull();
    // Reset = clear then seed: the demo comes back fresh.
    expect((await seeder().seed(TENANT, storage)).created).toBe(2);
  });
});
