/**
 * Marketing Campaign service (ADR 0158). CRUD on `DurableCollection`, tenant+org
 * keyed (CTI-1). ONE campaign per brief: ADR 0941 D2 creates it at ignition
 * (`ensureDraftCampaign`, deterministic id + the brief index) and
 * `finalizeFromBrief` updates it, so re-finalizing updates rather than
 * duplicates. A foreign-tenant id reads `null` (the route maps that to 404).
 *
 * Composes the brief (ADR 0156) by reading it — the cross-feature read precedent
 * (priority-matrix → documents/projects). No parallel brief store.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 * @see docs/adr/0941-campaign-studio-program-and-canonical-campaign.md
 */

import { createHash, randomBytes } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { fireCampaignDeleted } from '../../host/campaignLifecycle.js';
import { cleanString } from '../../host/boundedStrings.js';
import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { clearUsageForRef, getAsset, syncUsageRefs } from '../media/mediaService.js';
import type { CampaignBrief } from '../campaign-brief/types.js';
import type { CampaignGoal, CampaignStatus, CampaignVersion, MarketingCampaign } from './types.js';

/** ADR 0941 D2 — the brief → campaign index row (replaces the O(tenant) scan). */
interface BriefIndexRow { tenantId: string; briefId: string; campaignId: string }

const log = createLogger('campaign-orchestration');

/** A retired identity is never reused. Its one successor is fixed by retirement CAS.
 * No person-authored fields survive; old id-keyed cleanup cannot touch successors. */
interface RetiredCampaign { tenantId: string; id: string; orgId: string; retired: true; successorId: string }
type CampaignRow = MarketingCampaign | RetiredCampaign;
const activeCampaign = (c: CampaignRow): c is MarketingCampaign => !('retired' in c && c.retired === true);
const campaigns = new DurableCollection<CampaignRow>('campaign-orchestration:campaign', (c) => `${c.tenantId}::${c.id}`);
const campaignVersions = new DurableCollection<CampaignVersion>('campaign-orchestration:campaignversion', (v) => v.versionId);
const briefIndex = new DurableCollection<BriefIndexRow>('campaign-orchestration:brief-index', (r) => `${r.tenantId}::${r.briefId}`, undefined, (r) => r.tenantId);

/** The brief-index row that marks a tenant's pre-0941 campaigns as indexed.
 *  Not a brief id shape (brief ids are uuids), so it cannot collide. */
const BACKFILL_MARKER = '__0941_backfilled__';

const RFC4648_LOWER = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += RFC4648_LOWER[(value << (5 - bits)) & 31];
  return out;
}

/**
 * ADR 0941 D2 — the deterministic id of a briefed campaign: `cmp_` + base32 of
 * sha256(tenant, briefId), 120 bits (24 chars). Two ignitions of one brief name
 * the same row, so the row's own insert-if-absent is the race arbiter.
 * Brief-less campaigns (D2) take `cmp_` + a uuid.
 */
export function briefCampaignId(tenantId: string, briefId: string): string {
  const digest = createHash('sha256').update(`${tenantId}\u0000${briefId}`).digest();
  return `cmp_${base32(digest.subarray(0, 15))}`;
}

/** Cap snapshots per campaign (the CMS `MAX_VERSIONS` precedent). */
const MAX_CAMPAIGN_VERSIONS = 50;

// ── Lifecycle bookkeeping (campaign gap plan §5B B1/B2; the ADR 0204 C1/C5
//    `recordCmsAction` precedent) ─────────────────────────────────────────────

/** Campaign action → the `host.campaign.campaign.*` lifecycle event (vendor
 *  pattern per RFC 0086 §E — schema-legal, no RFC). Fans out through
 *  `emitHostEvent` (host/hostEventDispatcher, ADR 0208): signed webhooks + the
 *  event→workflow trigger bindings, so a campaign event can start a chain. */
const CAMPAIGN_EVENT_FOR_ACTION: Record<string, string> = {
  finalized: 'host.campaign.campaign.finalized',
  'status-changed': 'host.campaign.campaign.status-changed',
  deleted: 'host.campaign.campaign.deleted',
};

/**
 * Record a campaign action: an audit row (`payload.tenantId` REQUIRED — the
 * tenant-scoped governance read withholds rows without it) and, when mapped, a
 * lifecycle webhook through the ONE delivery pipeline. Best-effort — never
 * fails the write it describes. Ids/status only — no kernel copy, no content.
 */
