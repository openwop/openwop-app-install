/**
 * Campaign Brief service (ADR 0156 Phase 2). Owns the `CampaignBrief` entity —
 * CRUD on `DurableCollection`, tenant + org keyed (CTI-1). A brief references a
 * brand / personas / KB collection by id; cross-org reference integrity is the
 * route layer's job (it loads each in the caller's org). `validate` computes the
 * enabled channel set that drives the orchestration fan-out (ADR 0158).
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { deleteVocForBrief } from './vocService.js';
import { deleteAnglesForBrief } from './angleService.js';
import { deleteTargetingForBrief } from './targetingService.js';
import {
  CAMPAIGN_CHANNELS, EMPTY_MESSAGING, defaultChannels,
  type BriefBudget, type BriefChannel, type BriefMessaging, type BriefUtm, type BriefValidationResult, type BriefVersion, type CampaignBrief,
  type CampaignChannel, type MessagingKernel,
} from './types.js';

const log = createLogger('campaign-brief');

const briefs = new DurableCollection<CampaignBrief>('campaign-brief:brief', (b) => `${b.tenantId}::${b.id}`);
const briefVersions = new DurableCollection<BriefVersion>('campaign-brief:briefversion', (v) => v.versionId);

/** Cap snapshots per brief (the CMS `MAX_VERSIONS` precedent). */
const MAX_BRIEF_VERSIONS = 50;

// ── Lifecycle bookkeeping (campaign gap plan §5B B1/B2; the ADR 0204 C1/C5
//    `recordCmsAction` precedent) ─────────────────────────────────────────────

/** Brief action → the `host.campaign.brief.*` lifecycle event it emits (vendor
 *  pattern per RFC 0086 §E — schema-legal, no RFC). Fans out through
 *  `emitHostEvent` (host/hostEventDispatcher, ADR 0208): signed webhooks + the
 *  event→workflow trigger bindings, so a campaign event can start a chain. */
const BRIEF_EVENT_FOR_ACTION: Record<string, string> = {
  created: 'host.campaign.brief.created',
  validated: 'host.campaign.brief.validated',
  confirmed: 'host.campaign.brief.confirmed',
  deleted: 'host.campaign.brief.deleted',
};

/**
 * Record a brief action: an audit row (`payload.tenantId` is REQUIRED — the
 * tenant-scoped governance read withholds rows without it, fail-closed) and,
 * when the action maps to a lifecycle event, a webhook fan-out through the ONE
 * delivery pipeline. Best-effort — bookkeeping never fails the write it
 * describes. Ids/status only — no brief content, kernel copy, or PII.
 */
