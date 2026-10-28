/**
 * Campaign Studio workflow surface (ADR 0158 / ADR 0014) —
 * `ctx.features['campaign-orchestration']`. Tenant-trusted reads + `finalizeFromBrief`
 * the finalize node calls. Composes the brief (ADR 0156) by reading it.
 *
 * ADR 0941 P5 — the campaign-scoped reads (`campaignContext`, `links`) are
 * resolved ONLY from the calling run's host-written run tag, never from an
 * argument (D2b: "every campaign-scoped read trusts only this tag"). A run with
 * no tag is `not_a_campaign_run`; a tag naming a campaign that is gone or in
 * another org is `campaign_not_found`; a tag and client stamp that disagree are
 * `wrong_client`. In a tagged run the id-taking reads (`getCampaign`,
 * `attachAssets`) also refuse a campaign of another client.
 *
 * Org scoping of rows named by id (security fix, 2026-10-20, the campaign-brief
 * fix's shape): `getCampaign`, `attachAssets` and `finalizeFromBrief` used to be
 * tenant-only by id, so in an agency workspace a client-A run could read client
 * B's campaign, attach assets to it, or finalize B's brief into B's campaign. The
 * ADR 0832 floor fires only on an `orgId` argument, and these take ids. Now the
 * row's org must equal `orgId` when given, else the run's person (actor, else
 * causing member) must hold the scope in the row's org; the writes need
 * `workspace:write`. Every refusal is the same not-found as a missing row. An
 * actorless, causeless run stays tenant-trusted (the seam's own rule).
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 * @see docs/adr/0941-campaign-studio-program-and-canonical-campaign.md
 */

import { OpenwopError } from '../../types.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { CampaignRunWrongClientError, readCampaignRunTag, type CampaignRunTag } from '../../host/campaignRefs.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { runOrgScopeFilter, type Scope } from '../../host/accessControlService.js';
import { getBrief } from '../campaign-brief/briefService.js';
import { attachCampaignAssets, getCampaign, getCampaignByBrief, listCampaigns, finalizeFromBrief } from './campaignService.js';
import { readCampaignLinks } from './campaignLinks.js';
import type { CampaignGoal, MarketingCampaign } from './types.js';
import { currentEffectContext } from '../../host/runEffectContext.js';
import { autonomyToggleOn, CHOKEPOINT_CLASSES, closeVetoWindow, deliverAutonomyDigest, emitAutonomyNotice, markVetoNotified, openVetoWindow, vetoIdFor, decideGate, findRule, parseGateArgs, runAutonomyOf } from '../../host/autonomyPolicy/index.js';
import type { RunRecord } from '../../types.js';

async function ownRun(scope: BundleScope): Promise<RunRecord | null> {
  if (!scope.runId) return null;
  const run = await hostExtStorage().getRun(scope.runId);
  return run && run.tenantId === scope.tenantId ? run : null;
}

type TagRead =
  | { kind: 'untagged' }
  | { kind: 'tagged'; tag: CampaignRunTag; goal: CampaignGoal | null }
  | { kind: 'refused'; code: 'wrong_client' };

/** The calling run's tag (and the goal frozen on it), read from the stored run. */
async function runTag(scope: BundleScope): Promise<TagRead> {
  if (!scope.runId) return { kind: 'untagged' };
  const run = await hostExtStorage().getRun(scope.runId);
  if (!run || run.tenantId !== scope.tenantId) return { kind: 'untagged' };
  const metadata = (run.metadata ?? {}) as Record<string, unknown>;
  try {
    const tag = readCampaignRunTag(metadata);
    if (!tag) return { kind: 'untagged' };
    const g = metadata.campaignGoal;
    return { kind: 'tagged', tag, goal: g && typeof g === 'object' ? (g as CampaignGoal) : null };
  } catch (err) {
    if (err instanceof CampaignRunWrongClientError) return { kind: 'refused', code: 'wrong_client' };
    throw err;
  }
}

/** A campaign the calling run may see: in a tagged run, only its client's. */
function visibleTo(read: TagRead, campaign: MarketingCampaign | null): MarketingCampaign | null {
  if (!campaign) return null;
  if (read.kind === 'refused') return null;
  if (read.kind === 'tagged' && campaign.orgId !== read.tag.orgId) return null;
  return campaign;
}

