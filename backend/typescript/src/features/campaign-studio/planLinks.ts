/**
 * ADR 0941 D4 / P2 — a Campaign Studio canvas is a campaign's PLAN document.
 *
 * The link is its own row, owned here, not a `campaignId` field in the canvas
 * state: the state is written by six lanes (editor save, collab, restore, seed,
 * the agent tool, the AI lane) through a SYNCHRONOUS validator that cannot ask
 * whether a campaign exists, so a doc field could only ever be shape-checked.
 * The link is written by ONE route, which refuses a dangling or cross-client
 * campaign (`assertCampaignRef`), and is the child pointing up at the campaign.
 *
 * Rows: `campaign-studio:plan-link` (`tenant::canvasId` → the campaign; a plan
 * belongs to at most one campaign) and `campaign-studio:plan-by-campaign`
 * (`tenant::campaignId::canvasId`) for the campaign's links read. The reverse
 * row is written first and retained as a candidate; a reader re-checks the
 * active forward row. Removing a stale candidate could erase the marker a
 * concurrent relink needs. Clears are exact-row CAS markers, never deletes.
 * Canvas delete and campaign delete both clear the link.
 *
 * @see docs/adr/0941-campaign-studio-program-and-canonical-campaign.md
 */

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { getCanvasForTenant } from '../../host/canvasSurface.js';
import { assertCampaignRef } from '../../host/campaignRefs.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { onCanvasDeleted } from '../../host/canvasLifecycle.js';
import { onCampaignDeleted } from '../../host/campaignLifecycle.js';

export interface PlanLink { tenantId: string; canvasId: string; campaignId: string; orgId: string; linkedAt: string }
interface StoredPlanLink extends PlanLink { writeId?: string; clearedAt?: string }
interface PlanByCampaign { tenantId: string; campaignId: string; canvasId: string }

const links = new DurableCollection<StoredPlanLink>('campaign-studio:plan-link', (l) => `${l.tenantId}::${l.canvasId}`, undefined, (l) => l.tenantId);
const byCampaign = new DurableCollection<PlanByCampaign>('campaign-studio:plan-by-campaign', (r) => `${r.tenantId}::${r.campaignId}::${r.canvasId}`, undefined, (r) => r.tenantId);

async function rawPlanLink(tenantId: string, canvasId: string): Promise<StoredPlanLink | null> {
  const l = await links.get(`${tenantId}::${canvasId}`);
  return l && l.tenantId === tenantId && l.canvasId === canvasId ? l : null;
}

export async function getPlanLink(tenantId: string, canvasId: string): Promise<PlanLink | null> {
  const l = await rawPlanLink(tenantId, canvasId);
  return l && !l.clearedAt ? { tenantId: l.tenantId, canvasId: l.canvasId, campaignId: l.campaignId, orgId: l.orgId, linkedAt: l.linkedAt } : null;
}

async function clearObserved(expected: StoredPlanLink): Promise<boolean> {
  return links.compareAndSwap(expected, { ...expected, writeId: randomUUID(), clearedAt: new Date().toISOString() });
}

/** Link (or re-link) a plan to a campaign. The caller has authorized both sides. */
export async function setPlanLink(link: PlanLink): Promise<PlanLink> {
  await byCampaign.put({ tenantId: link.tenantId, campaignId: link.campaignId, canvasId: link.canvasId });
  const previous = await rawPlanLink(link.tenantId, link.canvasId);
  const written: StoredPlanLink = { tenantId: link.tenantId, campaignId: link.campaignId, canvasId: link.canvasId, orgId: link.orgId, linkedAt: link.linkedAt, writeId: randomUUID() };
  if (!(await links.compareAndSwap(previous, written))) {
    throw new OpenwopError('conflict', 'This plan link changed. Reload and try again.', 409, { reason: 'plan_link_changed' });
  }
  // Close deletion between route validation and the forward CAS. Clear only
  // our exact write: a concurrent relink belongs to its own caller.
  try {
    const canvas = await getCanvasForTenant(link.tenantId, link.canvasId);
    if (!canvas || canvas.canvasTypeId !== 'canvas.campaign') throw new OpenwopError('not_found', 'Plan not found.', 404);
    await assertCampaignRef(link.tenantId, link.orgId, link.campaignId);
  } catch (error) {
    if (error instanceof OpenwopError && error.httpStatus === 404) await clearObserved(written);
    throw error;
  }
  return link;
}

export async function clearPlanLink(tenantId: string, canvasId: string, orgId?: string): Promise<boolean> {
  const previous = await rawPlanLink(tenantId, canvasId);
  if (!previous || previous.clearedAt) return false;
  if (orgId !== undefined && previous.orgId !== orgId) throw new OpenwopError('not_found', 'Plan link not found.', 404);
  if (!(await clearObserved(previous))) throw new OpenwopError('conflict', 'This plan link changed. Reload and try again.', 409, { reason: 'plan_link_changed' });
  return true;
}

/** The plans linked to one campaign (a prefix read on that campaign). */
export async function listPlansForCampaign(tenantId: string, campaignId: string): Promise<PlanLink[]> {
  const out: PlanLink[] = [];
  for (const r of await byCampaign.listByPrefix(`${tenantId}::${campaignId}::`)) {
    if (r.tenantId !== tenantId || r.campaignId !== campaignId) continue;
    const l = await getPlanLink(tenantId, r.canvasId);
    if (l && l.campaignId === campaignId) out.push(l);
  }
  return out;
}

export function registerPlanLinkHooks(): void {
  onCanvasDeleted('campaign-studio-plan-link', async ({ tenantId, canvasId, canvasTypeId }) => {
    if (canvasTypeId === 'canvas.campaign') await clearPlanLink(tenantId, canvasId);
  });
  onCampaignDeleted('campaign-studio-plan-link', async ({ tenantId, campaignId }) => {
    for (const r of await byCampaign.listByPrefix(`${tenantId}::${campaignId}::`)) {
      if (r.tenantId !== tenantId || r.campaignId !== campaignId) continue;
      const l = await rawPlanLink(tenantId, r.canvasId);
      if (l && !l.clearedAt && l.campaignId === campaignId) await clearObserved(l);
    }
  });
}
