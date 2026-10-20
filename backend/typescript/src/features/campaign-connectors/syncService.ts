/**
 * Live ad-metrics sync (campaign gap plan §5C C2 — turns ADR 0159's honest-off
 * `ads.sync` honest-ON for the platforms with a metrics reader).
 *
 * ONE implementation, two callers: the `POST /campaign-connectors/sync` route
 * (builds the broker-backed ads adapter for the acting user) and the
 * `feature.campaign-connectors.nodes.sync` node (composes `ctx.ads` + the
 * feature surface's `recordSyncedMetrics`, which lands HERE). Both funnel every
 * row through `persistSyncedRows` — the single owner of the 15-minute cooldown
 * (ADR 0159's design) and the dedup'd performance store write.
 *
 * Honesty: rows are DATE-SCOPED, so a sync writes one row per
 * (platform, campaign, date), never lifetime cumulative totals that would
 * double-count in the KPI sums.
 *
 * ADR 0907 D3 (corrects the C2 shape above, which pulled one campaign at a
 * time, always `yesterday`, with conversions and revenue hard-coded 0):
 *  - WHICH CAMPAIGNS: per connector settings, either the dispatched campaigns
 *    (the default, so nothing changes silently) or every campaign of the
 *    configured ad account(s).
 *  - WINDOW: every sync re-pulls a rolling 7-day look-back, because platforms
 *    keep attributing conversions to past days. The natural-key upsert replaces
 *    the earlier rows, so a re-pull converges instead of duplicating.
 *  - COLUMNS: conversions + revenue as the platform reports them.
 *  - BACKFILL: a bounded, resumable one-off (≤ 90 days) through the same plan
 *    and record functions.
 * The node and the route share `planSync` + `recordAccountRows`; only the loop
 * over accounts lives in each caller (the node has no TypeScript import path).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import type { AdsAdapter, DispatchLedgerRow, AdPlatform as DispatchPlatform, AccountMetricsRow } from '../../host/adsAdapter.js';
import { OpenwopError } from '../../types.js';
import { adsReaderEnabled } from '../../host/adsWire.js';
import { computeDerived, type ParsedRow } from './csvImport.js';
import { persistRecords, deleteLegacyDispatchedRows } from './performanceService.js';
import type { AdPlatform } from './types.js';
// Cross-feature READ (the documented campaign-orchestration → campaign-brief
// precedent): link synced rows to the MarketingCampaign finalized from the
// dispatch's brief, so campaign-scoped KPI + C5 attribution see them.
import { getCampaignByBrief } from '../campaign-orchestration/campaignService.js';

const log = createLogger('campaign-connectors.sync');

/** Cooldown between live pulls per (tenant, org, platform) — ADR 0159. */
export const SYNC_COOLDOWN_MS = 15 * 60 * 1000;

interface SyncStateRow {
  key: string;
  tenantId: string;
  orgId: string;
  platform: string;
  lastSyncAt: string;
}
const syncState = new DurableCollection<SyncStateRow>(
  'campaign-connectors:sync-state',
  (r) => r.key,
);
const stateKey = (tenantId: string, orgId: string, platform: string): string => `${tenantId}::${orgId}::${platform}`;

/** R2 CC-SP-13 — `lastSyncAt` was persisted for the cooldown and never exposed:
 *  no surface answered "when did this data last refresh?". */
