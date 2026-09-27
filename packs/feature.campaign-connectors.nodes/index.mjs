/**
 * feature.campaign-connectors.nodes — CSV import + live sync (ADR 0159; sync
 * turned honest-ON by the campaign gap plan C2). import-csv composes
 * ctx.features['campaign-connectors'].importCsv; sync composes ctx.ads
 * (listDispatches + getMetrics, window 'yesterday') with the feature surface's
 * recordSyncedMetrics — the persist path that owns the 15-min cooldown + dedup.
 * Platforms without a live metrics reader (tiktok + the CSV-only set) still
 * fail structured with connector_not_configured. role:"action". Pure-JS,
 * Node-20 stdlib only.
 */

function ensureConnectors(ctx) {
  const cc = ctx.features && ctx.features['campaign-connectors'];
  if (!cc || typeof cc.importCsv !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['campaign-connectors'] — the feature must be composed (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.campaign-connectors' },
    );
  }
  return cc;
}

function str(v) { return typeof v === 'string' ? v : ''; }

export async function importCsv(ctx) {
  const cc = ensureConnectors(ctx);
  const i = ctx.inputs ?? {};
  const out = await cc.importCsv({
    orgId: str(i.orgId), csv: str(i.csv),
    ...(i.defaultPlatform ? { defaultPlatform: str(i.defaultPlatform) } : {}),
    ...(i.campaignId ? { campaignId: str(i.campaignId) } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function sync(ctx) {
  const cc = ensureConnectors(ctx);
  const i = ctx.inputs ?? {};
  const platform = str(i.platform);
  const orgId = str(i.orgId);
  if (!orgId) return { status: 'failed', error: { code: 'validation_error', message: 'orgId is required.' } };
  // Live pull exists for the platforms with a metrics reader (meta/google).
  // Everything else stays structured-honest (CSV import is the path).
  if (platform !== 'meta' && platform !== 'google') {
    return {
      status: 'failed',
      error: {
        code: 'connector_not_configured',
        message: `Live ${platform || 'ad-platform'} sync is not available — meta and google have live metrics readers; import a CSV export for the rest (ADR 0159).`,
      },
    };
  }
  if (!ctx.ads || typeof ctx.ads.listDispatches !== 'function' || typeof ctx.ads.getMetrics !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'ctx.ads metrics surface unavailable on this host.' } };
  }
  if (typeof cc.claimSync !== 'function' || typeof cc.recordSyncedMetrics !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-connectors sync surface unavailable — update the feature (C2/SYNC-1).' } };
  }
  // SYNC-1: ATOMICALLY claim the cooldown window before hitting the platform, so
  // two concurrent runs of this chain can't both pass a non-atomic peek and
  // double-submit reads. A lost claim reports cooldown (same shape as the peek).
  const cooldown = await cc.claimSync({ orgId, platform });
  if (cooldown && cooldown.blocked) {
    return { status: 'success', outputs: { outcome: 'cooldown', retryAtIso: cooldown.retryAtIso } };
  }
  const dispatches = (await ctx.ads.listDispatches()).filter(
    (d) => d.platform === platform && typeof d.adAccountId === 'string' && d.adAccountId.length > 0,
  );
  if (dispatches.length === 0) return { status: 'success', outputs: { outcome: 'no_dispatches' } };
  const rows = [];
  const failures = [];
  for (const d of dispatches) {
    const r = await ctx.ads.getMetrics({ platform, adAccountId: d.adAccountId, campaignId: d.platformCampaignId, window: 'yesterday' });
    if (r.outcome !== 'ok') { failures.push({ platformCampaignId: d.platformCampaignId, reason: r.outcome === 'failed' ? r.error : r.outcome }); continue; }
    rows.push({ campaignName: d.campaignName || d.platformCampaignId, adSet: 'dispatched', spend: r.metrics.spend, impressions: r.metrics.impressions, clicks: r.metrics.clicks });
  }
  const persisted = rows.length > 0 ? await cc.recordSyncedMetrics({ orgId, platform, rows }) : { imported: 0, deduped: 0 };
  return { status: 'success', outputs: { outcome: 'synced', platform, campaigns: rows.length, ...persisted, failures } };
}

export async function audienceSync(ctx) {
  const cc = ensureConnectors(ctx);
  const i = ctx.inputs ?? {};
  const segmentId = str(i.segmentId);
  const platform = str(i.platform);
  const adAccountId = str(i.adAccountId);
  if (!segmentId || !adAccountId || (platform !== 'meta' && platform !== 'google')) {
    return { status: 'failed', error: { code: 'validation_error', message: 'segmentId, adAccountId, and platform (meta|google) are required.' } };
  }
  if (!ctx.ads || typeof ctx.ads.syncAudience !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'ctx.ads.syncAudience unavailable on this host.' } };
  }
  if (typeof cc.buildAudienceUpload !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-connectors audience surface unavailable (ADR 0217).' } };
  }
  // Build = segment members → consent check → suppression subtraction → SHA-256.
  // Raw addresses never reach this node; hashes only.
  const upload = await cc.buildAudienceUpload({ segmentId });
  if (!upload || upload.size === 0) {
    return { status: 'failed', error: { code: 'empty_audience', message: 'No eligible members after consent + suppression filtering.' } };
  }
  const r = await ctx.ads.syncAudience({
    platform, adAccountId,
    audienceName: str(i.audienceName) || `Segment ${segmentId}`,
    memberHashes: upload.memberHashes, membersKey: upload.membersKey,
  });
  if (r.outcome === 'requires_approval') {
    return { status: 'failed', error: { code: 'audience_approval_pending', message: `Audience upload requires approval (${r.approvalId}). Approve it in the Approvals inbox, then re-run.` } };
  }
  if (r.outcome !== 'synced') {
    return { status: 'failed', error: { code: 'audience_sync_failed', message: r.outcome === 'failed' ? r.error : r.outcome } };
  }
  return { status: 'success', outputs: { ...r, excluded: upload.excluded, size: upload.size } };
}

export const nodes = {
  'feature.campaign-connectors.nodes.import-csv': importCsv,
  'feature.campaign-connectors.nodes.sync': sync,
  'feature.campaign-connectors.nodes.audience-sync': audienceSync,
};

export default nodes;