/** The tagged run's own campaign, or the typed reason there is none. */
async function taggedCampaign(scope: BundleScope): Promise<{ ok: true; campaign: MarketingCampaign; tag: CampaignRunTag; goal: CampaignGoal | null } | { ok: false; code: string; message: string }> {
  const read = await runTag(scope);
  if (read.kind === 'refused') return { ok: false, code: 'wrong_client', message: 'This run names two different clients.' };
  if (read.kind === 'untagged') return { ok: false, code: 'not_a_campaign_run', message: 'This run does not belong to a campaign.' };
  const campaign = await getCampaign(scope.tenantId, read.tag.campaignId);
  if (!campaign || campaign.orgId !== read.tag.orgId) return { ok: false, code: 'campaign_not_found', message: 'The campaign this run belongs to no longer exists.' };
  // A frozen campaign tag is provenance, never a durable membership grant.
  const subject = scope.actingUserId ?? scope.orgScopeSubject;
  if (subject && !(await runOrgScopeFilter(scope.tenantId, subject, [campaign.orgId], 'workspace:read', {
    cause: !scope.actingUserId && !!scope.orgScopeSubject,
  })).has(campaign.orgId)) {
    return { ok: false, code: 'campaign_not_found', message: 'The campaign this run belongs to no longer exists.' };
  }
  return { ok: true, campaign, tag: read.tag, goal: read.goal };
}