export async function getSyncStatus(tenantId: string, orgId: string): Promise<Array<{ platform: string; lastSyncAt: string }>> {
  const rows = await syncState.listByPrefix(`${tenantId}::${orgId}::`);
  return rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId)
    .map(({ platform, lastSyncAt }) => ({ platform, lastSyncAt }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

/** Yesterday (UTC) — the date synced rows carry. */
export function yesterdayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The single persist + cooldown chokepoint. `rows` must already be date-scoped. */
export async function persistSyncedRows(
  tenantId: string,
  orgId: string,
  platform: AdPlatform,
  rows: ParsedRow[],
  opts: { campaignIdByName?: Record<string, string>; stampSync?: boolean } = {},
): Promise<{ imported: number; deduped: number }> {
  // Group rows by their linked campaign so persistRecords can stamp the link.
  const byCampaign = new Map<string | undefined, ParsedRow[]>();
  for (const row of rows) {
    const link = opts.campaignIdByName?.[row.campaignName];
    const list = byCampaign.get(link) ?? [];
    list.push(row);
    byCampaign.set(link, list);
  }
  let imported = 0;
  let deduped = 0;
  for (const [campaignId, list] of byCampaign) {
    const r = await persistRecords(tenantId, orgId, list, 'api', campaignId);
    imported += r.imported;
    deduped += r.deduped;
  }
  // A backfill passes stampSync:false — it must not move the daily sync's cooldown.
  if (opts.stampSync !== false) await syncState.put({ key: stateKey(tenantId, orgId, platform), tenantId, orgId, platform, lastSyncAt: new Date().toISOString() });
  return { imported, deduped };
}

/** Atomically CLAIM the cooldown at sync START (grade-code AUDIT-7). Stamping
 *  `lastSyncAt` only at the END (in persistSyncedRows) left a wide check-then-act
 *  window — two concurrent syncs both passed `syncCooldown` and both hit the
 *  platform — AND meant a total-failure/no-rows sync never backed off (it
 *  re-hammered the platform every call). This CAS-stamps the state row up front:
 *  the loser sees the claim and reports cooldown; a failed pull now cools down. */
export async function claimSync(tenantId: string, orgId: string, platform: string): Promise<{ claimed: boolean; retryAtIso?: string }> {
  const key = stateKey(tenantId, orgId, platform);
  const prev = await syncState.get(key).catch(() => undefined);
  const now = Date.now();
  if (prev && prev.tenantId === tenantId) {
    const retryAt = new Date(prev.lastSyncAt).getTime() + SYNC_COOLDOWN_MS;
    if (now < retryAt) return { claimed: false, retryAtIso: new Date(retryAt).toISOString() };
  }
  const next: SyncStateRow = { key, tenantId, orgId, platform, lastSyncAt: new Date(now).toISOString() };
  const won = await syncState.compareAndSwap(prev && prev.tenantId === tenantId ? prev : null, next);
  if (!won) {
    // A concurrent sync claimed first — surface its cooldown honestly.
    const fresh = await syncState.get(key).catch(() => undefined);
    const retryAt = fresh ? new Date(fresh.lastSyncAt).getTime() + SYNC_COOLDOWN_MS : now + SYNC_COOLDOWN_MS;
    return { claimed: false, retryAtIso: new Date(retryAt).toISOString() };
  }
  return { claimed: true };
}

/** Cooldown check — callers surface `retryAtIso` honestly instead of silently
 *  re-pulling. */
export async function syncCooldown(tenantId: string, orgId: string, platform: string): Promise<{ blocked: boolean; retryAtIso?: string }> {
  const row = await syncState.get(stateKey(tenantId, orgId, platform)).catch(() => undefined);
  if (!row || row.tenantId !== tenantId) return { blocked: false };
  const retryAt = new Date(row.lastSyncAt).getTime() + SYNC_COOLDOWN_MS;
  if (Date.now() >= retryAt) return { blocked: false };
  return { blocked: true, retryAtIso: new Date(retryAt).toISOString() };
}

// ── ADR 0907 D3 — connector settings, plan, record ───────────────────────────

/** The platforms with an account-scope metrics reader (ADR 0907 D3/D4). */
export const LIVE_SYNC_PLATFORMS = ['meta', 'google', 'tiktok', 'linkedin'] as const satisfies readonly DispatchPlatform[];
export type LiveSyncPlatform = (typeof LIVE_SYNC_PLATFORMS)[number];
/** Has a reader (settings may be stored). Whether it may READ is `adsReaderEnabled`. */
export const isLiveSyncPlatform = (v: unknown): v is LiveSyncPlatform =>
  typeof v === 'string' && (LIVE_SYNC_PLATFORMS as readonly string[]).includes(v);
/** The readers that are honest-ON right now (TikTok/LinkedIn after a sandbox run — D2). */
export const enabledSyncPlatforms = (): LiveSyncPlatform[] => LIVE_SYNC_PLATFORMS.filter((p) => adsReaderEnabled(p));

/** Days every sync re-pulls (late conversions settle into past days). */
export const SYNC_LOOKBACK_DAYS = 7;
/** The longest backfill a caller can ask for. */
export const BACKFILL_MAX_DAYS = 90;
/** Look-back windows one backfill call works through before returning. */
export const BACKFILL_WINDOWS_PER_CALL = 4;
/** The `adSet` label of a campaign-level synced row. Rows written before ADR
 *  0907 used `'dispatched'`; `recordAccountRows` replaces those on re-pull so
 *  the two labels never both count the same day. */
export const CAMPAIGN_LEVEL_ADSET = '(campaign)';

export type SyncScope = 'dispatched' | 'account';

export interface ConnectorSettings {
  key: string;
  tenantId: string;
  orgId: string;
  platform: LiveSyncPlatform;
  /** `dispatched` (default): only campaigns this app launched. `account`: every
   *  campaign of `adAccountIds` — what an agency with existing campaigns needs. */
  syncScope: SyncScope;
  /** Public ad-account ids (Meta `act_<n>` / Google customer id) for `account` scope. */
  adAccountIds: string[];
  /** Meta: action types counted as conversions (and whose values are revenue). */
  conversionActionTypes?: string[];
  updatedAt: string;
  updatedBy?: string;
}
const connectorSettings = new DurableCollection<ConnectorSettings>(
  'campaign-connectors:connector-settings', (r) => r.key, undefined, (r) => r.tenantId,
);

export async function getConnectorSettings(tenantId: string, orgId: string, platform: LiveSyncPlatform): Promise<ConnectorSettings> {
  const key = stateKey(tenantId, orgId, platform);
  const row = await connectorSettings.get(key).catch(() => undefined);
  if (row && row.tenantId === tenantId && row.orgId === orgId) return row;
  return { key, tenantId, orgId, platform, syncScope: 'dispatched', adAccountIds: [], updatedAt: '' };
}

const AD_ACCOUNT_RE = /^(act_)?[0-9]{1,20}$|^[0-9]{3}-[0-9]{3}-[0-9]{4}$/;
const ACTION_TYPE_RE = /^[a-z0-9_.]{1,100}$/;

export async function saveConnectorSettings(
  tenantId: string, orgId: string, platform: LiveSyncPlatform,
  input: { syncScope?: unknown; adAccountIds?: unknown; conversionActionTypes?: unknown }, actor?: string,
): Promise<ConnectorSettings> {
  const prev = await getConnectorSettings(tenantId, orgId, platform);
  const scope = input.syncScope ?? prev.syncScope;
  if (scope !== 'dispatched' && scope !== 'account') throw new OpenwopError('validation_error', "syncScope must be 'dispatched' or 'account'.", 400, { field: 'syncScope' });
  let adAccountIds = prev.adAccountIds;
  if (input.adAccountIds !== undefined) {
    if (!Array.isArray(input.adAccountIds) || input.adAccountIds.length > 20) throw new OpenwopError('validation_error', 'adAccountIds must be a list of at most 20 ad-account ids.', 400, { field: 'adAccountIds' });
    adAccountIds = [...new Set(input.adAccountIds.map((v) => String(v).trim()).filter(Boolean))];
    const bad = adAccountIds.find((id) => !AD_ACCOUNT_RE.test(id));
    if (bad) throw new OpenwopError('validation_error', `"${bad.slice(0, 40)}" is not an ad-account id (Meta act_<digits>, Google 123-456-7890).`, 400, { field: 'adAccountIds' });
  }
  let conversionActionTypes = prev.conversionActionTypes;
  if (input.conversionActionTypes !== undefined) {
    if (input.conversionActionTypes === null) conversionActionTypes = undefined;
    else {
      if (!Array.isArray(input.conversionActionTypes) || input.conversionActionTypes.length > 20) throw new OpenwopError('validation_error', 'conversionActionTypes must be a list of at most 20 action types.', 400, { field: 'conversionActionTypes' });
      const list = [...new Set(input.conversionActionTypes.map((v) => String(v).trim()).filter(Boolean))];
      const bad = list.find((t) => !ACTION_TYPE_RE.test(t));
      if (bad) throw new OpenwopError('validation_error', `"${bad.slice(0, 40)}" is not an action type (lowercase letters, digits, "_" and ".").`, 400, { field: 'conversionActionTypes' });
      conversionActionTypes = list.length > 0 ? list : undefined;
    }
  }
  if (scope === 'account' && adAccountIds.length === 0) throw new OpenwopError('validation_error', 'Account scope needs at least one ad-account id.', 400, { field: 'adAccountIds' });
  const row: ConnectorSettings = {
    key: stateKey(tenantId, orgId, platform), tenantId, orgId, platform, syncScope: scope, adAccountIds,
    ...(conversionActionTypes ? { conversionActionTypes } : {}),
    updatedAt: new Date().toISOString(), ...(actor ? { updatedBy: actor } : {}),
  };
  await connectorSettings.put(row);
  return row;
}

/** ISO day `n` days before `fromIso` (UTC arithmetic on a calendar date). */
export function isoDaysBefore(fromIso: string, n: number): string {
  const d = new Date(`${fromIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export interface SyncPlan {
  platform: LiveSyncPlatform;
  scope: SyncScope;
  since: string;
  until: string;
  /** Distinct ad accounts to read. */
  adAccountIds: string[];
  conversionActionTypes?: string[];
  /** The dispatch ledger for this platform: names + brief links, and (under
   *  `dispatched` scope) the campaign filter. */
  ledger: Array<{ platformCampaignId: string; campaignName?: string; briefId?: string }>;
}

export type PlanOutcome = { outcome: 'plan'; plan: SyncPlan } | { outcome: 'no_dispatches' } | { outcome: 'no_accounts' } | { outcome: 'not_verified'; platform: LiveSyncPlatform };

/** Decide what one sync reads. Pure over its inputs plus the settings read; no
 *  platform call, no cooldown claim. */
export async function planSync(
  tenantId: string, orgId: string, platform: LiveSyncPlatform, ledgerRows: readonly DispatchLedgerRow[],
  opts: { scope?: SyncScope; since?: string; until?: string } = {},
): Promise<PlanOutcome> {
  // ADR 0907 D2 — a reader not yet sandbox-verified never reads (no claim, no call).
  if (!adsReaderEnabled(platform)) return { outcome: 'not_verified', platform };
  const settings = await getConnectorSettings(tenantId, orgId, platform);
  const scope = opts.scope ?? settings.syncScope;
  const ledger = ledgerRows.filter((d) => d.platform === platform);
  const until = opts.until ?? yesterdayIso();
  const since = opts.since ?? isoDaysBefore(until, SYNC_LOOKBACK_DAYS - 1);
  let adAccountIds: string[];
  if (scope === 'account') {
    adAccountIds = settings.adAccountIds;
    if (adAccountIds.length === 0) return { outcome: 'no_accounts' };
  } else {
    if (ledger.length === 0) return { outcome: 'no_dispatches' };
    adAccountIds = [...new Set(ledger.map((d) => d.adAccountId).filter((a): a is string => typeof a === 'string' && a.length > 0))];
    if (adAccountIds.length === 0) return { outcome: 'no_dispatches' };
  }
  return {
    outcome: 'plan',
    plan: {
      platform, scope, since, until, adAccountIds,
      ...(settings.conversionActionTypes ? { conversionActionTypes: settings.conversionActionTypes } : {}),
      ledger: ledger.map((d) => ({ platformCampaignId: d.platformCampaignId, ...(d.campaignName ? { campaignName: d.campaignName } : {}), ...(d.briefId ? { briefId: d.briefId } : {}) })),
    },
  };
}

/** Map platform rows onto the performance store and persist them. Campaign
 *  level only; under `dispatched` scope, rows of campaigns this app did not
 *  launch are dropped. A dispatched campaign keeps the name it was launched
 *  under, so a platform-side rename does not split its history. */
export async function recordAccountRows(
  tenantId: string, orgId: string, plan: SyncPlan, platformRows: readonly AccountMetricsRow[],
  opts: { stampSync?: boolean } = {},
): Promise<{ imported: number; deduped: number; campaigns: number }> {
  const byId = new Map(plan.ledger.map((d) => [d.platformCampaignId, d]));
  const rows: ParsedRow[] = [];
  const campaigns = new Set<string>();
  const campaignIdByName: Record<string, string> = {};
  for (const r of platformRows) {
    const ledgered = byId.get(r.campaignId);
    if (plan.scope === 'dispatched' && !ledgered) continue;
    const campaignName = ledgered?.campaignName ?? r.campaignName;
    const base = { spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, revenue: r.revenue };
    rows.push({ platform: plan.platform, campaignName, adSet: CAMPAIGN_LEVEL_ADSET, date: r.date, ...base, ...computeDerived(base), ...(r.currency ? { currency: r.currency } : {}) });
    campaigns.add(r.campaignId);
    if (ledgered?.briefId && !campaignIdByName[campaignName]) {
      const campaign = await getCampaignByBrief(tenantId, ledgered.briefId).catch(() => null);
      if (campaign && campaign.orgId === orgId) campaignIdByName[campaignName] = campaign.id;
    }
  }
  if (rows.length === 0) return { imported: 0, deduped: 0, campaigns: 0 };
  await deleteLegacyDispatchedRows(tenantId, orgId, rows);
  const { imported, deduped } = await persistSyncedRows(tenantId, orgId, plan.platform, rows, { campaignIdByName, ...(opts.stampSync === false ? { stampSync: false } : {}) });
  return { imported, deduped, campaigns: campaigns.size };
}

export type SyncOutcome =
  | { outcome: 'cooldown'; retryAtIso: string }
  | { outcome: 'no_dispatches' }
  | { outcome: 'no_accounts' }
  | { outcome: 'not_verified'; platform: LiveSyncPlatform }
  | {
      outcome: 'synced';
      platform: LiveSyncPlatform;
      scope: SyncScope;
      /** The newest day pulled (kept for older callers that read `date`). */
      date: string;
      since: string;
      until: string;
      campaigns: number;
      imported: number;
      deduped: number;
      /** Per-account failures. Best-effort per account, never all-or-nothing. */
      failures: Array<{ adAccountId: string; reason: string; retryAfterS?: number }>;
      /** TRUE when an account hit the page cap; the rows that were read landed. */
      truncated: boolean;
    };

/** Read every planned account through the adapter and record the rows. */
async function readAndRecord(adapter: AdsAdapter, tenantId: string, orgId: string, plan: SyncPlan, opts: { stampSync?: boolean } = {}): Promise<Extract<SyncOutcome, { outcome: 'synced' }>> {
  const all: AccountMetricsRow[] = [];
  const failures: Array<{ adAccountId: string; reason: string; retryAfterS?: number }> = [];
  let truncated = false;
  for (const adAccountId of plan.adAccountIds) {
    const r = await adapter.getAccountMetrics({
      platform: plan.platform, adAccountId, level: 'campaign', since: plan.since, until: plan.until,
      ...(plan.conversionActionTypes ? { conversionActionTypes: plan.conversionActionTypes } : {}),
    });
    if (r.outcome !== 'ok') {
      failures.push({ adAccountId, reason: r.outcome === 'failed' ? r.error : r.outcome, ...(r.outcome === 'rate_limited' && r.retryAfterS !== undefined ? { retryAfterS: r.retryAfterS } : {}) });
      continue;
    }
    if (r.truncated) truncated = true;
    all.push(...r.rows);
  }
  const { imported, deduped, campaigns } = await recordAccountRows(tenantId, orgId, plan, all, opts);
  return { outcome: 'synced', platform: plan.platform, scope: plan.scope, date: plan.until, since: plan.since, until: plan.until, campaigns, imported, deduped, failures, truncated };
}

/**
 * Pull the 7-day look-back for the platform per the org's connector settings
 * and land it in the performance store. Respects the cooldown; links rows to
 * the MarketingCampaign finalized from each dispatch's brief.
 */
export async function runMetricsSync(
  adapter: AdsAdapter,
  tenantId: string,
  orgId: string,
  platform: LiveSyncPlatform,
  opts: { scope?: SyncScope } = {},
): Promise<SyncOutcome> {
  // R2 CC-SP-14 — planning runs BEFORE the cooldown claim: it is a local read
  // (no platform call), and a no_dispatches / no_accounts probe must not
  // consume the 15-minute window.
  const planned = await planSync(tenantId, orgId, platform, await adapter.listDispatches(), opts);
  if (planned.outcome !== 'plan') return planned;
  // Claim the cooldown up front (grade-code AUDIT-7) — atomic, so concurrent
  // syncs don't both hit the platform and a failed pull still backs off.
  const claim = await claimSync(tenantId, orgId, platform);
  if (!claim.claimed) return { outcome: 'cooldown', retryAtIso: claim.retryAtIso ?? new Date().toISOString() };
  const out = await readAndRecord(adapter, tenantId, orgId, planned.plan);
  log.info('campaign_sync_completed', { tenantId, orgId, platform, scope: out.scope, since: out.since, until: out.until, campaigns: out.campaigns, imported: out.imported, deduped: out.deduped, failures: out.failures.length, truncated: out.truncated });
  return out;
}

// ── ADR 0907 D3 — bounded, resumable backfill ────────────────────────────────

interface BackfillState {
  key: string;
  tenantId: string;
  orgId: string;
  platform: LiveSyncPlatform;
  /** Oldest day the backfill reaches. */
  targetSince: string;
  /** The next window ends here and walks backwards. */
  nextUntil: string;
  status: 'running' | 'done';
  /** A call holds this lease while it reads, so two calls never read the same window. */
  leaseUntil?: string;
  windowsDone: number;
  imported: number;
  startedAt: string;
  updatedAt: string;
}
const backfills = new DurableCollection<BackfillState>(
  'campaign-connectors:backfill', (r) => r.key, undefined, (r) => r.tenantId,
);
const BACKFILL_LEASE_MS = 10 * 60 * 1000;

export type BackfillOutcome =
  | { outcome: 'no_dispatches' }
  | { outcome: 'no_accounts' }
  | { outcome: 'not_verified'; platform: LiveSyncPlatform }
  | { outcome: 'busy'; retryAtIso: string }
  | {
      outcome: 'progress' | 'done' | 'rate_limited';
      targetSince: string;
      /** Days still to read (0 when done). */
      remainingDays: number;
      windowsDone: number;
      imported: number;
      failures: Array<{ adAccountId: string; reason: string; retryAfterS?: number }>;
      truncated: boolean;
    };

const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/**
 * One step of a backfill of the last `days` days (≤ 90). Each call reads up to
 * BACKFILL_WINDOWS_PER_CALL seven-day windows, newest first, and saves where it
 * stopped; call again to continue. An unfinished backfill is resumed rather
 * than restarted. Does not touch the daily sync's cooldown.
 */
export async function runMetricsBackfill(
  adapter: AdsAdapter, tenantId: string, orgId: string, platform: LiveSyncPlatform, opts: { days: number },
): Promise<BackfillOutcome> {
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > BACKFILL_MAX_DAYS) {
    throw new OpenwopError('validation_error', `days must be a whole number from 1 to ${BACKFILL_MAX_DAYS}.`, 400, { field: 'days' });
  }
  const ledger = await adapter.listDispatches();
  const probe = await planSync(tenantId, orgId, platform, ledger);
  if (probe.outcome !== 'plan') return probe;

  const key = stateKey(tenantId, orgId, platform);
  const now = Date.now();
  const prev = await backfills.get(key).catch(() => undefined);
  const owned = prev && prev.tenantId === tenantId ? prev : undefined;
  if (owned?.leaseUntil && Date.parse(owned.leaseUntil) > now) return { outcome: 'busy', retryAtIso: owned.leaseUntil };
  const latest = yesterdayIso();
  const resume = owned && owned.status === 'running';
  const base: BackfillState = resume ? owned : {
    key, tenantId, orgId, platform,
    targetSince: isoDaysBefore(latest, opts.days - 1), nextUntil: latest,
    status: 'running', windowsDone: 0, imported: 0,
    startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  };
  const leased: BackfillState = { ...base, leaseUntil: new Date(now + BACKFILL_LEASE_MS).toISOString(), updatedAt: new Date(now).toISOString() };
  if (!(await backfills.compareAndSwap(owned ?? null, leased))) {
    const fresh = await backfills.get(key).catch(() => undefined);
    return { outcome: 'busy', retryAtIso: fresh?.leaseUntil ?? new Date(now + BACKFILL_LEASE_MS).toISOString() };
  }

  let state = leased;
  const failures: Array<{ adAccountId: string; reason: string; retryAfterS?: number }> = [];
  let truncated = false;
  let rateLimited = false;
  for (let w = 0; w < BACKFILL_WINDOWS_PER_CALL && state.nextUntil >= state.targetSince; w++) {
    const windowSince = [isoDaysBefore(state.nextUntil, SYNC_LOOKBACK_DAYS - 1), state.targetSince].sort().at(-1)!;
    const planned = await planSync(tenantId, orgId, platform, ledger, { since: windowSince, until: state.nextUntil });
    if (planned.outcome !== 'plan') break;
    const out = await readAndRecord(adapter, tenantId, orgId, planned.plan, { stampSync: false });
    failures.push(...out.failures);
    if (out.truncated) truncated = true;
    // A throttled window is not advanced past: the next call re-reads it.
    if (out.failures.some((f) => f.reason === 'rate_limited')) { rateLimited = true; break; }
    state = { ...state, nextUntil: isoDaysBefore(windowSince, 1), windowsDone: state.windowsDone + 1, imported: state.imported + out.imported };
  }
  const finished = state.nextUntil < state.targetSince;
  const { leaseUntil: _lease, ...rest } = state;
  const saved: BackfillState = { ...rest, status: finished ? 'done' : 'running', updatedAt: new Date().toISOString() };
  await backfills.put(saved);
  return {
    outcome: rateLimited ? 'rate_limited' : finished ? 'done' : 'progress',
    targetSince: saved.targetSince,
    remainingDays: finished ? 0 : daysBetween(saved.targetSince, saved.nextUntil) + 1,
    windowsDone: saved.windowsDone, imported: saved.imported, failures, truncated,
  };
}