function recordBriefAction(action: string, brief: CampaignBrief, actor: string, extra?: Record<string, unknown>): void {
  const at = new Date().toISOString();
  const base = { tenantId: brief.tenantId, orgId: brief.orgId, briefId: brief.id, status: brief.status, version: brief.version ?? 1, actor, at, ...extra };
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `campaign.brief.${action}`, resource: brief.id, outcome: 'success', payload: base })
      .catch((err) => log.warn('brief audit append failed', { action, briefId: brief.id, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  const eventType = BRIEF_EVENT_FOR_ACTION[action];
  if (eventType) {
    void emitHostEvent({ type: eventType, tenantId: brief.tenantId, payload: { ...base, name: brief.name } });
  }
}

/** Snapshot a brief's current content as an immutable revision (dedup by
 *  `version` — a no-op when that revision is already captured). */
async function snapshotBrief(brief: CampaignBrief, actor: string): Promise<void> {
  try {
    const existing = await listBriefVersions(brief.tenantId, brief.id);
    const version = brief.version ?? 1;
    if (existing.some((v) => v.version === version)) return;
    const seq = existing.length === 0 ? 1 : Math.max(...existing.map((v) => v.seq)) + 1;
    await briefVersions.put({
      versionId: `${brief.tenantId}::${brief.id}::v${version}`,
      tenantId: brief.tenantId,
      orgId: brief.orgId,
      briefId: brief.id,
      version,
      snapshot: {
        name: brief.name, objective: brief.objective, brandId: brief.brandId, personaIds: [...brief.personaIds],
        productName: brief.productName, productDescription: brief.productDescription,
        industryVertical: brief.industryVertical, channels: brief.channels.map((c) => ({ ...c, config: { ...c.config } })),
        messaging: { ...brief.messaging, proofPoints: [...brief.messaging.proofPoints] },
        ...(brief.budget ? { budget: { ...brief.budget, ...(brief.budget.perChannel ? { perChannel: { ...brief.budget.perChannel } } : {}) } } : {}),
        ...(brief.utm ? { utm: { ...brief.utm } } : {}),
        status: brief.status, kernel: brief.kernel,
      },
      actor,
      at: new Date().toISOString(),
      seq,
    });
    // Cap: drop the oldest beyond the limit.
    if (existing.length + 1 > MAX_BRIEF_VERSIONS) {
      const oldest = [...existing].sort((a, b) => a.seq - b.seq).slice(0, existing.length + 1 - MAX_BRIEF_VERSIONS);
      for (const v of oldest) await briefVersions.delete(v.versionId);
    }
  } catch (err) {
    log.warn('brief snapshot failed', { briefId: brief.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** List a brief's revision snapshots, newest-first. */
export async function listBriefVersions(tenantId: string, briefId: string): Promise<BriefVersion[]> {
  const all = await briefVersions.listByPrefix(`${tenantId}::${briefId}::`);
  return all.filter((v) => v.tenantId === tenantId && v.briefId === briefId).sort((a, b) => b.seq - a.seq);
}

const NAME_MAX = 160;
const TEXT_MAX = 2000;
const ITEM_MAX = 400;
const LIST_MAX = 50;

export interface BriefInput {
  name?: unknown;
  objective?: unknown;
  brandId?: unknown;
  personaIds?: unknown;
  kbCollectionId?: unknown;
  groundingPolicy?: unknown;
  competitors?: unknown;
  productName?: unknown;
  productDescription?: unknown;
  industryVertical?: unknown;
  channels?: unknown;
  messaging?: unknown;
  budget?: unknown;
  utm?: unknown;
  status?: unknown;
}

/** Sanitize a spend plan (C8): finite ≥0 integers (minor units), known channels only. */
function sanitizeBudget(raw: unknown): BriefBudget | undefined {
  if (raw === null) return undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const minor = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const out: BriefBudget = {};
  const total = minor(r.totalMinor);
  if (total !== undefined) out.totalMinor = total;
  // R2 CB-SP-3 — currency is display-only but downstream money renders key off
  // it, so only an ISO-4217-shaped code is stored (the old any-8-chars accepted
  // "DOLLARS" from agent/workflow writes; a malformed code is dropped, not the
  // budget).
  const currency = cleanString(r.currency, 8).toUpperCase();
  if (/^[A-Z]{3}$/.test(currency)) out.currency = currency;
  if (r.perChannel && typeof r.perChannel === 'object') {
    const per: BriefBudget['perChannel'] = {};
    for (const [k, v] of Object.entries(r.perChannel as Record<string, unknown>)) {
      const m = minor(v);
      if (m !== undefined && CHANNEL_SET.has(k)) per[k as CampaignChannel] = m;
    }
    if (Object.keys(per).length > 0) out.perChannel = per;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Sanitize the UTM schema (C8): bounded values, url-safe-ish (no spaces kept as-is —
 *  callers URL-encode at stamp time). */
function sanitizeUtm(raw: unknown): BriefUtm | undefined {
  if (raw === null) return undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: BriefUtm = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content'] as const) {
    const v = cleanString(r[k], 120);
    if (v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const idList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.slice(0, LIST_MAX).map((v) => cleanString(v, NAME_MAX)).filter((v) => v.length > 0) : [];
const strList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.slice(0, LIST_MAX).map((v) => cleanString(v, ITEM_MAX)).filter((v) => v.length > 0) : [];

const CHANNEL_SET = new Set<string>(CAMPAIGN_CHANNELS);

function sanitizeChannels(raw: unknown): BriefChannel[] {
  const base = defaultChannels();
  if (!Array.isArray(raw)) return base;
  const byType = new Map(base.map((c) => [c.type, c]));
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const type = cleanString(r.type, 40);
    if (!CHANNEL_SET.has(type)) continue;
    byType.set(type as CampaignChannel, {
      type: type as CampaignChannel,
      enabled: r.enabled === true,
      config: r.config && typeof r.config === 'object' ? (r.config as Record<string, unknown>) : {},
    });
  }
  return CAMPAIGN_CHANNELS.map((t) => byType.get(t)!);
}

function sanitizeMessaging(raw: unknown): BriefMessaging {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MESSAGING };
  const m = raw as Record<string, unknown>;
  return {
    primaryValueProp: cleanString(m.primaryValueProp, TEXT_MAX),
    toneOverride: cleanString(m.toneOverride, NAME_MAX),
    proofPoints: strList(m.proofPoints),
    ctaStrategy: cleanString(m.ctaStrategy, NAME_MAX),
  };
}

const tenantKey = (tenantId: string, id: string): string => `${tenantId}::${id}`;

export async function listBriefs(tenantId: string, orgId?: string): Promise<CampaignBrief[]> {
  const all = await briefs.listByPrefix(`${tenantId}::`);
  return all.filter((b) => !orgId || b.orgId === orgId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getBrief(tenantId: string, briefId: string): Promise<CampaignBrief | null> {
  const b = await briefs.get(tenantKey(tenantId, briefId));
  return b && b.tenantId === tenantId ? b : null;
}

export async function createBrief(tenantId: string, orgId: string, createdBy: string, input: BriefInput): Promise<CampaignBrief> {
  const name = cleanString(input.name, NAME_MAX);
  if (!name) throw new OpenwopError('validation_error', 'A brief name is required.', 400, { field: 'name' });
  const now = new Date().toISOString();
  const brief: CampaignBrief = {
    id: randomUUID(),
    tenantId,
    orgId,
    name,
    objective: cleanString(input.objective, TEXT_MAX),
    brandId: optionalCleanString(input.brandId, NAME_MAX),
    personaIds: idList(input.personaIds),
    kbCollectionId: optionalCleanString(input.kbCollectionId, NAME_MAX),
    ...(parseGroundingPolicy(input.groundingPolicy) ? { groundingPolicy: parseGroundingPolicy(input.groundingPolicy)! } : {}),
    ...(parseCompetitors(input.competitors) ? { competitors: parseCompetitors(input.competitors)! } : {}),
    productName: cleanString(input.productName, NAME_MAX),
    productDescription: cleanString(input.productDescription, TEXT_MAX),
    industryVertical: cleanString(input.industryVertical, NAME_MAX),
    channels: sanitizeChannels(input.channels),
    messaging: sanitizeMessaging(input.messaging),
    ...(sanitizeBudget(input.budget) ? { budget: sanitizeBudget(input.budget) } : {}),
    ...(sanitizeUtm(input.utm) ? { utm: sanitizeUtm(input.utm) } : {}),
    status: 'draft',
    kernelStale: false,
    version: 1,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await briefs.put(brief);
  recordBriefAction('created', brief, createdBy);
  return brief;
}

/** Patch a brief. Any content change to a brief that already has a kernel marks
 *  it stale (the kernel must be regenerated). */
/** Order-insensitive JSON for the protected-field diff (BRIEF-1): object keys are
 *  sorted recursively so a re-send with reordered keys (the request/`sanitize*`
 *  insertion order in `budget.perChannel`, the open `channel.config` records, and
 *  `messaging`) does NOT spuriously demote a confirmed brief. Arrays keep their
 *  order — a real reorder still counts as a change. Never misses a real change. */
function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = norm(o[k]); return acc; }, {});
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** The brief fields whose post-approval edit forces a new approval cycle
 *  (campaign gap plan §5B B4 — "protected-field re-approval"). */
/** ADR 0351 P2 — parse/validate the grounding policy; invalid values → 400
 *  (never silently coerced: a mistyped 'strict' must not run best-effort). */
function parseGroundingPolicy(v: unknown): 'off' | 'best-effort' | 'strict' | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === 'off' || v === 'best-effort' || v === 'strict') return v;
  throw new OpenwopError('validation_error', '`groundingPolicy` MUST be one of off | best-effort | strict.', 400, { field: 'groundingPolicy' });
}

/** ADR 0355 P5 — ≤10 bounded competitor names; junk dropped. */
function parseCompetitors(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 80)).slice(0, 10);
  return out.length > 0 ? out : undefined;
}

const PROTECTED_CONTENT_FIELDS = ['name', 'objective', 'brandId', 'personaIds', 'kbCollectionId', 'productName', 'productDescription', 'industryVertical', 'channels', 'messaging', 'budget'] as const;

export async function updateBrief(tenantId: string, briefId: string, input: BriefInput, actor = 'system'): Promise<CampaignBrief | null> {
  const existing = await getBrief(tenantId, briefId);
  if (!existing) return null;
  const next: CampaignBrief = {
    ...existing,
    name: input.name !== undefined ? cleanString(input.name, NAME_MAX) || existing.name : existing.name,
    objective: input.objective !== undefined ? cleanString(input.objective, TEXT_MAX) : existing.objective,
    brandId: input.brandId !== undefined ? optionalCleanString(input.brandId, NAME_MAX) : existing.brandId,
    personaIds: input.personaIds !== undefined ? idList(input.personaIds) : existing.personaIds,
    kbCollectionId: input.kbCollectionId !== undefined ? optionalCleanString(input.kbCollectionId, NAME_MAX) : existing.kbCollectionId,
    groundingPolicy: input.groundingPolicy !== undefined ? parseGroundingPolicy(input.groundingPolicy) : existing.groundingPolicy,
    competitors: input.competitors !== undefined ? parseCompetitors(input.competitors) : existing.competitors,
    productName: input.productName !== undefined ? cleanString(input.productName, NAME_MAX) : existing.productName,
    productDescription: input.productDescription !== undefined ? cleanString(input.productDescription, TEXT_MAX) : existing.productDescription,
    industryVertical: input.industryVertical !== undefined ? cleanString(input.industryVertical, NAME_MAX) : existing.industryVertical,
    channels: input.channels !== undefined ? sanitizeChannels(input.channels) : existing.channels,
    messaging: input.messaging !== undefined ? sanitizeMessaging(input.messaging) : existing.messaging,
    budget: input.budget !== undefined ? sanitizeBudget(input.budget) : existing.budget,
    utm: input.utm !== undefined ? sanitizeUtm(input.utm) : existing.utm,
    status: input.status === 'confirmed' || input.status === 'validated' || input.status === 'draft' ? input.status : existing.status,
    updatedAt: new Date().toISOString(),
  };
  const contentChanged = PROTECTED_CONTENT_FIELDS.some(
    (f) => canonicalJson(existing[f] ?? null) !== canonicalJson(next[f] ?? null),
  );
  // Any content edit invalidates an existing kernel.
  if (existing.kernel && contentChanged) next.kernelStale = true;
  // Protected-field re-approval (B4): a content edit to a validated/confirmed
  // brief demotes it to draft — revalidation + a fresh kernel approval are then
  // structurally required by the orchestration gates. The demotion wins over a
  // status supplied in the same patch.
  let demoted = false;
  if (contentChanged && existing.status !== 'draft') {
    next.status = 'draft';
    demoted = true;
  }
  if (contentChanged) {
    await snapshotBrief(existing, actor); // pin the pre-edit revision
    next.version = (existing.version ?? 1) + 1;
  }
  await briefs.put(next);
  // Audit/event bookkeeping. A status RAISE to validated/confirmed fires
  // independently of the content branch (grade-code AUDIT-11): a draft set to
  // confirmed in the SAME patch as a content edit used to fall through to
  // 'updated' only — the confirmation audit row and `host.campaign.brief.confirmed`
  // event (and any workflow bound to it) silently vanished.
  const statusRaised = !demoted && next.status !== existing.status && (next.status === 'validated' || next.status === 'confirmed');
  if (demoted) {
    recordBriefAction('reapproval-required', next, actor, { editedFrom: existing.status });
  } else if (contentChanged) {
    recordBriefAction('updated', next, actor);
  }
  if (statusRaised) {
    recordBriefAction(next.status, next, actor);
    if (next.status === 'confirmed') await snapshotBrief(next, actor); // pin the approved revision
  }
  return next;
}

/** Duplicate a brief as a fresh DRAFT (C8 "use as template"): copies the
 *  content fields, drops the kernel + status + version history. */
export async function duplicateBrief(tenantId: string, briefId: string, actor: string, name?: string): Promise<CampaignBrief | null> {
  const src = await getBrief(tenantId, briefId);
  if (!src) return null;
  const now = new Date().toISOString();
  const copy: CampaignBrief = {
    ...src,
    id: randomUUID(),
    name: cleanString(name, NAME_MAX) || `${src.name} (copy)`,
    status: 'draft',
    kernelStale: false,
    version: 1,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  delete copy.kernel;
  await briefs.put(copy);
  recordBriefAction('created', copy, actor, { duplicatedFrom: src.id });
  return copy;
}

export async function deleteBrief(tenantId: string, briefId: string, actor = 'system'): Promise<boolean> {
  const existing = await getBrief(tenantId, briefId);
  if (!existing) return false;
  const deleted = await briefs.delete(tenantKey(tenantId, briefId));
  if (deleted) {
    recordBriefAction('deleted', existing, actor);
    // Revisions of a deleted brief are dead weight — drop them.
    for (const v of await listBriefVersions(tenantId, briefId)) await briefVersions.delete(v.versionId);
    // ADR 0403 — the brief's market-intel artifacts cascade with it (evidence
    // + angles are brief-scoped; the ORG-scoped hook bank deliberately survives).
    await deleteVocForBrief(tenantId, briefId);
    await deleteAnglesForBrief(tenantId, briefId);
    await deleteTargetingForBrief(tenantId, briefId);
  }
  return deleted;
}

/** Persist a generated kernel (called from the Phase-3 surface). Clears stale.
 *  R2 CB-SP-9 — persisting a kernel used to FORCE-promote `status:'validated'`
 *  unconditionally, so a brief failing its own validation (no persona, no value
 *  prop, zero channels) was promoted purely by model output — while the tool,
 *  pack, and prompt all advertise that generation never auto-approves. The
 *  promotion is now gated on the brief actually validating; an invalid brief
 *  keeps its status (the kernel still saves — it is reviewable content, and the
 *  approval gate + finalize remain the human acts). */
export async function setKernel(tenantId: string, briefId: string, kernel: MessagingKernel, actor = 'system'): Promise<CampaignBrief | null> {
  const existing = await getBrief(tenantId, briefId);
  if (!existing) return null;
  const validates = validateBrief(existing).valid;
  const next: CampaignBrief = { ...existing, kernel, kernelStale: false, ...(validates ? { status: 'validated' as const } : {}), updatedAt: new Date().toISOString() };
  await briefs.put(next);
  recordBriefAction(validates ? 'validated' : 'kernel_saved', next, actor, { kernelGeneratedAt: kernel.generatedAt });
  return next;
}

/** Validate brief completeness + compute the enabled channel set. Pure. */
export function validateBrief(brief: CampaignBrief): BriefValidationResult {
  const issues: BriefValidationResult['issues'] = [];
  if (!brief.name.trim()) issues.push({ field: 'name', message: 'A campaign name is required.' });
  if (!brief.productName.trim()) issues.push({ field: 'productName', message: 'A product is required.' });
  if (brief.personaIds.length === 0) issues.push({ field: 'personaIds', message: 'At least one persona is required.' });
  if (!brief.messaging.primaryValueProp.trim()) issues.push({ field: 'messaging.primaryValueProp', message: 'A primary value proposition is required.' });
  const enabledChannels: CampaignChannel[] = brief.channels.filter((c) => c.enabled).map((c) => c.type);
  if (enabledChannels.length === 0) issues.push({ field: 'channels', message: 'Enable at least one channel.' });
  return { valid: issues.length === 0, issues, enabledChannels };
}

/** Test-only: drop every brief. */
export async function __clearBriefs(): Promise<void> {
  await briefs.__clear();
}

/**
 * ADR 0351 Phase 3 — a KB source document changed: flag every brief in the
 * tenant whose GENERATED kernel cites it (`kernel.sourceDocIds`), so the UI's
 * existing kernelStale affordance ("regenerate") surfaces the drift. Returns
 * the affected briefs (the caller emits notifications — service stays
 * notification-free). Idempotent: already-stale briefs are skipped.
 */
export async function markKernelsStaleForDoc(tenantId: string, documentId: string): Promise<CampaignBrief[]> {
  const affected: CampaignBrief[] = [];
  // Tenant-scoped prefix scan (KB-CODE-7) — brief keys are `${tenantId}::${id}`,
  // so this reads ONE tenant's rows, not the whole table. The tenant filter
  // stays as a defensive invariant.
  const all = (await briefs.listByPrefix(`${tenantId}::`)).filter((b) => b.tenantId === tenantId);
  for (const b of all) {
    if (!b.kernel || b.kernelStale) continue;
    if (!Array.isArray(b.kernel.sourceDocIds) || !b.kernel.sourceDocIds.includes(documentId)) continue;
    const next: CampaignBrief = { ...b, kernelStale: true, updatedAt: new Date().toISOString() };
    await briefs.put(next);
    affected.push(next);
  }
  return affected;
}