export function buildCampaignStudioSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const enabled = async (featureId: string): Promise<boolean> => Boolean((await resolveOne(featureId, { tenantId }).catch(() => null))?.enabled);
  const subject = scope.actingUserId ?? scope.orgScopeSubject;
  const cause = !scope.actingUserId && !!scope.orgScopeSubject;
  /** May this run use a row in `rowOrgId`? `orgId` given: the floor checked the
   *  person against it, and the row must belong to it. Absent: the person must
   *  hold `needed` in the row's org. No person: unchanged (tenant-trusted). */
  const mayUseOrg = async (rowOrgId: string, argsOrgId: string | undefined, needed: Scope): Promise<boolean> => {
    if (argsOrgId) return rowOrgId === argsOrgId;
    if (!subject) return true;
    return (await runOrgScopeFilter(tenantId, subject, [rowOrgId], needed, { cause })).has(rowOrgId);
  };
  // Takes the `orgId` argument, never `args`, so the pack↔surface parity scan
  // still reads every method's argument keys.
  const scoped = async <T extends { orgId: string }>(row: T | null, argsOrgId: string | undefined, needed: Scope): Promise<T | null> =>
    (row && (await mayUseOrg(row.orgId, argsOrgId, needed)) ? row : null);
  return {
    /**
     * ADR 0942 D5 — the `autonomy-gate` node's decision. Reads the run's frozen
     * stamp server-side; the arguments carry only the action class, the review
     * stage and the risk facts, never a policy. The live tighten-only overlay is
     * skipped on a replay (D4: a replay re-derives nothing from live state).
     */
    autonomyResolve: async (args) => {
      const { actionClass, stage, facts, contentHash } = parseGateArgs(args);
      const run = await ownRun(scope);
      if (!run) return { mode: 'legacy' };
      const effect = currentEffectContext();
      // A gate opened while autonomy was off has already been decided through
      // its original ACL. Re-entry after a toggle flip consumes that recorded
      // decision; it must not invent a new policy before ctx.suspend can return
      // the resolution. Fresh nodes still use the current fail-closed resolver.
      if (run.metadata?.campaignAutonomy === undefined && effect?.runId === run.runId && effect.nodeId) {
        const suspended = await hostExtStorage().findFirstEventByPayload(run.runId, 'node.suspended', 'kind', 'approval', { nodeId: effect.nodeId, newestFirst: true });
        const interruptId = (suspended?.payload as { interruptId?: unknown } | undefined)?.interruptId;
        const prior = typeof interruptId === 'string' ? await hostExtStorage().getInterrupt(interruptId) : null;
        const data = prior?.data as { key?: unknown; autonomy?: unknown } | undefined;
        if (prior?.runId === run.runId && prior.nodeId === effect.nodeId && prior.kind === 'approval'
          && prior.resolvedAt && data?.key === 'autonomy-gate' && data.autonomy === undefined) return { mode: 'legacy' };
      }
      const replaying = effect?.replaying === true;
      let live: { campaignStatus?: 'draft' | 'active' | 'paused' | 'completed' | 'archived' } | undefined;
      if (!replaying) {
        let tag = null;
        try { tag = readCampaignRunTag(run.metadata as Record<string, unknown> | undefined); } catch { tag = null; }
        const campaign = tag ? await getCampaign(tenantId, tag.campaignId) : null;
        if (campaign && tag && campaign.orgId === tag.orgId) live = { campaignStatus: campaign.status };
      }
      const verdict = decideGate({ run, actionClass, ...(stage ? { stage } : {}), facts, ...(contentHash ? { contentHash } : {}), toggleOn: await autonomyToggleOn(tenantId), ...(live ? { live } : {}) });
      // D5 — a class with no wired chokepoint (plan.approve, creative.review, …) is
      // told by the gate itself; a chokepoint class is told after its effect lands.
      if (verdict.mode === 'proceed' && verdict.decision.outcome === 'notify-after' && !replaying && !CHOKEPOINT_CLASSES.has(actionClass)) {
        const runTag = (() => { try { return readCampaignRunTag(run.metadata as Record<string, unknown> | undefined); } catch { return null; } })();
        await emitAutonomyNotice({
          tenantId, notify: verdict.decision.notify, actionClass, runId: run.runId,
          summary: `${actionClass} ran under rule ${verdict.ruleId}.`,
          ...(runTag ? { orgId: runTag.orgId, campaignId: runTag.campaignId } : {}),
        });
      }
      // ADR 0942 P4b — a veto window: open (or find) the record and tell the people
      // who may veto NOW (even under a daily spec: a veto must be seen in time).
      // Get-or-create, so a resume or a replay neither re-opens nor re-notifies.
      if (verdict.mode === 'veto-window') {
        const gateKey = str(args.vetoKey) || actionClass;
        const runTag = (() => { try { return readCampaignRunTag(run.metadata as Record<string, unknown> | undefined); } catch { return null; } })();
        const seconds = Math.max(1, Math.ceil(verdict.windowMs / 1000));
        if (replaying) return { ...verdict, vetoId: vetoIdFor(tenantId, run.runId, gateKey), ...(runTag ? { campaignId: runTag.campaignId } : {}), seconds };
        const { record } = await openVetoWindow({
          tenantId, runId: run.runId, gateKey, actionClass, ruleId: verdict.ruleId, notify: verdict.decision.notify, windowMs: verdict.windowMs,
          ...(runTag ? { orgId: runTag.orgId, campaignId: runTag.campaignId } : {}),
        });
        if (!record.notifiedAt) {
          const recipients = await emitAutonomyNotice({
            tenantId, notify: { ...verdict.decision.notify, digest: 'immediate' }, actionClass, runId: run.runId,
            noticeId: `veto:${record.vetoId}`,
            summary: `${actionClass} will run at ${record.deadline} unless someone vetoes it (rule ${verdict.ruleId}).`,
            ...(runTag ? { orgId: runTag.orgId, campaignId: runTag.campaignId } : {}),
          });
          if (recipients === 0) throw new OpenwopError('conflict', 'No review-window recipients could be notified.', 409, { reason: 'veto_recipients_unavailable' });
          await markVetoNotified(tenantId, record.campaignId, record.vetoId, run.runId);
        }
        return { ...verdict, vetoId: record.vetoId, ...(record.campaignId ? { campaignId: record.campaignId } : {}), seconds, deadline: record.deadline };
      }
      return { ...verdict };
    },
    /** ADR 0942 P4b — the timer fired: close the window (open → elapsed) or read the veto. */
    autonomyVetoOutcome: async (args) => {
      const run = await ownRun(scope);
      // Fail CLOSED: a window this run cannot prove elapsed is treated as vetoed.
      if (!run) return { outcome: 'vetoed', reason: 'veto_record_unreadable' };
      const vetoId = str(args.vetoId);
      const campaignId = optStr(args.campaignId);
      if (currentEffectContext()?.replaying) return { outcome: 'vetoed', reason: 'veto_record_unreadable' };
      const record = await closeVetoWindow(tenantId, campaignId, vetoId, run.runId);
      if (!record || record.runId !== run.runId) return { outcome: 'vetoed', reason: 'veto_record_unreadable' };
      return record.status === 'elapsed'
        ? { outcome: 'elapsed' }
        : { outcome: 'vetoed', reason: record.status === 'open' ? 'veto_window_pending' : record.reason ?? 'vetoed' };
    },
    /** ADR 0942 D7 — deliver yesterday's (and older) queued notify-after notices as one digest per person. The digest chain's node calls it. */
    autonomyDigest: async () => ({ ...(await deliverAutonomyDigest(tenantId)) }),
    /** ADR 0942 — which rule governs an action class on this run, and from which policy (read-only). */
    autonomyExplain: async (args) => {
      const { actionClass, stage } = parseGateArgs({ actionClass: args.actionClass, stage: args.stage });
      const run = await ownRun(scope);
      const ra = run ? runAutonomyOf(run) : null;
      if (!ra?.bound) return { bound: false };
      const policy = ra.policy;
      return {
        bound: true,
        stamped: Boolean(ra.stamp),
        policy: policy ? { policyId: policy.policyId, version: policy.version, name: policy.name, source: ra.stamp?.source ?? 'default' } : null,
        rule: policy ? findRule(policy, actionClass, stage).rule : null,
        floors: ra.floors,
      };
    },
    listCampaigns: async (args) => {
      const argsOrgId = optStr(args.orgId);
      const rows = await listCampaigns(tenantId, argsOrgId);
      if (argsOrgId || !subject) return { campaigns: rows };
      const allowed = await runOrgScopeFilter(tenantId, subject, rows.map((r) => r.orgId), 'workspace:read', { cause });
      return { campaigns: rows.filter((r) => allowed.has(r.orgId)) };
    },
    getCampaign: async (args) => ({ campaign: visibleTo(await runTag(scope), await scoped(await getCampaign(tenantId, str(args.campaignId)), optStr(args.orgId), 'workspace:read')) }),

    /** ADR 0941 P5 — the campaign this run belongs to (from its run tag only),
     *  with the goal FROZEN on the run (never the live goal) and the linked
     *  products' names. */
    campaignContext: async () => {
      const r = await taggedCampaign(scope);
      if (!r.ok) return { found: false, error: { code: r.code, message: r.message } };
      const links = await readCampaignLinks(r.campaign, enabled);
      const c = r.campaign;
      return {
        found: true,
        campaign: {
          id: c.id, orgId: c.orgId, name: c.name, status: c.status, objective: c.objective, channels: c.channels,
          ...(c.briefId ? { briefId: c.briefId } : {}),
          productRefs: c.productRefs ?? [],
          // The linked products' names, through commerce; ok / unavailable / failed.
          products: links.products,
          autonomy: c.autonomy ?? null,
        },
        goal: r.goal,
        goalVersion: r.tag.goalVersion,
        role: r.tag.role ?? null,
      };
    },

    /** ADR 0941 P5 — the tagged campaign's links, each section ok / unavailable / failed. */
    links: async () => {
      const r = await taggedCampaign(scope);
      if (!r.ok) return { found: false, error: { code: r.code, message: r.message } };
      return { found: true, campaignId: r.campaign.id, links: await readCampaignLinks(r.campaign, enabled) };
    },

    /** Finalize a brief into its campaign (upsert by briefId). The node calls this. */
    finalizeFromBrief: async (args) => {
      // A write: the brief must sit in an org the run's person may write.
      const brief = await scoped(await getBrief(tenantId, str(args.briefId)), optStr(args.orgId), 'workspace:write');
      if (!brief) return { found: false };
      // In a tagged run, only the run's own client's brief (as for getCampaign):
      // an actorless tagged run has no person to scope, so the tag is the bar.
      const read = await runTag(scope);
      if (read.kind === 'refused' || (read.kind === 'tagged' && brief.orgId !== read.tag.orgId)) return { found: false };
      if (read.kind === 'tagged') {
        const own = await getCampaign(tenantId, read.tag.campaignId);
        if (!own || own.orgId !== read.tag.orgId || own.briefId !== brief.id) return { found: false };
      }
      // ADR 0356 P1 — link the spine-generated production plan (the newest plan
      // carrying this briefId), composing the production feature lazily.
      let productionPlanId: string | undefined;
      try {
        const { listPlans } = await import('../production/productionService.js');
        const plans = await listPlans(tenantId, brief.orgId);
        const mine = plans.filter((pl) => pl.briefId === brief.id).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        productionPlanId = mine[0]?.planId;
      } catch { /* production off / absent — no link */ }
      try {
        const campaign = await finalizeFromBrief(tenantId, brief, str(args.createdBy) || 'workflow', {
          ...(productionPlanId ? { productionPlanId } : {}),
          ...(read.kind === 'tagged' ? { expectedCampaignId: read.tag.campaignId } : {}),
        });
        return { found: true, campaign };
      } catch (err) {
        if (err instanceof OpenwopError && err.httpStatus === 404) return { found: false };
        throw err;
      }
    },

    /** Attach media assets to a campaign — the durable campaign→asset edge
     *  (CS-DATA-5). Resolves the campaign by campaignId, else by briefId. The
     *  render-concepts node calls this after it generates concept images. */
    attachAssets: async (args) => {
      const read = await runTag(scope);
      if (read.kind === 'refused') return { found: false };
      const campaignId = str(args.campaignId);
      const briefId = str(args.briefId);
      let resolved: MarketingCampaign | null;
      if (read.kind === 'tagged') {
        // An old run never follows its brief into a successor generation.
        const own = await scoped(await getCampaign(tenantId, read.tag.campaignId), optStr(args.orgId), 'workspace:write');
        if (!own || own.orgId !== read.tag.orgId || (!campaignId && !briefId)
          || (campaignId && campaignId !== own.id) || (briefId && briefId !== own.briefId)) return { found: false };
        resolved = own;
      } else {
        resolved = await scoped(campaignId ? await getCampaign(tenantId, campaignId)
          : (briefId ? await getCampaignByBrief(tenantId, briefId) : null), optStr(args.orgId), 'workspace:write');
      }
      if (!resolved) return { found: false };
      const assetIds = (Array.isArray(args.assetIds) ? args.assetIds : []).map(String).filter(Boolean);
      const campaign = await attachCampaignAssets(tenantId, resolved.id, assetIds);
      if (!campaign) return { found: false };
      return { found: true, attached: assetIds.length, campaign };
    },
  };
}
