/**
 * feature.campaign-connectors.nodes — CSV import + live sync (ADR 0159; sync
 * turned honest-ON by the campaign gap plan C2). import-csv composes
 * ctx.features['campaign-connectors'].importCsv. sync (1.1.0, ADR 0907 D3)
 * asks the feature surface for a plan (which ad accounts, the 7-day look-back
 * window, dispatched-only or whole-account), reads each account through
 * ctx.ads.getAccountMetrics, and hands the rows back to the surface's
 * recordAccountRows — the host owns planning, mapping, dedup and the cooldown.
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
  // Live pull exists for the platforms with an account metrics reader
  // (meta/google; tiktok/linkedin once sandbox-verified — the host decides).
  // Everything else stays structured-honest (CSV import is the path).
  const notConfigured = (why) => ({
    status: 'failed',
    error: { code: 'connector_not_configured', message: `Live ${platform || 'ad-platform'} sync is not available — ${why}; import a CSV export instead (ADR 0159).` },
  });
  if (!['meta', 'google', 'tiktok', 'linkedin'].includes(platform)) return notConfigured('this platform has no metrics reader');
  if (!ctx.ads || typeof ctx.ads.getAccountMetrics !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'ctx.ads.getAccountMetrics unavailable on this host (ADR 0907 D3).' } };
  }
  if (typeof cc.claimSync !== 'function' || typeof cc.planSync !== 'function' || typeof cc.recordAccountRows !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-connectors sync surface unavailable — update the feature (ADR 0907 D3).' } };
  }
  const syncScope = i.syncScope === 'account' || i.syncScope === 'dispatched' ? i.syncScope : undefined;
  // Plan BEFORE claiming the cooldown: a no_dispatches / no_accounts probe is a
  // local read and must not consume the 15-minute window (R2 CC-SP-14).
  const planned = await cc.planSync({ orgId, platform, syncScope }); // undefined = the org's setting
  if (planned.outcome === 'no_dispatches' || planned.outcome === 'no_accounts') {
    return { status: 'success', outputs: { outcome: planned.outcome } };
  }
  if (planned.outcome === 'not_verified') return notConfigured('its reader has not been verified against the platform\'s test account yet (ADR 0907 D2)');
  if (planned.outcome !== 'plan') {
    return { status: 'failed', error: { code: 'validation_error', message: planned.error || 'sync plan unavailable' } };
  }
  // SYNC-1: ATOMICALLY claim the cooldown window before hitting the platform.
  const cooldown = await cc.claimSync({ orgId, platform });
  if (cooldown && cooldown.blocked) {
    return { status: 'success', outputs: { outcome: 'cooldown', retryAtIso: cooldown.retryAtIso } };
  }
  const plan = planned.plan;
  const rows = [];
  const failures = [];
  let truncated = false;
  for (const adAccountId of plan.adAccountIds) {
    const r = await ctx.ads.getAccountMetrics({
      platform, adAccountId, level: 'campaign', since: plan.since, until: plan.until,
      ...(plan.conversionActionTypes ? { conversionActionTypes: plan.conversionActionTypes } : {}),
    });
    if (r.outcome !== 'ok') {
      failures.push({ adAccountId, reason: r.outcome === 'failed' ? r.error : r.outcome, ...(r.outcome === 'rate_limited' && r.retryAfterS !== undefined ? { retryAfterS: r.retryAfterS } : {}) });
      continue;
    }
    if (r.truncated) truncated = true;
    rows.push(...r.rows);
  }
  const persisted = await cc.recordAccountRows({ orgId, plan, rows });
  return {
    status: 'success',
    outputs: {
      outcome: 'synced', platform, scope: plan.scope, since: plan.since, until: plan.until,
      campaigns: persisted.campaigns ?? 0, imported: persisted.imported ?? 0, deduped: persisted.deduped ?? 0,
      failures, truncated,
    },
  };
}

/**
 * ADR 0907 D7 — deliver the org's queued server-side conversions (Meta CAPI,
 * plus TikTok Events / Google Ads once verified). The host does the work
 * (`deliverConversions`: run-owner identity, workspace:write, consent re-checked
 * per row at send, per-row platform targets, resumable). role:"side-effect" +
 * `side-effectful`: a REPLAY fork serves this node's recorded outcome and sends
 * nothing; a BRANCH fork re-runs it, which sends only rows still queued.
 */
export async function dispatchConversions(ctx) {
  const cc = ensureConnectors(ctx);
  const orgId = str((ctx.inputs ?? {}).orgId);
  if (!orgId) return { status: 'failed', error: { code: 'validation_error', message: 'orgId is required.' } };
  if (typeof cc.deliverConversions !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-connectors deliverConversions unavailable — update the feature (ADR 0907 D7).' } };
  }
  const out = await cc.deliverConversions({ orgId });
  // Scheduled delivery is OFF until the workspace opts in (the
  // `campaign-connectors.scheduled-conversions` toggle): an honest no-op.
  if (out.outcome === 'disabled') return { status: 'success', outputs: { outcome: 'disabled', sent: 0, dropped: 0, held: 0, expired: 0 } };
  if (out.outcome === 'no_acting_user') {
    return { status: 'failed', error: { code: 'no_acting_user', message: 'Conversion delivery runs as a person (their ad connections and workspace access); this run has no acting user.' } };
  }
  if (out.outcome !== 'delivered') return { status: 'failed', error: { code: 'validation_error', message: out.error || 'delivery refused' } };
  return { status: 'success', outputs: { outcome: 'delivered', sent: out.sent, dropped: out.dropped, held: out.held, expired: out.expired } };
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
  'feature.campaign-connectors.nodes.dispatch-conversions': dispatchConversions,
};

export default nodes;
