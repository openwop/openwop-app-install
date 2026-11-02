/**
 * ADR 0927 D2 — the synthetic agency demo seeder: idempotent seed, skipped while
 * the toggle is off, every client labelled synthetic, and a clear that removes
 * the demo rows (and only those) so one command resets the demo.
 *
 * Every case starts from a cleared demo with campaign-ops on (`beforeEach`), so
 * the cases pass alone and in any order.
 *
 * Tracker: TST-CBA-4 (/grade-tests wave 67). Red when (probe-witnessed,
 * 2026-10-29): the toggle check in `seedAgencyOpsDemo` is skipped (skip case);
 * a client is not marked synthetic, not switched live, its page not published,
 * or the workspace leads not made client admins (seed case); `clear` stops
 * deleting the demo org, or deletes every page of a demo org instead of only
 * the `PAGE_PREFIX` seed pages (clear case).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createWorkspace, getOrg, listMembers } from '../src/host/accessControlService.js';
import { createPage, deletePage, getPage } from '../src/features/cms/cmsService.js';
import { EXAMPLE_DATA_SEEDERS, type ExampleDataSeeder } from '../src/host/exampleDataSeeders.js';
import { AGENCY_OPS_DEMO_CLIENTS } from '../src/host/demoAgencyOpsSeed.js';
import { createClient, getClient, listClients } from '../src/features/campaign-ops/clientService.js';
import { listAssets } from '../src/features/campaign-ops/assetService.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
let TENANT: string;
function seeder(): ExampleDataSeeder {
  const s = EXAMPLE_DATA_SEEDERS.find((x) => x.id === 'demo-agency-ops');
  if (!s) throw new Error('demo-agency-ops seeder is not registered');
  return s;
}
async function campaignOps(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('campaign-ops');
  if (!d) throw new Error('campaign-ops toggle is not registered');
  await saveConfig({ ...d, status }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  const d = getToggleDefault('cms'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  TENANT = (await createWorkspace({ name: 'Demo Agency', ownerSubject: 'user:demo-owner' })).tenantId;
});
beforeEach(async () => {
  await campaignOps('on');
  await seeder().clear(TENANT, storage);
});

describe('ADR 0927 D2 — demo-agency-ops seeder', () => {
  it('is registered and skips while campaign-ops is off', async () => {
    await campaignOps('off');
    try {
      const r = await seeder().seed(TENANT, storage);
      expect(r.created).toBe(0);
      expect(r.details).toEqual({ skipped: 'campaign-ops is off for this workspace' });
      const demoIds: readonly string[] = AGENCY_OPS_DEMO_CLIENTS.map((c) => c.orgId);
      expect((await listClients(TENANT)).filter((c) => demoIds.includes(c.orgId))).toEqual([]);
      expect(await seeder().count(TENANT, storage)).toBe(0);
    } finally {
      await campaignOps('on');
    }
  });

  it('seeds two synthetic live clients, each with a live page asset, idempotently', async () => {
    expect((await seeder().seed(TENANT, storage)).created).toBe(2);
    expect((await seeder().seed(TENANT, storage)).created).toBe(0);
    expect(await seeder().count(TENANT, storage)).toBe(2);
    for (const c of AGENCY_OPS_DEMO_CLIENTS) {
      const client = await getClient(TENANT, c.orgId);
      expect(client).toMatchObject({ synthetic: true, mode: 'live', status: 'active' });
      expect(client?.displayName).toContain('(synthetic)');
      const assets = await listAssets(TENANT, c.orgId);
      expect(assets).toHaveLength(1);
      const locator = assets[0].locator;
      const page = 'pageId' in locator ? await getPage(TENANT, c.orgId, locator.pageId) : null;
      expect(page?.status).toBe('published');
      // The workspace owner can approve and write for the demo client.
      expect((await listMembers(TENANT, c.orgId)).some((m) => m.subject === 'user:demo-owner' && m.roles.includes('admin'))).toBe(true);
    }
  });

  it('clear removes the demo rows and leaves everything else alone', async () => {
    expect((await seeder().seed(TENANT, storage)).created).toBe(2);
    const [first, second] = AGENCY_OPS_DEMO_CLIENTS;
    // A real client of the agency, and a page a person made inside a demo org.
    const other = (await createOrg({ tenantId: TENANT, createdBy: 'x', name: 'Real client' })).orgId;
    await createClient({ tenantId: TENANT, orgId: other, name: 'Real client', createdBy: 'x' });
    const keep = await createPage({ tenantId: TENANT, orgId: other, title: 'Keep me', createdBy: 'x', sections: [{ type: 'hero', data: { heading: 'Mine' } }] });
    const human = await createPage({ tenantId: TENANT, orgId: first.orgId, title: 'Made by a person', createdBy: 'x', sections: [{ type: 'hero', data: { heading: 'Ours' } }] });
    try {
      const r = await seeder().clear(TENANT, storage);
      // Per demo org: its asset, its client row and its seed page; plus the org
      // itself for the second (the first still holds the person's page, so the
      // org-delete guard leaves it).
      expect(r.cleared).toBe(7);
      expect(await seeder().count(TENANT, storage)).toBe(0);
      expect(await getOrg(second.orgId)).toBeNull();
      expect(await getPage(TENANT, first.orgId, human.pageId)).not.toBeNull();
      expect(await getPage(TENANT, other, keep.pageId)).not.toBeNull();
      expect(await getClient(TENANT, other)).not.toBeNull();
      // Reset = clear then seed: the demo comes back fresh.
      expect((await seeder().seed(TENANT, storage)).created).toBe(2);
    } finally {
      await deletePage(TENANT, first.orgId, human.pageId);
    }
  });
});
