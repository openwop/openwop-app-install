/**
 * Hard spend caps with auto-pause (ADR 0952 D2, phase P1) — the host watchdog.
 *
 * A cap bounds what a campaign, or a whole client org, may spend in a period.
 * Synced spend lags real spend, so the platform-native ceiling (P2) is the first
 * layer; this module is the second, cross-platform one:
 *
 *  - Spend is READ through the ONE ads adapter (`getAccountMetrics`, ADR 0907
 *    D3). Platform campaigns join to a MarketingCampaign ONLY by id: the
 *    campaign's `briefId` → the dispatch ledger's `briefId` (finding P4 — a name
 *    match is never counted). A client cap sums every campaign in the org's ad
 *    accounts, dispatched by us or not.
 *  - A failed, rate-limited, truncated or mixed-currency read is an ERROR, never
 *    zero spend (the 0907 honesty rule). With no good read for `maxStaleMinutes`
 *    the cap goes `stale` and enforces exactly as if breached.
 *  - Enforcement is a CAS on `CapState` (the `pacing.ts` claim pattern): only the
 *    tick that moves the state INTO breached/stale pauses and notifies, so two
 *    concurrent ticks pause once. A later tick that finds it already enforcing
 *    re-pauses every current target (the adapter's pause reads first, so a
 *    target that is still paused costs one read and no write). A pause that
 *    fails stays recorded and is retried by the next tick.
 *  - While a cap is breached or stale, a launch of a covered campaign is refused
 *    (`checkLaunchAgainstCaps`, registered as the adapter's cap checker).
 *
 * @see docs/adr/0952-paid-media-operations-and-spend-control.md
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { onCampaignDeleted } from '../../host/campaignLifecycle.js';
import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { currencyExponent, minorToMajor } from '../../host/currencyUnits.js';
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { adsReaderEnabled } from '../../host/adsWire.js';
import { listTenantDispatchRecords, type AdPlatform, type AdsAdapter, type AdsCapVerdict, type DispatchLedgerRow } from '../../host/adsAdapter.js';
// Cross-feature READS (the documented pacing.ts precedent).
import { getCampaign, listCampaigns } from '../campaign-orchestration/campaignService.js';
import { getConnectorSettings } from '../campaign-connectors/syncService.js';
import { alertActions } from './alertActions.js';

const log = createLogger('campaign-intel.spend-caps');

export const CAPS_TOGGLE_ID = 'campaign-intel';
/** ADR 0952 Q2 — proposed default, pending David's call (see the ADR's open questions). */
export const DEFAULT_MAX_STALE_MINUTES = 180;
const NEAR_PCT = 80;
/** The platforms whose spend this watchdog can read and whose delivery it can pause. */
const CAP_PLATFORMS: readonly AdPlatform[] = ['meta', 'google', 'tiktok', 'linkedin'];

export type CapScope = { kind: 'campaign'; campaignId: string } | { kind: 'client' };
export type CapPeriod = 'lifetime' | 'calendar-month';
export type CapStatus = 'ok' | 'near' | 'breached' | 'stale';

