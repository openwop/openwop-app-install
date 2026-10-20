/**
 * ADR 0927 D2 — the synthetic agency demo for campaign operations.
 *
 * Two fictional clients of the agency workspace, each with one live webinar
 * landing page registered as a campaign-ops asset, in `live` mode. Everything is
 * labelled "(synthetic)" and the client rows carry `synthetic: true`. Fixed ids
 * make seeding idempotent and clearing surgical: only rows under the two demo
 * client orgs are removed, never user data. Skipped while the `campaign-ops`
 * toggle is off (a seeder never flips toggles).
 *
 * The workspace's owners and admins get an admin row on each demo client, so the
 * person recording the demo can approve and the approved write runs under their
 * own CMS authority. The email-draft asset joins with ADR 0922 P0b.
 */
import type { Storage } from '../storage/storage.js';
import { resolveOne } from './featureToggles/service.js';
import { createMember, createOrg, deleteOrg, getOrg, listMembers } from './accessControlService.js';
import { createPage, deletePage, getPage, listPages, transitionPage } from '../features/cms/cmsService.js';
import { createClient, deleteClient, getClient, updateClient } from '../features/campaign-ops/clientService.js';
import { addAsset, listAssets, purgeAssetsForOrg } from '../features/campaign-ops/assetService.js';
import { purgeRequestsForOrg } from '../features/campaign-ops/requestService.js';
import { purgeChangeSetsForOrg } from '../features/campaign-ops/changeSetService.js';
import { purgeJobsForOrg } from '../features/campaign-ops/execution.js';

const ACTOR = 'demo:agency-ops';
const PAGE_PREFIX = 'page-copsdemo-';

export const AGENCY_OPS_DEMO_CLIENTS = [
  { orgId: 'org-copsdemo-northwind', name: 'Northwind Events (synthetic)', webinar: 'Q4 pipeline review', link: 'https://example.com/northwind/register-q4' },
  { orgId: 'org-copsdemo-bluefin', name: 'Bluefin Analytics (synthetic)', webinar: 'Dashboards that get read', link: 'https://example.com/bluefin/register-dashboards' },
] as const;

async function toggledOn(tenantId: string): Promise<boolean> {
  const a = await resolveOne('campaign-ops', { tenantId });
  return Boolean(a && a.enabled);
}

export async function countAgencyOpsDemo(tenantId: string): Promise<number> {
  let n = 0;
  for (const c of AGENCY_OPS_DEMO_CLIENTS) if ((await getClient(tenantId, c.orgId))?.synthetic) n++;
  return n;
}

export async function seedAgencyOpsDemo(tenantId: string, _storage?: Storage): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await toggledOn(tenantId))) return { created: 0, details: { skipped: 'campaign-ops is off for this workspace' } };
  let created = 0;
  // Workspace owners and admins become admins of each demo client.
  const leads = (await listMembers(tenantId, tenantId)).filter((m) => m.roles.some((r) => r === 'owner' || r === 'admin'));
  for (const c of AGENCY_OPS_DEMO_CLIENTS) {
    if (!(await getOrg(c.orgId))) {
      await createOrg({ tenantId, orgId: c.orgId, name: c.name, createdBy: ACTOR });
      for (const m of leads) await createMember({ tenantId, orgId: c.orgId, subject: m.subject, displayName: m.displayName, roles: ['admin'] });
    }
    if (!(await getClient(tenantId, c.orgId))) {
      await createClient({ tenantId, orgId: c.orgId, name: c.name, createdBy: ACTOR, synthetic: true });
      await updateClient(tenantId, c.orgId, { mode: 'live' });
      created++;
    }
    const pageId = `${PAGE_PREFIX}${c.orgId.slice('org-copsdemo-'.length)}`;
    let page = await getPage(tenantId, c.orgId, pageId);
    if (!page) {
      page = await createPage({
        tenantId, orgId: c.orgId, pageId, createdBy: ACTOR,
        title: `Webinar: ${c.webinar} (synthetic)`,
        sections: [
          { type: 'hero', data: { heading: `${c.webinar} — Tuesday, Nov 3 at 11:00 ET`, subheading: 'A 40-minute live session with Q&A. Seats are limited to the first 200 registrants.' } },
          { type: 'richText', data: { body: 'Join our team for a practical walkthrough. A recording goes to everyone who registers.' } },
          { type: 'cta', data: { heading: 'Save your seat', label: 'Register now', url: c.link } },
        ],
      });
      await transitionPage(tenantId, c.orgId, pageId, 'publish', ACTOR);
    }
    if ((await listAssets(tenantId, c.orgId)).length === 0) {
      const hero = page.sections[0].sectionId;
      const cta = page.sections[2].sectionId;
      await addAsset({
        tenantId, orgId: c.orgId, destination: 'openwop.cms.page', locator: { pageId }, label: 'Webinar landing page', synthetic: true, createdBy: ACTOR,
        editableFields: [`sections[${hero}].data.heading`, `sections[${hero}].data.subheading`, `sections[${cta}].data.label`, `sections[${cta}].data.url`],
      });
    }
  }
  return { created };
}

export async function clearAgencyOpsDemo(tenantId: string): Promise<{ cleared: number }> {
  let cleared = 0;
  for (const c of AGENCY_OPS_DEMO_CLIENTS) {
    if (!(await getOrg(c.orgId))) continue;
    cleared += await purgeJobsForOrg(tenantId, c.orgId);
    cleared += await purgeChangeSetsForOrg(tenantId, c.orgId);
    cleared += await purgeRequestsForOrg(tenantId, c.orgId);
    cleared += await purgeAssetsForOrg(tenantId, c.orgId);
    if (await deleteClient(tenantId, c.orgId)) cleared++;
    for (const p of await listPages(tenantId, c.orgId)) {
      if (p.pageId.startsWith(PAGE_PREFIX) && await deletePage(tenantId, c.orgId, p.pageId)) cleared++;
    }
    const r = await deleteOrg(c.orgId);
    if (r.org) cleared++;
  }
  return { cleared };
}