function recordCampaignAction(action: string, campaign: MarketingCampaign, actor: string, extra?: Record<string, unknown>): void {
  const at = new Date().toISOString();
  const base = { tenantId: campaign.tenantId, orgId: campaign.orgId, campaignId: campaign.id, briefId: campaign.briefId, status: campaign.status, version: campaign.version ?? 1, actor, at, ...extra };
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `campaign.campaign.${action}`, resource: campaign.id, outcome: 'success', payload: base })
      .catch((err) => log.warn('campaign audit append failed', { action, campaignId: campaign.id, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  const eventType = CAMPAIGN_EVENT_FOR_ACTION[action];
  if (eventType) {
    void emitHostEvent({ type: eventType, tenantId: campaign.tenantId, payload: { ...base, name: campaign.name } });
  }
}

/** Snapshot a campaign revision (dedup by `version`). */
async function snapshotCampaign(campaign: MarketingCampaign, actor: string): Promise<void> {
  try {
    const existing = await listCampaignVersions(campaign.tenantId, campaign.id);
    const version = campaign.version ?? 1;
    if (existing.some((v) => v.version === version)) return;
    const seq = existing.length === 0 ? 1 : Math.max(...existing.map((v) => v.seq)) + 1;
    await campaignVersions.put({
      versionId: `${campaign.tenantId}::${campaign.id}::v${version}`,
      tenantId: campaign.tenantId,
      orgId: campaign.orgId,
      campaignId: campaign.id,
      version,
      snapshot: {
        name: campaign.name, objective: campaign.objective, brandId: campaign.brandId,
        personaIds: [...campaign.personaIds], channels: [...campaign.channels],
        kernel: campaign.kernel, status: campaign.status,
      },
      actor,
      at: new Date().toISOString(),
      seq,
    });
    if (existing.length + 1 > MAX_CAMPAIGN_VERSIONS) {
      const oldest = [...existing].sort((a, b) => a.seq - b.seq).slice(0, existing.length + 1 - MAX_CAMPAIGN_VERSIONS);
      for (const v of oldest) await campaignVersions.delete(v.versionId);
    }
  } catch (err) {
    log.warn('campaign snapshot failed', { campaignId: campaign.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** List a campaign's revision snapshots, newest-first. */
export async function listCampaignVersions(tenantId: string, campaignId: string): Promise<CampaignVersion[]> {
  const all = await campaignVersions.listByPrefix(`${tenantId}::${campaignId}::`);
  return all.filter((v) => v.tenantId === tenantId && v.campaignId === campaignId).sort((a, b) => b.seq - a.seq);
}

const tenantKey = (tenantId: string, id: string): string => `${tenantId}::${id}`;

export async function listCampaigns(tenantId: string, orgId?: string): Promise<MarketingCampaign[]> {
  const all = await campaigns.listByPrefix(`${tenantId}::`);
  return all.filter(activeCampaign).filter((c) => c.tenantId === tenantId && (!orgId || c.orgId === orgId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getCampaign(tenantId: string, campaignId: string): Promise<MarketingCampaign | null> {
  const c = await campaigns.get(tenantKey(tenantId, campaignId));
  return c && c.tenantId === tenantId && activeCampaign(c) ? c : null;
}

/** Bounded retries for `mutateCampaign` under write contention; each loss
 *  backs off a little (jittered) so N racing writers settle in ~N rounds. */
const MUTATE_ATTEMPTS = 24;


/**
 * ADR 0941 P1 — the ONE writer of an existing campaign row. Reads the row,
 * applies `fn`, and compare-and-swaps the result, retrying on a lost race, so
 * a concurrent writer (a rename, the product-delete hook, a finalize) can never
 * silently drop another's change (a read→put overwrites whatever landed in
 * between). `fn` may return null to leave the row unchanged. Returns
 * `{ before, after }`, or null when the campaign does not exist.
 */
export async function mutateCampaign(
  tenantId: string,
  campaignId: string,
  fn: (current: MarketingCampaign) => MarketingCampaign | null,
): Promise<{ before: MarketingCampaign; after: MarketingCampaign } | null> {
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt++) {
    const current = await getCampaign(tenantId, campaignId);
    if (!current) return null;
    const next = fn(structuredClone(current));
    if (!next) return { before: current, after: current };
    if (next.id !== current.id || next.tenantId !== current.tenantId) throw new Error('mutateCampaign: a mutation may not change the row identity');
    if (await campaigns.compareAndSwap(current, next)) return { before: current, after: next };
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3 * (attempt + 1))));
  }
  // A typed 409 the routes relay as-is (never a 500): the caller may retry.
  throw new OpenwopError('conflict', 'The campaign was changed by someone else at the same time. Try again.', 409, { reason: 'campaign_write_conflict', campaignId });
}

/**
 * ADR 0941 D2 — index pre-0941 campaigns once per tenant. The one tenant scan
 * this feature still does, and it runs at most once: the marker row is written
 * last, so a reader that sees it sees every legacy row. Concurrent backfills
 * write identical rows. A brief that the pre-0941 TOCTOU gave two campaigns
 * resolves to the OLDEST (then the smaller id), deterministically.
 */
async function backfillBriefIndex(tenantId: string): Promise<void> {
  if (await briefIndex.get(`${tenantId}::${BACKFILL_MARKER}`)) return;
  const all = await campaigns.listByPrefix(`${tenantId}::`);
  const pick = new Map<string, MarketingCampaign>();
  for (const c of all) {
    if (!activeCampaign(c) || c.tenantId !== tenantId || !c.briefId) continue;
    const prev = pick.get(c.briefId);
    if (!prev || c.createdAt < prev.createdAt || (c.createdAt === prev.createdAt && c.id < prev.id)) pick.set(c.briefId, c);
  }
  for (const c of pick.values()) await briefIndex.putIfAbsent({ tenantId, briefId: c.briefId, campaignId: c.id });
  await briefIndex.put({ tenantId, briefId: BACKFILL_MARKER, campaignId: '' });
}

/** The campaign id indexed for a brief, or null. A point lookup after the
 *  tenant's one-time backfill. */
async function indexedCampaignId(tenantId: string, briefId: string): Promise<string | null> {
  const row = await briefIndex.get(`${tenantId}::${briefId}`);
  if (row?.tenantId === tenantId && row.campaignId) return row.campaignId;
  if (await briefIndex.get(`${tenantId}::${BACKFILL_MARKER}`)) return null;
  await backfillBriefIndex(tenantId);
  const after = await briefIndex.get(`${tenantId}::${briefId}`);
  return after?.tenantId === tenantId && after.campaignId ? after.campaignId : null;
}

/** Only brief-based ignition/lookup follows retirement. By-id operations stay exact. */
async function briefCampaignSlot(tenantId: string, briefId: string): Promise<{ id: string; campaign: MarketingCampaign | null; index: BriefIndexRow | null }> {
  await indexedCampaignId(tenantId, briefId); // Includes legacy oldest-row backfill.
  const index = await briefIndex.get(`${tenantId}::${briefId}`);
  let id = index?.campaignId || briefCampaignId(tenantId, briefId);
  const seen = new Set<string>();
  for (let depth = 0; depth < 64; depth += 1) {
    if (seen.has(id)) break;
    seen.add(id);
    const row = await campaigns.get(tenantKey(tenantId, id));
    if (!row) return { id, campaign: null, index };
    if (row.tenantId !== tenantId || row.id !== id) break;
    if (activeCampaign(row)) {
      if (row.briefId !== briefId) break;
      return { id, campaign: row, index };
    }
    if (typeof row.successorId !== 'string' || !/^cmp_[a-z2-7]{24}$/.test(row.successorId) || row.successorId === id) break;
    id = row.successorId;
  }
  throw new OpenwopError('conflict', 'The campaign identity chain needs repair.', 409, { reason: 'campaign_identity_conflict' });
}

export async function getCampaignByBrief(tenantId: string, briefId: string): Promise<MarketingCampaign | null> {
  if (!briefId || briefId === BACKFILL_MARKER) return null;
  return (await briefCampaignSlot(tenantId, briefId)).campaign;
}

/** ADR 0941 D2 — a new brief starts at its deterministic id. Re-ignition after
 * retirement converges on the one opaque successor fixed by the retirement CAS.
 * The brief index is a reservation, not permission to reuse a retired identity. */
export async function ensureDraftCampaign(tenantId: string, brief: CampaignBrief, actor: string): Promise<{ campaign: MarketingCampaign; created: boolean }> {
  if (brief.tenantId !== tenantId) throw new Error('ensureDraftCampaign: brief belongs to another tenant');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slot = await briefCampaignSlot(tenantId, brief.id);
    if (slot.campaign) {
      if (slot.campaign.orgId !== brief.orgId) throw new OpenwopError('not_found', 'Campaign not found.', 404, { reason: 'campaign_not_found' });
      if (slot.index?.campaignId !== slot.id) await briefIndex.compareAndSwap(slot.index, { tenantId, briefId: brief.id, campaignId: slot.id });
      return { campaign: slot.campaign, created: false };
    }
    const now = new Date().toISOString();
    const draft: MarketingCampaign = {
      ...buildCampaignFromBrief(brief), id: slot.id, version: 1, ignitedAt: now,
      createdBy: actor, createdAt: now, updatedAt: now,
    };
    if (!await campaigns.putIfAbsent(draft)) continue; // Re-read the winner or its retirement.
    // Never regress a newer reservation with a stale ignition's index repair.
    await briefIndex.compareAndSwap(slot.index, { tenantId, briefId: brief.id, campaignId: draft.id });
    recordCampaignAction('created', draft, actor, { origin: 'ignition' });
    return { campaign: draft, created: true };
  }
  throw new OpenwopError('conflict', 'The campaign changed during ignition; retry.', 409, { reason: 'campaign_write_conflict' });
}

/** A pre-0941 row (no `ignitedAt`) was finalized when it was created. */
export function isFinalized(c: MarketingCampaign): boolean {
  return Boolean(c.finalizedAt) || !c.ignitedAt;
}

/** Build a campaign payload from a confirmed/validated brief (pure). Optional
 *  fields are emitted with an EXPLICIT `undefined` when the brief lacks them
 *  (grade-code AUDIT-12) — so a re-finalize's `{ ...existing, ...payload }` merge
 *  CLEARS a field the brief removed (budget/brand/kernel/utm) instead of leaving
 *  a stale value; `undefined` keys drop on the JSON `put`. */
export function buildCampaignFromBrief(brief: CampaignBrief): Omit<MarketingCampaign, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> {
  return {
    tenantId: brief.tenantId,
    orgId: brief.orgId,
    briefId: brief.id,
    name: brief.name,
    objective: brief.objective,
    brandId: brief.brandId,
    personaIds: brief.personaIds,
    kbCollectionId: brief.kbCollectionId,
    channels: brief.channels.filter((c) => c.enabled).map((c) => c.type),
    kernel: brief.kernel,
    budget: brief.budget,
    utm: brief.utm,
    status: 'draft',
  };
}

/** Finalize a brief's campaign — one campaign per brief. ADR 0941 D2: the
 *  campaign normally exists from ignition, so the first finalize UPDATES that
 *  draft (version stays 1); a re-finalize bumps the version. A finalize with no
 *  prior ignition (the REST adapter, the seeds) creates the row the same way. */
export async function finalizeFromBrief(tenantId: string, brief: CampaignBrief, createdBy: string, opts?: { productionPlanId?: string; expectedCampaignId?: string }): Promise<MarketingCampaign> {
  if (brief.tenantId !== tenantId) throw new OpenwopError('not_found', 'Campaign not found.', 404, { reason: 'campaign_not_found' });
  const payload = buildCampaignFromBrief(brief);
  const ensured = opts?.expectedCampaignId !== undefined
    ? await getCampaign(tenantId, opts.expectedCampaignId)
    : (await ensureDraftCampaign(tenantId, brief, createdBy)).campaign;
  if (!ensured || ensured.briefId !== brief.id || ensured.orgId !== brief.orgId) {
    throw new OpenwopError('not_found', 'Campaign not found.', 404, { reason: 'campaign_not_found' });
  }
  const now = new Date().toISOString();
  const written = await mutateCampaign(tenantId, ensured.id, (existing) => ({
    ...existing,
    ...payload,
    status: existing.status,
    version: isFinalized(existing) ? (existing.version ?? 1) + 1 : (existing.version ?? 1),
    finalizedAt: existing.finalizedAt ?? now,
    updatedAt: now,
    ...(opts?.productionPlanId ? { productionPlanId: opts.productionPlanId } : {}),
  }));
  if (!written) throw new OpenwopError('not_found', 'Campaign not found.', 404, { reason: 'campaign_not_found' });
  const { before: existing, after: campaign } = written;
  const refinalized = isFinalized(existing);
  if (refinalized) await snapshotCampaign(existing, createdBy); // pin the pre-refinalize revision
  await snapshotCampaign(campaign, createdBy); // pin the finalized revision
  recordCampaignAction('finalized', campaign, createdBy, { refinalized });
  // ADR 0852 D1 — the campaign's project (create-or-return; fail-soft). Dynamic
  // import: campaignProject.ts reads campaigns through this module.
  await (await import('./campaignProject.js')).linkProjectOnFinalize(campaign, createdBy);
  return campaign;
}

export async function updateCampaignStatus(tenantId: string, campaignId: string, status: CampaignStatus, actor = 'system'): Promise<MarketingCampaign | null> {
  const written = await mutateCampaign(tenantId, campaignId, (c) => ({ ...c, status, updatedAt: new Date().toISOString() }));
  if (!written) return null;
  const { before: existing, after: next } = written;
  if (status !== existing.status) recordCampaignAction('status-changed', next, actor, { from: existing.status });
  return next;
}

/**
 * ADR 0941 D2b — replace a campaign's goal. The version is the service's to
 * assign (previous + 1), never the caller's: a run names the version it was
 * started under, so a version must never repeat. A goal edit affects only runs
 * started after it. Shape validation is the caller's (the P1 route); this stays
 * a dumb write. Null clears the goal (the version still advances on the next set).
 */
export async function setCampaignGoal(tenantId: string, campaignId: string, goal: Omit<CampaignGoal, 'version'> | null, actor = 'system'): Promise<MarketingCampaign | null> {
  const written = await mutateCampaign(tenantId, campaignId, (existing) => {
    const next: MarketingCampaign = { ...existing, updatedAt: new Date().toISOString() };
    if (goal) next.goal = { ...structuredClone(goal), version: (existing.goal?.version ?? existing.goalVersionFloor ?? 0) + 1 };
    else {
      if (existing.goal) next.goalVersionFloor = existing.goal.version;
      delete next.goal;
    }
    return next;
  });
  if (!written) return null;
  const next = written.after;
  recordCampaignAction('goal-changed', next, actor, { goalVersion: next.goal?.version ?? null });
  return next;
}

export async function renameCampaign(tenantId: string, campaignId: string, name: string, actor = 'system'): Promise<MarketingCampaign | null> {
  const clean = cleanString(name, 160);
  const written = await mutateCampaign(tenantId, campaignId, (c) => ({ ...c, name: clean || c.name, updatedAt: new Date().toISOString() }));
  if (!written) return null;
  const { before: existing, after: next } = written;
  if (next.name !== existing.name) recordCampaignAction('renamed', next, actor, { from: existing.name });
  return next;
}

/** Set/clear a campaign's parent (C8 hierarchy — plain reference). The route
 *  validates same-org + existence; this stays a dumb write. */
export async function setCampaignParent(tenantId: string, campaignId: string, parentCampaignId: string | undefined, actor = 'system'): Promise<MarketingCampaign | null> {
  const written = await mutateCampaign(tenantId, campaignId, (c) => {
    const n: MarketingCampaign = { ...c, updatedAt: new Date().toISOString() };
    if (parentCampaignId) n.parentCampaignId = parentCampaignId;
    else delete n.parentCampaignId;
    return n;
  });
  if (!written) return null;
  const { before: existing, after: next } = written;
  if ((existing.parentCampaignId ?? '') !== (parentCampaignId ?? '')) {
    recordCampaignAction('parent-changed', next, actor, { from: existing.parentCampaignId ?? null, to: parentCampaignId ?? null });
  }
  return next;
}

/** Attach media assets to a campaign — the durable campaign→asset edge
 *  (CS-DATA-5). UNIONS `assetIds` into `campaign.assetIds` (dedupe, stable
 *  order) so a re-render adds concepts without dropping earlier ones, then
 *  stamps the media "used in N campaigns" graph best-effort (the
 *  `stampMoodBoardUsage` precedent): resolve each assetId → serveToken and
 *  reconcile the FULL set for this campaign via `syncUsageRefs`. Cleared in
 *  `deleteCampaign`. Returns the updated campaign, or null if it is absent. */
export async function attachCampaignAssets(tenantId: string, campaignId: string, assetIds: string[], actor = 'workflow'): Promise<MarketingCampaign | null> {
  let merged: string[] = [];
  const written = await mutateCampaign(tenantId, campaignId, (existing) => {
    merged = [];
    const seen = new Set<string>();
    for (const id of [...(existing.assetIds ?? []), ...assetIds]) {
      const clean = typeof id === 'string' ? id.trim() : '';
      if (clean && !seen.has(clean)) { seen.add(clean); merged.push(clean); }
    }
    return { ...existing, assetIds: merged, updatedAt: new Date().toISOString() };
  });
  if (!written) return null;
  const next = written.after;
  // Stamp the media usage graph best-effort — never fail the attach because
  // bookkeeping did (the `stampMoodBoardUsage` precedent). Reconcile the FULL
  // set (syncUsageRefs adds + removes), so a stale ref self-corrects.
  try {
    const tokens: string[] = [];
    for (const id of merged) {
      const a = await getAsset(tenantId, next.orgId, id);
      if (a) tokens.push(a.serveToken);
    }
    await syncUsageRefs(tenantId, next.orgId, { kind: 'campaign', id: campaignId, label: next.name }, tokens);
  } catch (err) {
    log.warn('campaign asset usage stamping failed', { campaignId, error: err instanceof Error ? err.message : String(err) });
  }
  recordCampaignAction('assets-attached', next, actor, { attached: assetIds.length, total: merged.length });
  return next;
}

export async function deleteCampaign(tenantId: string, campaignId: string, actor = 'system'): Promise<boolean> {
  let retired: RetiredCampaign | undefined;
  let removed: MarketingCampaign | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await campaigns.get(tenantKey(tenantId, campaignId));
    if (!current || current.tenantId !== tenantId || current.id !== campaignId) return false;
    if (!activeCampaign(current)) { retired = current; break; }
    // Legacy ids are not derivable from the brief. Preserve their canonical
    // reservation BEFORE removing the last row carrying the brief id.
    if (current.briefId && !await indexedCampaignId(tenantId, current.briefId)) {
      await briefIndex.putIfAbsent({ tenantId, briefId: current.briefId, campaignId });
    }
    const marker: RetiredCampaign = { tenantId, id: campaignId, orgId: current.orgId, retired: true, successorId: `cmp_${base32(randomBytes(15))}` };
    if (!await campaigns.compareAndSwap(current, marker)) continue;
    retired = marker;
    removed = current;
    recordCampaignAction('deleted', current, actor);
    break;
  }
  if (!retired) throw new OpenwopError('conflict', 'The campaign changed during deletion; retry.', 409, { reason: 'campaign_write_conflict' });
  // The parent is already unreachable. Every cleanup key still names ONLY the
  // retired id, even if its successor starts before this attempt completes.
  try { await clearUsageForRef(tenantId, retired.orgId, 'campaign', campaignId); }
  catch (err) { log.warn('campaign asset usage clear failed', { campaignId, error: err instanceof Error ? err.message : String(err) }); }
  for (const v of await listCampaignVersions(tenantId, campaignId)) await campaignVersions.delete(v.versionId);
  await fireCampaignDeleted({ tenantId, orgId: retired.orgId, campaignId });
  return Boolean(removed);
}

/** Test-only: write a campaign row verbatim (a pre-0941 row, for backfill tests). */
export async function __putCampaignRow(c: MarketingCampaign): Promise<void> {
  await campaigns.put(c);
}

/** Subject erasure (ADR 0464; ADR 0946 P0 registers it with the variant-set
 *  eraser): a campaign is org marketing state with versions, sends and
 *  enrollments hanging off it, so it is kept and `createdBy` is tombstoned. */
export async function eraseCampaignAuthor(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const c of await listCampaigns(tenantId)) {
    if (c.tenantId !== tenantId || !forms.has(c.createdBy)) continue;
    const result = await mutateCampaign(tenantId, c.id, (current) =>
      forms.has(current.createdBy) ? { ...current, createdBy: tombstone } : null);
    if (result && result.before.createdBy !== result.after.createdBy) n += 1;
  }
  return n;
}

/** Test-only: drop every campaign. */
export async function __clearCampaigns(): Promise<void> {
  await campaigns.__clear();
  await briefIndex.__clear();
}
