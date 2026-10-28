/**
 * ADR 0852 D1/D2 — a campaign's linked project (`facet:'campaign'`).
 *
 * The project is the one collaboration container: a campaign gets its board,
 * chat, members and team ledger by having a project, not by growing its own.
 *
 * THE LINK IS ITS OWN ROW (`campaign-orchestration:project-link`, one per
 * campaign), written with `putIfAbsent`: two concurrent "ensure" calls create two
 * projects, exactly one link wins, and the loser deletes its project. The
 * campaign row is never compare-and-swapped for this.
 *
 * FAIL-SOFT ON FINALIZE. Creating the project can fail (the workspace's project
 * cap, a storage error); finalizing a campaign must not. The lazy route (or the
 * next finalize) creates it later.
 *
 * DELETE ⇒ ARCHIVE. Deleting the campaign archives its project and clears the
 * facet (so the visibility lock lifts); the project, its board, chat and ledger
 * history follow the project's own delete and erasure rules from then on.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { onCampaignDeleted } from '../../host/campaignLifecycle.js';
import { registerRunProjectResolver } from '../../host/runProjectBinding.js';
import { createLogger } from '../../observability/logger.js';
import { createProject, deleteProject, getProject, setProjectFacet, updateProject } from '../projects/projectsService.js';
import { getCampaign, getCampaignByBrief } from './campaignService.js';
import type { MarketingCampaign } from './types.js';

const log = createLogger('feature.campaign-orchestration.project');

interface CampaignProjectLink { tenantId: string; campaignId: string; projectId: string; createdAt: string }
const linkKey = (tenantId: string, campaignId: string): string => `${tenantId}::${campaignId}`;
const links = new DurableCollection<CampaignProjectLink>('campaign-orchestration:project-link', (l) => linkKey(l.tenantId, l.campaignId), undefined, (l) => l.tenantId);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/** The campaign's project id, when its link row names a project that still exists. */
export async function getCampaignProjectId(tenantId: string, campaignId: string): Promise<string | undefined> {
  const l = await links.get(linkKey(tenantId, campaignId));
  if (!l || l.tenantId !== tenantId) return undefined;
  return (await getProject(tenantId, l.projectId)) ? l.projectId : undefined;
}

/** Create-or-return the campaign's project. Race-safe; a stale link (the project was deleted) is replaced. */
export async function ensureCampaignProject(campaign: MarketingCampaign, actor: string): Promise<string> {
  const existing = await getCampaignProjectId(campaign.tenantId, campaign.id);
  if (existing) return existing;
  // A link whose project was deleted is stale: remove it, but only after
  // re-checking — a concurrent ensure may have just written a FRESH link here,
  // and deleting that would orphan its project.
  const seen = await links.get(linkKey(campaign.tenantId, campaign.id));
  if (seen && !(await getProject(campaign.tenantId, seen.projectId))) {
    const now = await links.get(linkKey(campaign.tenantId, campaign.id));
    if (now && now.projectId === seen.projectId) await links.delete(linkKey(campaign.tenantId, campaign.id));
  }
  const project = await createProject(campaign.tenantId, campaign.orgId, { name: campaign.name.slice(0, 120), facet: 'campaign' }, actor);
  const won = await links.putIfAbsent({ tenantId: campaign.tenantId, campaignId: campaign.id, projectId: project.id, createdAt: new Date().toISOString() });
  if (won) return project.id;
  await deleteProject(campaign.tenantId, project.id); // lost the race: keep exactly one
  const winner = await getCampaignProjectId(campaign.tenantId, campaign.id);
  if (!winner) throw new Error(`campaign ${campaign.id}: the winning project link names no project`);
  return winner;
}

/** On first finalize: try to give the new campaign its project; never fail the finalize. */
export async function linkProjectOnFinalize(campaign: MarketingCampaign, actor: string): Promise<void> {
  try {
    await ensureCampaignProject(campaign, actor);
  } catch (err) {
    log.warn('campaign_project_create_failed', { campaignId: campaign.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Boot wiring: delete ⇒ archive, and campaign runs bind to the campaign's project. */
export function registerCampaignProjectHooks(): void {
  onCampaignDeleted('campaign-project-archive', async ({ tenantId, campaignId }) => {
    const l = await links.get(linkKey(tenantId, campaignId));
    if (!l || l.tenantId !== tenantId) return;
    const project = await getProject(tenantId, l.projectId);
    if (project) {
      await setProjectFacet(tenantId, project.id, undefined);
      await updateProject(tenantId, project.id, { charter: { ...(project.charter ?? {}), status: 'archived' } }, { actor: 'system', origin: 'direct' });
    }
    await links.delete(linkKey(tenantId, campaignId));
  });

  registerRunProjectResolver('campaign', async (tenantId, metadata) => {
    const block = isObj(metadata.campaignOrchestration) ? metadata.campaignOrchestration
      : isObj(metadata.campaignChannel) ? metadata.campaignChannel : undefined;
    // ADR 0941 D2b — a tagged run names its campaign; a pre-0941 block (and the
    // channel block) names only the brief, resolved through the brief index.
    if (block && typeof block.campaignId === 'string' && block.campaignId) {
      const tagged = await getCampaign(tenantId, block.campaignId);
      return tagged ? getCampaignProjectId(tenantId, tagged.id) : undefined;
    }
    const briefId = block && typeof block.briefId === 'string' ? block.briefId : undefined;
    if (!briefId) return undefined;
    const campaign = await getCampaignByBrief(tenantId, briefId);
    return campaign ? getCampaignProjectId(tenantId, campaign.id) : undefined;
  });
}

/** For a route: the campaign (already access-checked by the caller) and its project. */
export async function campaignWithProject(tenantId: string, campaignId: string): Promise<(MarketingCampaign & { projectId?: string }) | null> {
  const c = await getCampaign(tenantId, campaignId);
  if (!c) return null;
  const projectId = await getCampaignProjectId(tenantId, campaignId);
  return { ...c, ...(projectId ? { projectId } : {}) };
}