export interface SpendCap {
  key: string;
  capId: string;
  tenantId: string;
  /** The client org (ADR 0921) the cap belongs to. */
  orgId: string;
  scope: CapScope;
  limitMinor: number;
  currency: string;
  period: CapPeriod;
  onBreach: 'pause';
  maxStaleMinutes: number;
  version: number;
  /** The principal who created it (tombstoned by `eraseSpendCapSubject`). */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapTarget { platform: AdPlatform; adAccountId: string; campaignId: string; orgId?: string }

export interface CapState {
  key: string;
  tenantId: string;
  capId: string;
  periodKey: string;
  /** Last good read, minor units of the cap's currency; `null` before any good read. */
  spentMinor: number | null;
  /** When `spentMinor` was read; `null` before any good read. */
  readAt: string | null;
  /** Exact account/target population represented by the last good read. */
  coverageHash?: string;
  readError?: string;
  status: CapStatus;
  pausedTargets: Array<CapTarget & { at: string }>;
  /** Targets whose pause failed on the last attempt (retried next tick). */
  pauseErrors?: Array<CapTarget & { error: string }>;
  version: number;
}

const caps = new DurableCollection<SpendCap>('campaign-intel:spend-cap', (c) => `${c.tenantId}::${c.orgId}::${c.capId}`);
const states = new DurableCollection<CapState>('campaign-intel:cap-state', (s) => `${s.tenantId}::${s.capId}::${s.periodKey}`);

const capKey = (tenantId: string, orgId: string, capId: string): string => `${tenantId}::${orgId}::${capId}`;
const stateKey = (tenantId: string, capId: string, periodKey: string): string => `${tenantId}::${capId}::${periodKey}`;

/** Ad-account ids compare without the Meta `act_` prefix and Google's dashes. */
const normAccount = (a: string): string => a.replace(/^act_/, '').replace(/-/g, '');
const sameTarget = (a: CapTarget, b: CapTarget): boolean =>
  a.platform === b.platform && a.campaignId === b.campaignId && normAccount(a.adAccountId) === normAccount(b.adAccountId);
const enforcing = (s: CapStatus | undefined): boolean => s === 'breached' || s === 'stale';

// A campaign-scoped cap goes with its campaign (the pacing-memo precedent).
onCampaignDeleted('spend-caps-by-campaign', async ({ tenantId, campaignId }) => {
  for (const cap of await caps.listByPrefix(`${tenantId}::`)) {
    if (cap.tenantId === tenantId && cap.scope.kind === 'campaign' && cap.scope.campaignId === campaignId) await deleteCapRows(cap);
  }
});

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listCaps(tenantId: string, orgId: string): Promise<SpendCap[]> {
  return (await caps.listByPrefix(`${tenantId}::${orgId}::`))
    .filter((c) => c.tenantId === tenantId && c.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getCap(tenantId: string, orgId: string, capId: string): Promise<SpendCap | null> {
  const c = await caps.get(capKey(tenantId, orgId, capId)).catch(() => undefined);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

export interface CreateCapInput { scope?: unknown; limitMinor?: unknown; currency?: unknown; period?: unknown; maxStaleMinutes?: unknown }

const bad = (field: string, msg: string): OpenwopError => new OpenwopError('validation_error', msg, 400, { field });

function parseLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad('limitMinor', '`limitMinor` MUST be a positive integer (ISO minor units).');
  return n;
}

export async function createCap(tenantId: string, orgId: string, input: CreateCapInput, actor: string, now = new Date()): Promise<SpendCap> {
  const scopeIn = (input.scope ?? {}) as { kind?: unknown; campaignId?: unknown };
  let scope: CapScope;
  if (scopeIn.kind === 'client') scope = { kind: 'client' };
  else if (scopeIn.kind === 'campaign' && typeof scopeIn.campaignId === 'string' && scopeIn.campaignId.length > 0) {
    const campaign = await getCampaign(tenantId, scopeIn.campaignId);
    // Same 404 for "absent" and "another org's" — no existence leak across orgs.
    if (!campaign || campaign.orgId !== orgId) throw new OpenwopError('not_found', 'Campaign not found in this org.', 404, { field: 'scope.campaignId' });
    scope = { kind: 'campaign', campaignId: campaign.id };
  } else throw bad('scope', "`scope` MUST be { kind: 'client' } or { kind: 'campaign', campaignId }.");
  const currency = typeof input.currency === 'string' ? input.currency.toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('currency', '`currency` MUST be an ISO-4217 code.');
  const period = input.period ?? 'calendar-month';
  if (period !== 'lifetime' && period !== 'calendar-month') throw bad('period', "`period` MUST be 'lifetime' or 'calendar-month'.");
  const stale = input.maxStaleMinutes === undefined ? DEFAULT_MAX_STALE_MINUTES : Number(input.maxStaleMinutes);
  if (!Number.isInteger(stale) || stale < 15 || stale > 10_080) throw bad('maxStaleMinutes', '`maxStaleMinutes` MUST be an integer from 15 to 10080.');
  const at = now.toISOString();
  const capId = randomUUID();
  const cap: SpendCap = {
    key: capKey(tenantId, orgId, capId), capId, tenantId, orgId, scope, limitMinor: parseLimit(input.limitMinor), currency, period,
    onBreach: 'pause', maxStaleMinutes: stale, version: 1, createdBy: actor, createdAt: at, updatedAt: at,
  };
  if (!(await caps.compareAndSwap(null, cap))) throw new OpenwopError('conflict', 'Cap id collision; retry.', 409);
  return cap;
}

/** Change a cap's limit. A RAISE re-arms a breached state for the current
 *  period (recomputed from the last good read); it never resumes delivery —
 *  paused campaigns relaunch through the governed launch. The caller decides
 *  who may raise (routes: lowering = workspace:write, raising = org admin). */
export async function setCapLimit(cap: SpendCap, limitIn: unknown, expectedVersion: unknown, now = new Date()): Promise<SpendCap> {
  if (expectedVersion !== cap.version) throw new OpenwopError('conflict', 'The cap changed since you read it.', 409, { version: cap.version });
  const limitMinor = parseLimit(limitIn);
  const next: SpendCap = { ...cap, limitMinor, version: cap.version + 1, updatedAt: now.toISOString() };
  if (!(await caps.compareAndSwap(cap, next))) throw new OpenwopError('conflict', 'The cap changed since you read it.', 409);
  if (limitMinor > cap.limitMinor) {
    const key = stateKey(cap.tenantId, cap.capId, periodOf(next, now).periodKey);
    const prior = await states.get(key).catch(() => undefined);
    if (prior && prior.tenantId === cap.tenantId && prior.status === 'breached' && prior.spentMinor !== null) {
      await states.compareAndSwap(prior, { ...prior, status: bandOf(prior.spentMinor, limitMinor), version: prior.version + 1 }).catch(() => false);
    }
  }
  return next;
}

async function deleteCapRows(cap: SpendCap): Promise<void> {
  for (const s of await states.listByPrefix(`${cap.tenantId}::${cap.capId}::`)) await states.delete(s.key);
  await caps.delete(cap.key);
}

export async function deleteCap(cap: SpendCap): Promise<void> { await deleteCapRows(cap); }

export async function getCapState(cap: SpendCap, now = new Date()): Promise<CapState | null> {
  const s = await states.get(stateKey(cap.tenantId, cap.capId, periodOf(cap, now).periodKey)).catch(() => undefined);
  return s && s.tenantId === cap.tenantId ? s : null;
}

// ── Period, targets, spend ───────────────────────────────────────────────────

/** UTC calendar month. Ad accounts report in their own timezone, so a month
 *  boundary can be off by up to a day; the cap errs toward the earlier period. */
function periodOf(cap: SpendCap, now: Date): { periodKey: string; start: Date } {
  if (cap.period === 'lifetime') return { periodKey: 'lifetime', start: new Date(cap.createdAt) };
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { periodKey: start.toISOString().slice(0, 7), start };
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const bandOf = (spent: number, limit: number): CapStatus => (spent >= limit ? 'breached' : spent * 100 >= limit * NEAR_PCT ? 'near' : 'ok');

interface ResolvedTargets {
  /** Campaigns we know of (dispatch ledger), the pause set's floor. */
  ledger: CapTarget[];
  /** The ad accounts to read, per platform. */
  accounts: Array<{ platform: AdPlatform; adAccountId: string }>;
  /** Earliest dispatch day (lifetime campaign caps read from here). */
  earliest?: string;
  error?: string;
}

function coverageHash(t: ResolvedTargets): string {
  return createHash('sha256').update(JSON.stringify({
    accounts: t.accounts.map((a) => `${a.platform}:${normAccount(a.adAccountId)}`).sort(),
    targets: t.ledger.map((a) => `${a.platform}:${normAccount(a.adAccountId)}:${a.campaignId}`).sort(),
  })).digest('hex');
}

const asTarget = (r: DispatchLedgerRow): CapTarget | null =>
  r.adAccountId ? { platform: r.platform, adAccountId: r.adAccountId, campaignId: r.platformCampaignId } : null;

async function resolveTargets(cap: SpendCap, ledgerRows: readonly DispatchLedgerRow[]): Promise<ResolvedTargets> {
  if (cap.scope.kind === 'campaign') {
    const campaign = await getCampaign(cap.tenantId, cap.scope.campaignId);
    if (!campaign || campaign.orgId !== cap.orgId) return { ledger: [], accounts: [], error: 'campaign_not_found' };
    // ADR 0941 P2 makes the stored run's campaign/org authoritative. Its
    // optional caller brief can disagree, so explicit ownership never falls
    // through to the legacy brief join (including a different org's row).
    const rows = ledgerRows.filter((r) => r.campaignId !== undefined
      ? r.campaignId === campaign.id && r.orgId === cap.orgId
      : r.briefId === campaign.briefId && (r.orgId === undefined || r.orgId === cap.orgId));
    const ledger = rows.map(asTarget).filter((t): t is CapTarget => t !== null);
    const accounts = uniqueAccounts(ledger);
    const earliest = rows.map((r) => r.createdAt).sort()[0];
    // A tombstoned ledger row lost its account id: that campaign cannot be read,
    // so the cap cannot say what it spent (never "zero").
    const error = rows.length > ledger.length ? 'target_account_unknown' : undefined;
    return { ledger, accounts, ...(earliest ? { earliest } : {}), ...(error ? { error } : {}) };
  }
  const briefIds = new Set((await listCampaigns(cap.tenantId, cap.orgId)).map((c) => c.briefId));
  // A retired MarketingCampaign can still own active platform delivery. Keep
  // its stamped client account covered; current briefs are only a legacy join.
  const rows = ledgerRows.filter((r) => r.campaignId !== undefined
    ? r.orgId === cap.orgId
    : r.briefId !== undefined && briefIds.has(r.briefId) && (r.orgId === undefined || r.orgId === cap.orgId));
  const ledger = rows.map(asTarget).filter((t): t is CapTarget => t !== null);
  const configured: Array<{ platform: AdPlatform; adAccountId: string }> = [];
  for (const platform of CAP_PLATFORMS) {
    const settings = await getConnectorSettings(cap.tenantId, cap.orgId, platform, { throwOnReadError: true });
    for (const adAccountId of settings.adAccountIds) configured.push({ platform, adAccountId });
  }
  return { ledger, accounts: uniqueAccounts([...ledger, ...configured]), ...(rows.length > ledger.length ? { error: 'target_account_unknown' } : {}) };
}

function uniqueAccounts(xs: ReadonlyArray<{ platform: AdPlatform; adAccountId: string }>): Array<{ platform: AdPlatform; adAccountId: string }> {
  const seen = new Map<string, { platform: AdPlatform; adAccountId: string }>();
  for (const x of xs) seen.set(`${x.platform}:${normAccount(x.adAccountId)}`, { platform: x.platform, adAccountId: x.adAccountId });
  return [...seen.values()];
}

type SpendRead = { ok: true; spentMinor: number; spenders: CapTarget[] } | { ok: false; error: string };

async function readSpend(adapter: AdsAdapter, cap: SpendCap, t: ResolvedTargets, since: string, until: string): Promise<SpendRead> {
  if (t.error) return { ok: false, error: t.error };
  if (t.accounts.length === 0) {
    // Nothing to read: a campaign cap with no dispatched platform campaign has
    // spent nothing yet; a client cap with no account is unreadable (not zero).
    return cap.scope.kind === 'campaign' ? { ok: true, spentMinor: 0, spenders: [] } : { ok: false, error: 'no_accounts' };
  }
  const scale = 10 ** currencyExponent(cap.currency);
  let spentMinor = 0;
  const spenders: CapTarget[] = [];
  for (const { platform, adAccountId } of t.accounts) {
    if (!adsReaderEnabled(platform)) return { ok: false, error: `reader_not_verified:${platform}` };
    const r = await adapter.getAccountMetrics({ platform, adAccountId, level: 'campaign', since, until });
    if (r.outcome === 'rate_limited') return { ok: false, error: `rate_limited:${platform}` };
    if (r.outcome === 'failed') return { ok: false, error: `${platform}:${r.error}` };
    if (r.outcome !== 'ok') return { ok: false, error: `${platform}:${r.outcome}` };
    if (r.truncated) return { ok: false, error: `truncated:${platform}` };
    const wanted = cap.scope.kind === 'campaign'
      ? new Set(t.ledger.filter((x) => x.platform === platform && normAccount(x.adAccountId) === normAccount(adAccountId)).map((x) => x.campaignId))
      : null;
    for (const row of r.rows) {
      if (wanted && !wanted.has(row.campaignId)) continue;
      if (!Number.isFinite(row.spend) || row.spend < 0) return { ok: false, error: 'invalid_spend' };
      if (row.spend > 0 && row.currency !== cap.currency) return { ok: false, error: row.currency ? `currency_mismatch:${row.currency}` : 'currency_unknown' };
      const minor = Math.round(row.spend * scale);
      if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(spentMinor + minor)) return { ok: false, error: 'invalid_spend' };
      spentMinor += minor;
      if (row.spend > 0) {
        const tg: CapTarget = { platform, adAccountId, campaignId: row.campaignId };
        if (!spenders.some((s) => sameTarget(s, tg))) spenders.push(tg);
      }
    }
  }
  return { ok: true, spentMinor, spenders };
}

// ── Enforcement ──────────────────────────────────────────────────────────────

export interface CapEnforcement {
  capId: string;
  /** `error`: this tick could not evaluate the cap at all (logged; the next tick retries). */
  status: CapStatus | 'error';
  spentMinor: number | null;
  readError?: string;
  /** This tick moved the cap INTO breached/stale (it paused and notified). */
  transitioned: boolean;
  /** Another tick claimed this state change first; this one did nothing. */
  raced?: boolean;
  paused: number;
  pauseErrors: number;
}

export async function enforceCaps(adapter: AdsAdapter, tenantId: string, orgId: string, now = new Date()): Promise<CapEnforcement[]> {
  const out: CapEnforcement[] = [];
  const capsHere = await listCaps(tenantId, orgId);
  // One ledger scan per tick, shared by every cap.
  const ledgerRows = capsHere.length > 0 ? await listTenantDispatchRecords(tenantId) : [];
  for (const cap of capsHere) {
    try {
      out.push(await enforceOne(adapter, cap, ledgerRows, now));
    } catch (e) {
      log.warn('spend cap enforcement failed', { capId: cap.capId, error: e instanceof Error ? e.message : String(e) });
      out.push({ capId: cap.capId, status: 'error', spentMinor: null, readError: 'enforcement_error', transitioned: false, paused: 0, pauseErrors: 0 });
    }
  }
  return out;
}

async function enforceOne(adapter: AdsAdapter, cap: SpendCap, ledgerRows: readonly DispatchLedgerRow[], now: Date): Promise<CapEnforcement> {
  const targets = await resolveTargets(cap, ledgerRows);
  const { periodKey, start } = periodOf(cap, now);
  const since = cap.period === 'lifetime' && cap.scope.kind === 'campaign' && targets.earliest
    ? isoDay(new Date(new Date(targets.earliest).getTime() - 86_400_000)) // a day of slack for the account timezone
    : isoDay(start);
  const read = await readSpend(adapter, cap, targets, since, isoDay(now));
  const current = await caps.get(cap.key);
  if (!current || current.tenantId !== cap.tenantId || current.orgId !== cap.orgId || current.capId !== cap.capId) {
    throw new OpenwopError('conflict', 'Spend cap changed or was removed during evaluation; retry.', 409);
  }
  cap = current;

  const key = stateKey(cap.tenantId, cap.capId, periodKey);
  const got = await states.get(key).catch(() => undefined);
  const prior = got && got.tenantId === cap.tenantId ? got : null;
  const base: CapState = prior ?? { key, tenantId: cap.tenantId, capId: cap.capId, periodKey, spentMinor: null, readAt: null, status: 'ok', pausedTargets: [], version: 0 };
  let next: CapState;
  if (read.ok) {
    // Spend does not go back down inside a period: a breach holds until the cap
    // is raised (setCapLimit re-arms) or the period rolls over.
    const status = base.status === 'breached' ? 'breached' : bandOf(read.spentMinor, cap.limitMinor);
    const { readError: _drop, ...rest } = base;
    next = { ...rest, spentMinor: read.spentMinor, readAt: now.toISOString(), coverageHash: coverageHash(targets), status, version: base.version + 1 };
  } else {
    // Stale = no good read for maxStaleMinutes, counted from the latest of the
    // cap's creation, the period start (a new month gets its own grace) and the
    // last good read.
    const baseline = Math.max(new Date(cap.createdAt).getTime(), cap.period === 'calendar-month' ? start.getTime() : 0, base.readAt ? new Date(base.readAt).getTime() : 0);
    const stale = now.getTime() - baseline > cap.maxStaleMinutes * 60_000;
    const status: CapStatus = base.status === 'breached' ? 'breached' : stale ? 'stale' : base.status;
    next = { ...base, readError: read.error, status, version: base.version + 1 };
  }
  // CLAIM: only the tick whose swap lands may act on this state change.
  if (!(await states.compareAndSwap(prior, next))) {
    return { capId: cap.capId, status: next.status, spentMinor: next.spentMinor, ...(next.readError ? { readError: next.readError } : {}), transitioned: false, raced: true, paused: 0, pauseErrors: 0 };
  }
  const transitioned = enforcing(next.status) && !enforcing(prior?.status);
  let paused = 0;
  let pauseErrors = 0;
  if (enforcing(next.status)) {
    const pauseSet: CapTarget[] = [...targets.ledger];
    for (const s of read.ok ? read.spenders : []) if (!pauseSet.some((p) => sameTarget(p, s))) pauseSet.push(s);
    const done: Array<CapTarget & { at: string }> = [];
    const failed: Array<CapTarget & { error: string }> = [];
    for (const t of pauseSet) {
      const r = await adapter.setDeliveryStatus({ ...t, status: 'paused', reason: { kind: 'cap', ref: cap.capId } });
      if (r.outcome === 'updated' || r.outcome === 'unchanged') done.push({ ...t, at: now.toISOString() });
      else failed.push({ ...t, error: 'error' in r ? String(r.error) : r.outcome });
    }
    paused = done.length;
    pauseErrors = failed.length;
    await recordPauses(key, cap.tenantId, done, failed);
    if (transitioned) await notifyCap(cap, next, paused, pauseErrors);
  }
  return { capId: cap.capId, status: next.status, spentMinor: next.spentMinor, ...(next.readError ? { readError: next.readError } : {}), transitioned, paused, pauseErrors };
}

/** Merge this tick's pause results into the state (re-read + CAS, bounded). */
async function recordPauses(key: string, tenantId: string, done: Array<CapTarget & { at: string }>, failed: Array<CapTarget & { error: string }>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await states.get(key).catch(() => undefined);
    if (!cur || cur.tenantId !== tenantId) return;
    const pausedTargets = [...cur.pausedTargets];
    for (const d of done) if (!pausedTargets.some((p) => sameTarget(p, d))) pausedTargets.push(d);
    const { pauseErrors: _old, ...rest } = cur;
    const next: CapState = { ...rest, pausedTargets, ...(failed.length ? { pauseErrors: failed } : {}), version: cur.version + 1 };
    if (await states.compareAndSwap(cur, next)) return;
  }
  log.warn('spend cap pause record lost a race three times', { key });
}

async function notifyCap(cap: SpendCap, state: CapState, paused: number, pauseErrors: number): Promise<void> {
  const what = cap.scope.kind === 'client' ? 'client spend cap' : 'campaign spend cap';
  const message = state.status === 'stale'
    ? `Spend for a ${what} could not be read for ${cap.maxStaleMinutes} minutes (${state.readError ?? 'unknown error'}), so its campaigns were paused as if the cap were reached. Paused: ${paused}; failed to pause: ${pauseErrors}.`
    : `A ${what} was reached: ${state.spentMinor === null ? '?' : minorToMajor(state.spentMinor, cap.currency)} of ${minorToMajor(cap.limitMinor, cap.currency)} ${cap.currency}. Paused: ${paused}; failed to pause: ${pauseErrors}.`;
  const actions = alertActions(state.status === 'stale' ? 'cap-stale' : 'cap-breached', {
    orgId: cap.orgId, capId: cap.capId, ...(cap.scope.kind === 'campaign' ? { campaignId: cap.scope.campaignId } : {}),
  });
  try {
    await getNotificationEmitter().emit({
      tenantId: cap.tenantId,
      type: 'campaign.spend-cap',
      priority: 'high',
      title: state.status === 'stale' ? 'Spend unreadable: campaigns paused' : 'Spend cap reached: campaigns paused',
      message,
      // ADR 0952 D4 — the actions that answer this alert; the first is the link.
      actionUrl: actions[0]?.url ?? `/campaigns?tab=campaign-intelligence&org=${encodeURIComponent(cap.orgId)}`,
      metadata: { capId: cap.capId, status: state.status, reason: state.status === 'stale' ? 'spend_unreadable' : 'cap_reached', paused, pauseErrors, actions },
    });
  } catch (e) {
    // The pause already happened; a lost notification must not undo it.
    log.warn('spend cap notification failed', { capId: cap.capId, error: e instanceof Error ? e.message : String(e) });
  }
}

// ── ADR 0952 D4 — the staged "pause" action ─────────────────────────────────

export interface PauseOutcome extends CapTarget { outcome: string; error?: string }

/** Pause every platform campaign dispatched for this MarketingCampaign (joined by
 *  brief id, never by name). Ungated, like every pause: stopping spend is the safe
 *  direction. The caller authorizes (workspace:write) and supplies the adapter on
 *  the person's own ad connections. */
export async function pauseMarketingCampaign(adapter: AdsAdapter, tenantId: string, orgId: string, campaignId: string): Promise<PauseOutcome[] | null> {
  const campaign = await getCampaign(tenantId, campaignId);
  if (!campaign || campaign.orgId !== orgId) return null;
  const targets = (await listTenantDispatchRecords(tenantId))
    .filter((r) => r.briefId === campaign.briefId)
    .map(asTarget)
    .filter((t): t is CapTarget => t !== null);
  const out: PauseOutcome[] = [];
  for (const t of targets) {
    const r = await adapter.setDeliveryStatus({ ...t, status: 'paused', reason: { kind: 'operator', ref: campaignId } });
    out.push({ ...t, outcome: r.outcome, ...('error' in r ? { error: String(r.error) } : {}) });
  }
  return out;
}

// ── The launch check (registered as the adapter's cap checker) ──────────────

/** ADR 0952 D1/D2 — may this platform campaign be launched? Refuses when a
 *  covering cap is breached or stale this period, or when a covering cap exists
 *  but nothing can enforce it (the caps watchdog is off for the tenant, or the
 *  platform's spend reader is not verified). */
export async function checkLaunchAgainstCaps(tenantId: string, target: CapTarget, now = new Date()): Promise<AdsCapVerdict> {
  const all = (await caps.listByPrefix(`${tenantId}::`)).filter((c) => c.tenantId === tenantId);
  if (all.length === 0) return { verdict: 'ok' };
  let unenforceable: string | null = null;
  let watchdogOn: boolean | null = null;
  const ledgerRows = await listTenantDispatchRecords(tenantId);
  const covering: SpendCap[] = [];
  for (const observed of all) {
    const c = await coverage(observed, target, ledgerRows);
    if (!c) continue;
    const { targets, accountCovered } = c;
    const state = await getCapState(observed, now);
    // Read again after resolving coverage/state so an intervening lower limit
    // is effective without waiting for another watchdog tick.
    const cap = await rereadCap(observed, tenantId);
    if (!cap) continue; // An intentionally removed cap no longer constrains it.
    covering.push(cap);
    if (enforcing(state?.status)) return { verdict: 'cap_exceeded', capId: cap.capId };
    if (watchdogOn === null) watchdogOn = (await resolveOne(CAPS_TOGGLE_ID, { tenantId }))?.enabled === true;
    if (!unenforceable && (!watchdogOn || !accountCovered || !targets.accounts.every((a) => adsReaderEnabled(a.platform)))) unenforceable = cap.capId;
    if (!isCurrentSnapshot(cap, state, targets, now)) {
      unenforceable ??= cap.capId;
      continue;
    }
    // A cap may have been lowered since this state was last evaluated. Never
    // trust its old 'ok' band against a different current limit.
    if (state.spentMinor >= cap.limitMinor) return { verdict: 'cap_exceeded', capId: cap.capId };
  }
  if (unenforceable) return { verdict: 'cap_unenforceable', capId: unenforceable };
  return { verdict: 'ok', ...(await nativeCeilingFor(covering, ledgerRows)) };
}

/** ADR 0952 P2 — the platform-native lifetime ceiling for a launch. The tightest
 *  LIFETIME, campaign-scoped cap whose campaign has exactly ONE platform campaign
 *  (so that campaign's own lifetime spend IS the cap's spend). A calendar-month or
 *  client cap, or a cap spread over several platform campaigns, gets none: the P1
 *  watchdog stays the guard. */
async function nativeCeilingFor(covering: SpendCap[], ledgerRows: readonly DispatchLedgerRow[]): Promise<
  Record<string, never> | { ceiling: { limitMinor: number; currency: string; capId: string } } | { noCeiling: 'period_not_lifetime' | 'multi_target' | 'client_scope' }
> {
  // No covering cap: nothing to say about ceilings.
  if (covering.length === 0) return {};
  let reason: 'period_not_lifetime' | 'multi_target' | 'client_scope' = 'client_scope';
  let best: SpendCap | null = null;
  for (const cap of covering) {
    if (cap.scope.kind !== 'campaign') continue;
    if (cap.period !== 'lifetime') { reason = 'period_not_lifetime'; continue; }
    const t = await resolveTargets(cap, ledgerRows);
    if (t.ledger.length !== 1) { reason = 'multi_target'; continue; }
    if (!best || cap.limitMinor < best.limitMinor) best = cap;
  }
  return best ? { ceiling: { limitMinor: best.limitMinor, currency: best.currency, capId: best.capId } } : { noCeiling: reason };
}

/** ADR 0952 Q3 (team-lead decision) — is this platform campaign covered by at
 *  least one cap that can actually be ENFORCED (the caps watchdog is on for the
 *  tenant and the platform's spend reader is verified)? `false` when no cap
 *  covers it at all: unlike the launch check, "no cap" never reads as ok here.
 *  ADR 0942's `enforceCampaignAction` refuses an unattended (auto / notify-after)
 *  `ads.launch` or `ads.budget` with `cap_required` when this is false. Breach
 *  state is not this function's question (the launch check refuses a breach). */
export async function hasEnforceableCap(tenantId: string, target: CapTarget): Promise<boolean> {
  if (!adsReaderEnabled(target.platform)) return false;
  const all = (await caps.listByPrefix(`${tenantId}::`)).filter((c) => c.tenantId === tenantId);
  if (all.length === 0) return false;
  if ((await resolveOne(CAPS_TOGGLE_ID, { tenantId }))?.enabled !== true) return false;
  const ledgerRows = await listTenantDispatchRecords(tenantId);
  for (const cap of all) if (await coverage(cap, target, ledgerRows)) return true;
  return false;
}

/** Does `observed` cover `target`, and through which accounts? `null` = not
 *  covered. Coverage that cannot be resolved THROWS (fail closed, never "not
 *  covered"): every money check below shares this one answer. */
async function coverage(observed: SpendCap, target: CapTarget, ledgerRows: readonly DispatchLedgerRow[]): Promise<{ targets: ResolvedTargets; accountCovered: boolean } | null> {
  const targets = await resolveTargets(observed, ledgerRows);
  if (targets.error) throw new OpenwopError('conflict', 'Spend-cap coverage could not be resolved.', 409, { capId: observed.capId });
  const accountCovered = targets.accounts.some((a) => a.platform === target.platform && normAccount(a.adAccountId) === normAccount(target.adAccountId));
  const covered = observed.scope.kind === 'campaign' ? targets.ledger.some((x) => sameTarget(x, target)) : target.orgId === observed.orgId || accountCovered;
  return covered ? { targets, accountCovered } : null;
}

/** The cap as stored NOW (null = removed). An identity change throws. */
async function rereadCap(observed: SpendCap, tenantId: string): Promise<SpendCap | null> {
  const cap = await caps.get(observed.key);
  if (!cap) return null;
  if (cap.tenantId !== tenantId || cap.orgId !== observed.orgId) throw new OpenwopError('conflict', 'Spend-cap identity changed.', 409);
  return cap;
}

/** ADR 0952 P1 — is this cap state a CURRENT, good read of exactly the
 *  population the cap covers now? Anything else (never read, a bad value, a
 *  breached/stale band, coverage changed since, older than `maxStaleMinutes`)
 *  is no basis for spending more. */
function isCurrentSnapshot(cap: SpendCap, state: CapState | null | undefined, targets: ResolvedTargets, now: Date): state is CapState & { spentMinor: number; readAt: string } {
  if (!state || state.spentMinor === null || !Number.isSafeInteger(state.spentMinor) || state.spentMinor < 0
    || (state.status !== 'ok' && state.status !== 'near') || !state.readAt || state.coverageHash !== coverageHash(targets)) return false;
  const age = now.getTime() - Date.parse(state.readAt);
  return Number.isFinite(age) && age >= 0 && age <= cap.maxStaleMinutes * 60_000;
}

/** ADR 0952 D3 — may a reallocation RAISE this campaign's daily budget to
 *  `toDailyMinor`? Refused when a covering cap is enforcing, cannot be enforced
 *  (the watchdog is off or a covered platform's spend reader is unverified), has
 *  no CURRENT snapshot (the same P1 test a launch meets: never read, stale, or
 *  read over a different population), or would be exceeded by the projection:
 *  spent + toDaily × the days left in the period (lifetime: one day). The
 *  projection counts only this campaign's new budget, so it is a necessary
 *  check, not a sufficient one; the watchdog stays the guard. */
export async function capBlocksIncrease(tenantId: string, target: CapTarget, toDailyMinor: number, now = new Date()): Promise<{ capId: string; reason: 'cap_enforcing' | 'cap_unenforceable' | 'cap_stale' | 'cap_headroom' } | null> {
  const all = (await caps.listByPrefix(`${tenantId}::`)).filter((c) => c.tenantId === tenantId);
  if (all.length === 0) return null;
  const ledgerRows = await listTenantDispatchRecords(tenantId);
  let watchdogOn: boolean | null = null;
  for (const observed of all) {
    const c = await coverage(observed, target, ledgerRows);
    if (!c) continue;
    const state = await getCapState(observed, now);
    const cap = await rereadCap(observed, tenantId);
    if (!cap) continue;
    if (enforcing(state?.status)) return { capId: cap.capId, reason: 'cap_enforcing' };
    if (watchdogOn === null) watchdogOn = (await resolveOne(CAPS_TOGGLE_ID, { tenantId }))?.enabled === true;
    if (!watchdogOn || !c.accountCovered || !c.targets.accounts.every((a) => adsReaderEnabled(a.platform))) return { capId: cap.capId, reason: 'cap_unenforceable' };
    if (!isCurrentSnapshot(cap, state, c.targets, now)) return { capId: cap.capId, reason: 'cap_stale' };
    const days = cap.period === 'lifetime' ? 1 : Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 86_400_000);
    if (state.spentMinor + toDailyMinor * days > cap.limitMinor) return { capId: cap.capId, reason: 'cap_headroom' };
  }
  return null;
}

// ── Subject erasure (ADR 0464 / 0891 D8 pattern) ─────────────────────────────

/** Tombstone the creator on this tenant's caps. A cap is client configuration
 *  that keeps protecting spend after its author leaves, so it is never deleted. */
export async function eraseSpendCapCreators(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let touched = 0;
  for (const cap of await caps.listByPrefix(`${tenantId}::`)) {
    if (cap.tenantId !== tenantId || !forms.has(cap.createdBy)) continue;
    let done = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await caps.get(cap.key);
      if (!current || current.tenantId !== tenantId || !forms.has(current.createdBy)) { done = true; break; }
      if (await caps.compareAndSwap(current, { ...current, createdBy: tombstone })) { touched++; done = true; break; }
    }
    if (!done) throw new OpenwopError('conflict', 'Spend-cap creator erasure lost concurrent updates; retry.', 409);
  }
  return touched;
}

/** Test-only. */
export async function __clearSpendCaps(): Promise<void> {
  await caps.__clear();
  await states.__clear();
}
