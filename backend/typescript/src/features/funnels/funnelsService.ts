/**
 * Funnels service (ADR 0294 / Funnel A, Phase 1) — the funnel entity: an ordered
 * path of steps, each bound to a CMS page. A funnel is a thin COMPOSITION layer:
 * pages stay owned by the CMS (ADR 0009 — steps hold `pageId` refs validated via
 * `cmsService.getPage`, never a second page model), public serving arrives in
 * Phase 2 via the publishing gate (ADR 0012), analytics in Phase 3 over the CDP
 * event spine, experiments in Phase 4 via the shared variant assigner (ADR 0236).
 *
 * Lifecycle: draft → published → archived. Publishing requires ≥1 step and every
 * step's page to resolve; it does NOT require the pages themselves to be
 * published — that is the SERVING gate (Phase 2 serves only published pages, the
 * ADR 0012 rule), so an operator can wire a funnel before the content ships.
 * Slug is immutable while published (the CMS slug rule). Deletion is a hard
 * delete: nothing references a funnel yet; once orders stamp `funnelId`
 * (Phase 3 / ADR 0296) those stamps are historical provenance — tolerate-on-read
 * per the lifecycle-seam taxonomy, so hard delete stays correct.
 *
 * @see docs/adr/0294-funnel-a-funnel-entity-builder-analytics.md
 */
import { isInternalHref } from '../../host/internalHref.js';
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanContent, cleanString } from '../../host/boundedStrings.js';
import { assignArm } from '../../host/experiments/assign.js';
import { stickyAssign } from '../../host/experiments/sticky.js';
import { assignAt } from '../../host/experiments/runFreeze.js';
import { getExperimentRow } from '../../host/experiments/store.js';
import { isFullStepExperiment, isManagedExperiment, linkedStepExperiment, releaseStepExperiment, resolveStepExperiment, storesAsPointer, saveStepExperiment, stepAssignmentScope, stepToEngine } from './stepExperimentsEngine.js';
import { isNonRootWorkspaceOrg } from '../../host/accessControlService.js';
import { getProduct } from '../commerce/commerceService.js';
import { getCampaign } from '../campaign-orchestration/campaignService.js';
import { resolveStorefrontSettlement } from '../commerce-connect/storefrontSettlement.js';
import { getPage } from '../cms/cmsService.js';
import { getMarketingEvent } from '../webinars/entities/marketingEvent.js';
import { getForm } from '../forms/formsService.js';
import { getDomain, isServingDomain, normalizeHostname } from '../../host/customDomains.js';
import { STEP_OUTCOMES, type StepOutcome, type StepRule } from './funnelRouting.js';

const nowIso = (): string => new Date().toISOString();
const MAX = { name: 200, slug: 80, stepName: 120, steps: 20, perOrg: 200, rulesPerStep: 10, utm: 200, variants: 4, variantKey: 40 } as const;

export const FUNNEL_STEP_KINDS = ['landing', 'optin', 'sales', 'checkout', 'upsell', 'downsell', 'thankyou', 'webinar', 'application'] as const;
/** ADR 0948 D4 — kinds whose routing outcome the SERVER derives (never the visitor). */
/** Kinds whose routing outcome only the server decides (a client `outcome` is refused):
 *  webinar/application (ADR 0948 D4) and the post-purchase offers (P2c, from the step's
 *  recorded decision). */
export const SERVER_OUTCOME_KINDS: readonly FunnelStepKind[] = ['webinar', 'application', 'upsell', 'downsell'];
export type FunnelStepKind = (typeof FUNNEL_STEP_KINDS)[number];
export const FUNNEL_STATUSES = ['draft', 'published', 'archived'] as const;
export type FunnelStatus = (typeof FUNNEL_STATUSES)[number];

export interface FunnelStep {
  stepId: string;
  kind: FunnelStepKind;
  /** The CMS page this step renders (ADR 0009 — validated, never duplicated). */
  pageId: string;
  /** Optional operator label; defaults to the kind in UIs. */
  name?: string;
  /** Phase 2 — conditional next-step rules (pure evaluation, funnelRouting.ts);
   *  absent ⇒ sequential. `goto` validated against sibling stepIds at write. */
  routing?: StepRule[];
  /** Phase 4 — per-step split test (the ADR 0236 model on funnel steps):
   *  variants bind CMS pages; `pageId: null` = the HOLDOUT (this step's own
   *  page). Assignment = the SHARED salted sticky bucketer with the
   *  funnel-scoped unit; salt fixed at creation. */
  experiment?: StepExperiment;
  /** ADR 0948 D1/D2 — what this step sells. checkout | upsell | downsell only;
   *  every product is validated against THIS org's catalog at write, and the
   *  public checkout refuses anything outside it. */
  offer?: FunnelOffer;
  /** ADR 0948 D4 — `webinar` only: the webinars MarketingEvent (same org) this step
   *  registers for. Its registration form is the event's bound form. */
  webinar?: { marketingEventId: string };
  /** ADR 0948 D4 — `application` only: the form (same org) the applicant fills. */
  application?: { formId: string };
}

/** ADR 0948 D1 — a money step's offer (ADR 0410 products, org-checked). */
export interface FunnelOffer {
  /** 1..5 — what the step sells. */
  productIds: string[];
  /** 0..5, checkout only — the order bumps the checkout may add (ADR 0296). */
  bumpProductIds?: string[];
  /** upsell/downsell only — the ONE product a one-click accept may charge. */
  oneClickProductId?: string;
}

/** The step kinds that take money: an offer belongs on these, and a client org
 *  cannot publish them until its own settlement is live (ADR 0948 D8). */
export const MONEY_STEP_KINDS: readonly FunnelStepKind[] = ['checkout', 'upsell', 'downsell'];

export interface StepExperimentVariant {
  key: string;
  /** A CMS pageId, or null = the holdout (the step's own page). */
  pageId: string | null;
  /** Integer percentage 1..100; the set sums to exactly 100. */
  weight: number;
}

export interface StepExperiment {
  /** ADR 0949 P4 — internal: the engine row is an Optimize experiment. */
  engineMode?: 'optimize' | 'ramp';
  experimentId: string;
  status: 'running' | 'stopped';
  /** Fixed at creation so assignment stays sticky for the experiment's life. */
  salt: string;
  variants: StepExperimentVariant[];
  createdAt: string;
  stoppedAt?: string;
}

export interface Funnel {
  funnelId: string;
  tenantId: string;
  orgId: string;
  name: string;
  /** Org-unique among non-archived funnels; the public path segment (Phase 2). */
  slug: string;
  status: FunnelStatus;
  steps: FunnelStep[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  /** VP-R2-3 (FN-G5) — the operator-authored "what now" for a finished funnel:
   *  exactly ONE CTA on the complete state (the single-CTA thank-you
   *  convention). Optional; absent keeps today's plain complete card. */
  completionCta?: { label: string; url: string };
  /** ADR 0948 D1 — the canonical campaign (ADR 0941 `MarketingCampaign.id`) this
   *  funnel serves. Same tenant AND org, validated at write. */
  campaignId?: string;
  /** Host-only receipts live on the same primary row as the page pointer.
   * They survive step edits/removal, so a late retry cannot reopen a rollback. */
  promotionReceipts?: Record<string, { stepId: string; winnerRef: string | null; baselineRef: string; outcome: 'finalized' | 'rolled_back' }>;
  /** ADR 0948 D7 / P6a — a live custom domain of THIS org the funnel's public links
   *  will use once funnels are served on custom domains (P6b). `funnelPublicUrl`
   *  falls back to the platform URL until then, or whenever the domain stops serving. */
  primaryHostname?: string;
}

const funnels = new DurableCollection<Funnel>('funnels:funnel', (f) => f.funnelId, undefined, (f) => f.tenantId);

// ── ADR 0949 P2c — a stored step experiment is a POINTER ─────────────────────
//
// The engine (`host/experiments/`) holds a step's experiment. A stored step
// carries the pointer `{ experimentId }` (A2), or the full copy when the row
// predates A2 or the engine does not hold it for this step. Every read hydrates
// the step from the engine, so callers, the API and the SPA always see the full
// `StepExperiment`. A pointer the engine does not hold is dropped, never shown
// as a stub, and the next write leaves it out.
//
// A write stores the pointer (`dehydrate`) for a legacy step split, which A1
// (the rollback floor, ADR 0949 P2c) reads. A managed experiment keeps the full
// copy until A3: it can end with no funnel write, and A1 drops a pointer to an
// ended experiment. A revision older than A1 would read the pointer as the
// experiment. A funnel read here is hydrated, so
// `casFunnel` compares against the row as stored, which `rawRows` remembers.

const rawRows = new WeakMap<Funnel, Funnel>();
const storedRow = (f: Funnel): Funnel => rawRows.get(f) ?? f;

async function hydrate(f: Funnel): Promise<Funnel> {
  if (!f.steps.some((st) => st.experiment)) return f;
  const steps = await Promise.all(f.steps.map(async (st) => {
    if (!st.experiment) return st;
    const { experimentId } = st.experiment;
    const exp = await resolveStepExperiment(f.tenantId, f.orgId, f.funnelId, st.stepId, st.experiment);
    if (exp) return { ...st, experiment: exp };
    // The engine's view before the copy's: a copy can still say `running` for an
    // experiment the engine has since ended.
    const linked = await linkedStepExperiment(f.tenantId, f.orgId, f.funnelId, st.stepId, experimentId);
    if (linked) return { ...st, experiment: linked };
    if (isFullStepExperiment(st.experiment)) return st; // as before: the copy the step holds
    const { experiment: _gone, ...rest } = st;
    return rest;
  }));
  const out: Funnel = { ...f, steps };
  rawRows.set(out, f);
  return out;
}

/** The pointer a stored step carries. The stored shape is narrower than
 *  `StepExperiment`; no reader sees it, because every read hydrates. */
const pointerTo = (experimentId: string): StepExperiment => ({ experimentId } as StepExperiment);

/** The row as stored: a step's experiment becomes its pointer only where the
 *  rollback floor (A2) reads that pointer back as the experiment the step shows
 *  (`storesAsPointer`). Otherwise the copy is kept whole. */
async function dehydrate(f: Funnel): Promise<Funnel> {
  if (!f.steps.some((st) => st.experiment && isFullStepExperiment(st.experiment))) return f;
  const steps = await Promise.all(f.steps.map(async (st) => {
    if (!st.experiment || !isFullStepExperiment(st.experiment)) return st;
    const { experimentId } = st.experiment;
    return (await storesAsPointer(f.tenantId, f.orgId, f.funnelId, st.stepId, experimentId)) ? { ...st, experiment: pointerTo(experimentId) } : st;
  }));
  return { ...f, steps };
}

/** CAS `next` (hydrated) over `expected` (a read), storing the pointer form. */
async function swapStored(expected: Funnel, next: Funnel): Promise<boolean> {
  const stored = await dehydrate(next);
  if (!(await funnels.compareAndSwap(storedRow(expected), stored))) return false;
  rawRows.set(next, stored);
  return true;
}

async function casFunnel(expected: Funnel, next: Funnel): Promise<void> {
  if (await swapStored(expected, next)) return;
  throw new OpenwopError('conflict', 'The funnel changed while this change was being saved. Reload and retry.', 409,
    { reason: 'funnel_changed', funnelId: expected.funnelId });
}

// ── Reads ─────────────────────────────────────────────────────────────────────
async function listFunnelRows(tenantId: string, orgId: string): Promise<Funnel[]> {
  return (await funnels.listForTenantIndexed(tenantId))
    .filter((f) => f.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.funnelId.localeCompare(b.funnelId));
}

export async function listFunnels(tenantId: string, orgId: string): Promise<Funnel[]> {
  return Promise.all((await listFunnelRows(tenantId, orgId)).map(hydrate));
}

export async function getFunnel(tenantId: string, orgId: string, funnelId: string): Promise<Funnel | null> {
  const f = await funnels.get(funnelId);
  return f && f.tenantId === tenantId && f.orgId === orgId ? hydrate(f) : null;
}

/**
 * ADR 0948 D2 — the step a public checkout or one-click names, from a PUBLISHED
 * funnel of THIS tenant AND org, and only of the given kinds. Every miss — no
 * such funnel, another org's, a draft, no such step, the wrong kind — is the same
 * 400, so the public route is no oracle for funnels or steps.
 */
export async function resolvePublishedFunnelStep(
  tenantId: string, orgId: string, ref: unknown, kinds: readonly FunnelStepKind[],
): Promise<FunnelStep> {
  const r = (ref ?? {}) as { funnelId?: unknown; stepId?: unknown };
  const funnelId = typeof r.funnelId === 'string' ? r.funnelId.trim() : '';
  const stepId = typeof r.stepId === 'string' ? r.stepId.trim() : '';
  const f = funnelId && stepId ? await getFunnel(tenantId, orgId, funnelId) : null;
  const step = f && f.status === 'published' ? f.steps.find((st) => st.stepId === stepId) : undefined;
  if (!step || !kinds.includes(step.kind)) {
    throw new OpenwopError('validation_error', 'That funnel step is not available.', 400, { code: 'funnel_step_not_found', field: 'funnel' });
  }
  return step;
}

/** Phase-2 seam: resolve a PUBLISHED funnel by its public slug. Only the funnel
 *  found is hydrated (this is the public read path). */
export async function getPublishedFunnelBySlug(tenantId: string, orgId: string, slug: string): Promise<Funnel | null> {
  const found = (await listFunnelRows(tenantId, orgId)).find((f) => f.status === 'published' && f.slug === slug);
  return found ? hydrate(found) : null;
}

// ── Validation ────────────────────────────────────────────────────────────────
function coerceSlug(raw: unknown, fallbackName: string): string {
  const source = typeof raw === 'string' && raw.trim() ? raw : fallbackName;
  const slug = source.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX.slug);
  if (!slug) throw new OpenwopError('validation_error', 'A funnel slug is required.', 400, { field: 'slug' });
  return slug;
}

async function assertSlugFree(tenantId: string, orgId: string, slug: string, exceptFunnelId?: string): Promise<void> {
  const clash = (await listFunnelRows(tenantId, orgId))
    .find((f) => f.status !== 'archived' && f.slug === slug && f.funnelId !== exceptFunnelId);
  if (clash) throw new OpenwopError('validation_error', `A funnel with slug "${slug}" already exists.`, 400, { field: 'slug' });
}

function coerceKind(v: unknown): FunnelStepKind {
  if ((FUNNEL_STEP_KINDS as readonly string[]).includes(String(v))) return String(v) as FunnelStepKind;
  throw new OpenwopError('validation_error', `step.kind must be one of: ${FUNNEL_STEP_KINDS.join(', ')}`, 400, { field: 'steps' });
}

/** One routing rule, bounds + vocabulary checked (goto membership is a second pass). */
function coerceRule(raw: unknown): StepRule {
  const o = (raw ?? {}) as { when?: unknown; goto?: unknown };
  const goto = typeof o.goto === 'string' ? o.goto.trim() : '';
  if (!goto) throw new OpenwopError('validation_error', 'Every routing rule needs a goto stepId.', 400, { field: 'steps' });
  if (o.when === undefined) return { goto };
  const w = (o.when ?? {}) as { outcome?: unknown; utm?: unknown };
  const when: StepRule['when'] = {};
  if (w.outcome !== undefined) {
    if (!(STEP_OUTCOMES as readonly string[]).includes(String(w.outcome))) {
      throw new OpenwopError('validation_error', `rule outcome must be one of: ${STEP_OUTCOMES.join(', ')}`, 400, { field: 'steps' });
    }
    when.outcome = String(w.outcome) as StepOutcome;
  }
  if (w.utm !== undefined) {
    const u = (w.utm ?? {}) as { key?: unknown; value?: unknown };
    const key = cleanContent(u.key, MAX.utm, 'utm.key');
    const value = cleanContent(u.value, MAX.utm, 'utm.value');
    if (!key || !value) throw new OpenwopError('validation_error', 'A utm rule needs key and value.', 400, { field: 'steps' });
    when.utm = { key, value };
  }
  if (when.outcome === undefined && when.utm === undefined) return { goto };
  return { when, goto };
}

const MAX_OFFER_PRODUCTS = 5;

/** ADR 0948 — ids from a client array: strings, trimmed, de-duplicated, bounded. */
function coerceIdList(raw: unknown, field: string, max: number): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', `${field} must be an array of product ids.`, 400, { field });
  const ids = [...new Set(raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean))];
  if (ids.length !== raw.length) throw new OpenwopError('validation_error', `${field} must be distinct, non-empty product ids.`, 400, { field });
  if (ids.length > max) throw new OpenwopError('validation_error', `${field} may list at most ${max} products.`, 400, { field });
  return ids;
}

/**
 * ADR 0948 D1/D2 — validate a step's offer: only on money steps, bumps only on
 * checkout, the one-click product only on upsell/downsell, and EVERY product an
 * ACTIVE product of THIS tenant AND org (`getProduct` is org-checked; a product
 * of another org reads as missing — uniform 404, no existence oracle).
 */
async function coerceOffer(tenantId: string, orgId: string, kind: FunnelStepKind, raw: unknown): Promise<FunnelOffer | undefined> {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new OpenwopError('validation_error', 'offer must be an object.', 400, { field: 'offer' });
  if (!MONEY_STEP_KINDS.includes(kind)) {
    throw new OpenwopError('validation_error', `An offer belongs on a checkout, upsell or downsell step, not a ${kind} step.`, 400, { field: 'offer' });
  }
  const o = raw as { productIds?: unknown; bumpProductIds?: unknown; oneClickProductId?: unknown };
  const productIds = coerceIdList(o.productIds, 'offer.productIds', MAX_OFFER_PRODUCTS);
  if (productIds.length === 0) throw new OpenwopError('validation_error', 'An offer needs at least one product.', 400, { field: 'offer.productIds' });
  const bumpProductIds = coerceIdList(o.bumpProductIds, 'offer.bumpProductIds', MAX_OFFER_PRODUCTS);
  if (bumpProductIds.length > 0 && kind !== 'checkout') {
    throw new OpenwopError('validation_error', 'Order bumps belong on the checkout step.', 400, { field: 'offer.bumpProductIds' });
  }
  const oneClick = typeof o.oneClickProductId === 'string' ? o.oneClickProductId.trim() : '';
  if (o.oneClickProductId !== undefined && o.oneClickProductId !== null && !oneClick) {
    throw new OpenwopError('validation_error', 'offer.oneClickProductId must be a product id.', 400, { field: 'offer.oneClickProductId' });
  }
  if (oneClick && kind === 'checkout') {
    throw new OpenwopError('validation_error', 'A one-click product belongs on an upsell or downsell step.', 400, { field: 'offer.oneClickProductId' });
  }
  for (const productId of new Set([...productIds, ...bumpProductIds, ...(oneClick ? [oneClick] : [])])) {
    const p = await getProduct(tenantId, orgId, productId);
    if (!p || !p.active) throw new OpenwopError('not_found', `Offer product not found in this workspace: ${productId}`, 404, { field: 'offer' });
  }
  return { productIds, ...(bumpProductIds.length ? { bumpProductIds } : {}), ...(oneClick ? { oneClickProductId: oneClick } : {}) };
}

/**
 * ADR 0948 D1 — `undefined` leaves the link unchanged, `null` clears it, a string
 * must name a campaign of THIS tenant AND org. `getCampaign` checks only the
 * tenant, so the org is compared here; any miss is the same 404.
 */
async function coerceCampaignId(tenantId: string, orgId: string, raw: unknown): Promise<string | null | undefined> {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const campaignId = typeof raw === 'string' ? raw.trim() : '';
  if (!campaignId || campaignId.length > 200) throw new OpenwopError('validation_error', 'campaignId must be a campaign id.', 400, { field: 'campaignId' });
  const c = await getCampaign(tenantId, campaignId);
  if (!c || c.orgId !== orgId) throw new OpenwopError('not_found', 'Campaign not found.', 404, { field: 'campaignId' });
  return campaignId;
}

/**
 * ADR 0948 D8 (David, 2026-10-19, #5038) — a client org of an agency workspace
 * settles through its OWN Connect seller, so a money step there may not go live
 * until that seller can take a charge. The question is asked of the ONE settlement
 * resolver (ADR 0877), never re-derived. Architect call (recorded in the ADR): a
 * host with no Stripe key (`demo/no_key`) can take no money from anyone, so it
 * does not block; every other non-`connect` lane does.
 */
export async function assertClientSettlement(tenantId: string, orgId: string, steps: readonly FunnelStep[]): Promise<void> {
  if (!isNonRootWorkspaceOrg(tenantId, orgId)) return;
  if (!steps.some((st) => MONEY_STEP_KINDS.includes(st.kind))) return;
  const lane = await resolveStorefrontSettlement(tenantId, orgId);
  if (lane.kind === 'connect' || (lane.kind === 'demo' && lane.reason === 'no_key')) return;
  throw new OpenwopError(
    'conflict',
    'This client has not finished setting up payments, so a funnel with checkout, upsell or downsell steps cannot go live yet.',
    409,
    { code: 'client_settlement_unconfirmed', lane: lane.kind, ...(lane.kind === 'demo' ? { reason: lane.reason } : {}) },
  );
}

/** ADR 0948 D4 — a binding is allowed only on its own kind and must name a record of
 *  THIS org (a miss is the same answer as another org's id). `null`/absent = none. */
async function coerceWebinarBinding(tenantId: string, orgId: string, kind: FunnelStepKind, raw: unknown): Promise<FunnelStep['webinar'] | undefined> {
  if (raw === undefined || raw === null) return undefined;
  if (kind !== 'webinar') throw new OpenwopError('validation_error', 'Only a webinar step can bind a webinar.', 400, { field: 'steps' });
  const id = typeof (raw as { marketingEventId?: unknown }).marketingEventId === 'string' ? (raw as { marketingEventId: string }).marketingEventId.trim() : '';
  if (!id || !(await getMarketingEvent(tenantId, orgId, id))) {
    throw new OpenwopError('validation_error', 'Webinar not found in this organization.', 400, { field: 'steps' });
  }
  return { marketingEventId: id };
}
async function coerceApplicationBinding(tenantId: string, orgId: string, kind: FunnelStepKind, raw: unknown): Promise<FunnelStep['application'] | undefined> {
  if (raw === undefined || raw === null) return undefined;
  if (kind !== 'application') throw new OpenwopError('validation_error', 'Only an application step can bind an application form.', 400, { field: 'steps' });
  const id = typeof (raw as { formId?: unknown }).formId === 'string' ? (raw as { formId: string }).formId.trim() : '';
  if (!id || !(await getForm(tenantId, orgId, id))) {
    throw new OpenwopError('validation_error', 'Form not found in this organization.', 400, { field: 'steps' });
  }
  return { formId: id };
}

/** ADR 0948 P6a — a primary hostname must be a SERVING custom domain of this org
 *  (hostnames are global keys, so `getDomain` also checks tenant + org). `null` or ''
 *  clears it. */
async function coercePrimaryHostname(tenantId: string, orgId: string, raw: unknown): Promise<string | null> {
  if (raw === null || raw === '') return null;
  const host = normalizeHostname(raw);
  const d = await getDomain(tenantId, orgId, host);
  if (!d || !isServingDomain(d)) throw new OpenwopError('validation_error', 'That domain is not a live custom domain of this organization.', 400, { field: 'primaryHostname' });
  return d.hostname;
}

/** Whether funnels are served on custom domains on this host. Not yet: the
 *  custom-domain funnel document is ADR 0948 P6b (after the edge-ownership ADR). */
const CUSTOM_DOMAIN_FUNNELS_SERVED = false;

/** ADR 0948 D7 / P6a — the ONE public URL of a funnel. The platform viewer
 *  (`/fn/:orgId/:slug`) unless the funnel names a primary hostname that is still
 *  serving AND custom-domain funnels are served here; never a URL that would not work. */
export async function funnelPublicUrl(f: Pick<Funnel, 'tenantId' | 'orgId' | 'slug' | 'primaryHostname'>, platformBase: string): Promise<string> {
  const platform = `${platformBase.replace(/\/+$/, '')}/fn/${encodeURIComponent(f.orgId)}/${encodeURIComponent(f.slug)}`;
  if (!CUSTOM_DOMAIN_FUNNELS_SERVED || !f.primaryHostname) return platform;
  const d = await getDomain(f.tenantId, f.orgId, f.primaryHostname);
  return d && isServingDomain(d) ? `https://${d.hostname}/f/${encodeURIComponent(f.slug)}` : platform;
}

/** Validate the steps array: kinds legal, pages resolve for THIS tenant+org (IDOR guard). */
async function coerceSteps(tenantId: string, orgId: string, raw: unknown): Promise<FunnelStep[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', 'steps must be an array.', 400, { field: 'steps' });
  if (raw.length > MAX.steps) throw new OpenwopError('validation_error', `A funnel may have at most ${MAX.steps} steps.`, 400, { field: 'steps' });
  const steps: FunnelStep[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as { stepId?: unknown; kind?: unknown; pageId?: unknown; name?: unknown; routing?: unknown; offer?: unknown; webinar?: unknown; application?: unknown };
    const kind = coerceKind(o.kind);
    const pageId = typeof o.pageId === 'string' ? o.pageId.trim() : '';
    if (!pageId) throw new OpenwopError('validation_error', 'Every step needs a pageId.', 400, { field: 'steps' });
    if (!(await getPage(tenantId, orgId, pageId))) {
      throw new OpenwopError('validation_error', `Step page not found in this workspace: ${pageId}`, 400, { field: 'steps' });
    }
    const name = cleanString(o.name, MAX.stepName) || undefined;
    let routing: StepRule[] | undefined;
    if (o.routing !== undefined) {
      if (!Array.isArray(o.routing)) throw new OpenwopError('validation_error', 'routing must be an array of rules.', 400, { field: 'steps' });
      if (o.routing.length > MAX.rulesPerStep) throw new OpenwopError('validation_error', `A step may have at most ${MAX.rulesPerStep} routing rules.`, 400, { field: 'steps' });
      routing = o.routing.map(coerceRule);
      if (routing.length === 0) routing = undefined;
    }
    const offer = await coerceOffer(tenantId, orgId, kind, o.offer);
    const webinar = await coerceWebinarBinding(tenantId, orgId, kind, o.webinar);
    const application = await coerceApplicationBinding(tenantId, orgId, kind, o.application);
    steps.push({
      stepId: typeof o.stepId === 'string' && o.stepId.trim() ? o.stepId.trim() : randomUUID(),
      kind, pageId, ...(name ? { name } : {}), ...(routing ? { routing } : {}), ...(offer ? { offer } : {}),
      ...(webinar ? { webinar } : {}), ...(application ? { application } : {}),
    });
  }
  const ids = new Set(steps.map((s) => s.stepId));
  if (ids.size !== steps.length) throw new OpenwopError('validation_error', 'Duplicate stepId in steps.', 400, { field: 'steps' });
  // Second pass: every goto must reference a sibling step (no dangling routes).
  for (const s of steps) {
    for (const rule of s.routing ?? []) {
      if (!ids.has(rule.goto)) {
        throw new OpenwopError('validation_error', `Routing rule goto references an unknown step: ${rule.goto}`, 400, { field: 'steps' });
      }
    }
  }
  return steps;
}

// ── Writes ────────────────────────────────────────────────────────────────────
export interface FunnelCreateInput {
  tenantId: string; orgId: string; createdBy: string;
  name: unknown; slug?: unknown; steps?: unknown;
  /** ADR 0948 D1 — optional link to a same-org canonical campaign. */
  campaignId?: unknown;
  /** ADR 0948 P1 — a server-DERIVED id (the workflow surface, from the run's
   *  tenant + run id + node key). Never taken from a request body: the collection
   *  is keyed on `funnelId` alone, across tenants. */
  funnelId?: string;
}

/** ADR 0948 P1 — the deterministic id a run's `create` node gets. The tenant is in
 *  the hash, so two tenants can never derive the same id. */
export function runFunnelId(tenantId: string, runId: string, key: string): string {
  return `fn_${createHash('sha256').update(`${tenantId}\u0000${runId}\u0000${key}`).digest('hex').slice(0, 32)}`;
}

/** The (kind, pageId) shape of a step list, for comparing a raw create input with
 *  a stored funnel (stored step ids are minted, so they cannot be compared). */
function stepShape(steps: unknown): string {
  if (!Array.isArray(steps)) return '';
  return steps.map((st) => {
    const o = (st ?? {}) as { kind?: unknown; pageId?: unknown };
    return `${typeof o.kind === 'string' ? o.kind.trim() : ''}:${typeof o.pageId === 'string' ? o.pageId.trim() : ''}`;
  }).join('|');
}

/** The existing row for a derived id. Returned only when it is the SAME create
 *  re-delivered: same tenant and org, still a draft, same name, campaign and steps.
 *  Anything else is refused, never a success carrying a stale or live funnel
 *  (a node run twice in one run with new inputs, or a draft published since). */
function sameRunFunnel(existing: Funnel, input: FunnelCreateInput): Funnel {
  if (existing.tenantId !== input.tenantId || existing.orgId !== input.orgId) {
    throw new OpenwopError('conflict', 'A funnel with this id already exists.', 409, {});
  }
  const campaignId = typeof input.campaignId === 'string' ? input.campaignId.trim() : '';
  const same = existing.status === 'draft'
    && existing.name === cleanString(input.name, MAX.name)
    && (existing.campaignId ?? '') === campaignId
    && stepShape(existing.steps) === stepShape(input.steps ?? []);
  if (!same) {
    throw new OpenwopError('conflict', 'This run already created a different funnel here (or it has been published since). Give the node a distinct `key`.', 409, { code: 'run_funnel_exists', funnelId: existing.funnelId, status: existing.status });
  }
  return existing;
}

export async function createFunnel(input: FunnelCreateInput): Promise<Funnel> {
  return (await createFunnelReporting(input)).funnel;
}

/** `createFunnel`, also saying whether a derived-id create returned an existing
 *  draft (`reused`) — the workflow surface reports it, so a re-delivery is visible. */
export async function createFunnelReporting(input: FunnelCreateInput): Promise<{ funnel: Funnel; reused: boolean }> {
  // ADR 0948 P1 — a re-delivered create returns its own draft BEFORE the limit and
  // slug checks, which would otherwise refuse it against itself.
  if (input.funnelId) {
    const existing = await funnels.get(input.funnelId);
    if (existing) return { funnel: await hydrate(sameRunFunnel(existing, input)), reused: true };
  }
  const name = cleanString(input.name, MAX.name);
  if (!name) throw new OpenwopError('validation_error', 'A funnel name is required.', 400, { field: 'name' });
  if ((await listFunnelRows(input.tenantId, input.orgId)).length >= MAX.perOrg) {
    throw new OpenwopError('validation_error', 'Funnel limit reached for this workspace.', 400, {});
  }
  const slug = coerceSlug(input.slug, name);
  await assertSlugFree(input.tenantId, input.orgId, slug);
  const steps = await coerceSteps(input.tenantId, input.orgId, input.steps);
  const campaignId = await coerceCampaignId(input.tenantId, input.orgId, input.campaignId);
  const ts = nowIso();
  const funnel: Funnel = {
    funnelId: input.funnelId ?? randomUUID(), tenantId: input.tenantId, orgId: input.orgId,
    name, slug, status: 'draft', steps,
    createdBy: input.createdBy, createdAt: ts, updatedAt: ts,
    ...(campaignId ? { campaignId } : {}),
  };
  if (input.funnelId) {
    // Insert-if-absent: two concurrent deliveries of the same create write once.
    if (!(await funnels.compareAndSwap(null, funnel))) {
      const winner = await funnels.get(input.funnelId);
      if (!winner) throw new OpenwopError('conflict', 'The funnel changed underneath this request — retry.', 409, {});
      return { funnel: await hydrate(sameRunFunnel(winner, input)), reused: true };
    }
    return { funnel, reused: false };
  }
  await funnels.put(funnel);
  return { funnel, reused: false };
}

export interface FunnelUpdateInput { name?: unknown; slug?: unknown; steps?: unknown; completionCta?: unknown; campaignId?: unknown; primaryHostname?: unknown }

/**
 * ADR 0948 — an editor that predates offers re-submits steps without the `offer`
 * key; that must not silently delete an offer an agent or another editor set.
 * Omitted key ⇒ keep the stored offer (by stepId); `offer: null` ⇒ clear it.
 */
function carryOffers(prev: FunnelStep[], next: FunnelStep[], raw: unknown): FunnelStep[] {
  // ADR 0948 D4 — the same rule for the webinar and application bindings: an editor
  // that does not know a field must not delete it by omission.
  const CARRIED = ['offer', 'webinar', 'application'] as const;
  const provided = new Map<string, Set<string>>(CARRIED.map((k) => [k, new Set<string>()]));
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const o = (item ?? {}) as { stepId?: unknown };
      if (!item || typeof item !== 'object' || typeof o.stepId !== 'string') continue;
      for (const k of CARRIED) if (k in item) provided.get(k)!.add(o.stepId.trim());
    }
  }
  const byId = new Map(prev.map((st) => [st.stepId, st]));
  return next.map((st) => {
    const before = byId.get(st.stepId);
    if (!before || before.kind !== st.kind) return st;
    let out = st;
    for (const k of CARRIED) {
      if (provided.get(k)!.has(st.stepId) || before[k] === undefined) continue;
      out = { ...out, [k]: before[k] };
    }
    return out;
  });
}

/** Steps re-submitted from the client never carry experiments — preserve a
 *  step's running/stopped experiment across edits by stepId. */
function carryExperiments(prev: FunnelStep[], next: FunnelStep[]): FunnelStep[] {
  const byId = new Map(prev.map((s) => [s.stepId, s]));
  return next.map((s) => {
    const before = byId.get(s.stepId);
    return before?.experiment ? { ...s, experiment: before.experiment } : s;
  });
}

export async function updateFunnel(tenantId: string, orgId: string, funnelId: string, input: FunnelUpdateInput): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (f.status === 'archived') throw new OpenwopError('validation_error', 'An archived funnel cannot be edited.', 400, {});
  const next: Funnel = { ...f };
  if (input.name !== undefined) {
    const name = cleanString(input.name, MAX.name);
    if (!name) throw new OpenwopError('validation_error', 'A funnel name is required.', 400, { field: 'name' });
    next.name = name;
  }
  if (input.slug !== undefined) {
    const slug = coerceSlug(input.slug, next.name);
    if (slug !== f.slug) {
      // The CMS rule: a live public path never silently moves.
      if (f.status === 'published') throw new OpenwopError('validation_error', 'Unpublish the funnel before changing its slug.', 400, { field: 'slug' });
      await assertSlugFree(tenantId, orgId, slug, funnelId);
      next.slug = slug;
    }
  }
  if (input.steps !== undefined) next.steps = carryOffers(f.steps, carryExperiments(f.steps, await coerceSteps(tenantId, orgId, input.steps)), input.steps);
  if (input.campaignId !== undefined) {
    const campaignId = await coerceCampaignId(tenantId, orgId, input.campaignId);
    if (campaignId) next.campaignId = campaignId; else delete next.campaignId;
  }
  // ADR 0948 D8 — editing a LIVE funnel is publishing its new steps: the same
  // client-settlement guard runs, so adding a checkout to a published funnel
  // cannot route around the publish check (every lane — route, surface, node,
  // agent tool — writes through here).
  if (f.status === 'published' && input.steps !== undefined) await assertClientSettlement(tenantId, orgId, next.steps);
  if (input.primaryHostname !== undefined) {
    const host = await coercePrimaryHostname(tenantId, orgId, input.primaryHostname);
    if (host) next.primaryHostname = host; else delete next.primaryHostname;
  }
  if (input.completionCta !== undefined) {
    if (input.completionCta === null) {
      delete next.completionCta; // explicit clear
    } else {
      const cta = coerceCompletionCta(input.completionCta);
      // R2R F4 — an unusable CTA is a 400, never a silent delete of the stored
      // one (a validation failure must not become data loss with a 200).
      if (!cta) throw new OpenwopError('validation_error', 'completionCta needs a label (≤80 chars) and an internal path or http(s) URL.', 400, { field: 'completionCta' });
      next.completionCta = cta;
    }
  }
  next.updatedAt = nowIso();
  await casFunnel(f, next);
  // ADR 0949 P1b — a step removed by this edit takes its experiment with it
  // (engine row + rollup). After the funnel write, so a failure leaves an
  // unreachable row, never a step pointing at a deleted experiment.
  if (input.steps !== undefined) {
    const kept = new Set(next.steps.map((st) => st.experiment?.experimentId).filter(Boolean));
    for (const st of f.steps) {
      if (st.experiment && !kept.has(st.experiment.experimentId)) await releaseStepExperiment(tenantId, orgId, st.experiment.experimentId, next.updatedAt);
    }
  }
  return next;
}

/** VP-R2-3 — bounded completion CTA: label ≤80; url an internal path or
 *  http(s) ≤2048 (never javascript:/data: — the public complete card renders
 *  it as a link). Null clears; anything unusable clears rather than persisting
 *  a half-CTA. */
export function coerceCompletionCta(raw: unknown): { label: string; url: string } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as { label?: unknown; url?: unknown };
  const label = typeof r.label === 'string' ? cleanString(r.label, 80) : '';
  const url = typeof r.url === 'string' ? r.url.trim().slice(0, 2048) : '';
  const safe = isInternalHref(url) || /^https?:\/\//i.test(url); // ADR 0836 D7 — the shared predicate
  if (!label || !url || !safe) return null;
  return { label, url };
}

/** Publish: ≥1 step and every step page must still resolve (a page deleted since
 *  authoring must fail loudly here, not 404 at the public read). */
/** ADR 0948 P1b — what a publish approval pins: everything a visitor or a charge
 *  sees (slug; steps with their pages, names, routing, offers and experiments;
 *  campaign; completion CTA). The funnel's own name and timestamps are left out, so
 *  an internal rename does not invalidate a review. */
export function funnelPublishDigest(f: Funnel): string {
  const shape = {
    slug: f.slug,
    // A step's name is served publicly, and a running experiment swaps the page a
    // visitor gets, so both are part of what an approver approves (salt and
    // timestamps are not visible and are left out).
    steps: f.steps.map((st) => ({
      stepId: st.stepId, kind: st.kind, pageId: st.pageId, name: st.name ?? null, routing: st.routing ?? null, offer: st.offer ?? null,
      webinar: st.webinar ?? null, application: st.application ?? null,
      experiment: st.experiment ? { status: st.experiment.status, variants: st.experiment.variants } : null,
    })),
    campaignId: f.campaignId ?? null,
    completionCta: f.completionCta ?? null,
    primaryHostname: f.primaryHostname ?? null,
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/** Step pages that are not published (a funnel step serves its page publicly only
 *  when the page is published — `publicFunnelStep` 404s a draft page). */
export async function unpublishedStepPages(tenantId: string, orgId: string, f: Funnel): Promise<string[]> {
  const out: string[] = [];
  for (const st of f.steps) {
    const page = await getPage(tenantId, orgId, st.pageId);
    if (!page || page.status !== 'published') out.push(st.pageId);
  }
  return [...new Set(out)];
}

export interface PublishFunnelOpts {
  /** ADR 0948 P1b — publish only this exact content (`funnelPublishDigest`); the write
   *  is a CAS from the row that was checked, so an edit landing in between is refused
   *  (`stale_review`), never published unapproved. */
  expectedDigest?: string;
  /** ADR 0948 P1b — refuse unless every step page is already published
   *  (`step_pages_unpublished`): the funnel-publish lane never publishes pages. */
  requirePublishedPages?: boolean;
}

/** Every refusal a publish can meet, in one place, so the approval lane can run them
 *  BEFORE it resolves a review (a refusal then consumes nothing) and `publishFunnel`
 *  runs the same ones again under its write. */
export async function assertFunnelPublishable(tenantId: string, orgId: string, f: Funnel, opts: Pick<PublishFunnelOpts, 'requirePublishedPages'> = {}): Promise<void> {
  if (f.status === 'archived') throw new OpenwopError('validation_error', 'An archived funnel cannot be published.', 400, {});
  if (f.steps.length === 0) throw new OpenwopError('validation_error', 'A funnel needs at least one step to publish.', 400, { field: 'steps' });
  for (const step of f.steps) {
    if (!(await getPage(tenantId, orgId, step.pageId))) {
      throw new OpenwopError('validation_error', `Step page no longer exists: ${step.pageId}`, 400, { field: 'steps' });
    }
  }
  // ADR 0948 D4 — a webinar step needs its (still existing) webinar and that
  // webinar's registration form; an application step needs its (still existing) form.
  for (const st of f.steps) {
    if (st.kind === 'webinar') {
      const ev = st.webinar ? await getMarketingEvent(tenantId, orgId, st.webinar.marketingEventId) : null;
      if (!ev) throw new OpenwopError('validation_error', 'A webinar step needs a webinar of this organization.', 400, { field: 'steps', stepId: st.stepId });
      if (!ev.formId) throw new OpenwopError('validation_error', 'That webinar has no registration form yet.', 400, { field: 'steps', stepId: st.stepId });
    }
    if (st.kind === 'application' && (!st.application || !(await getForm(tenantId, orgId, st.application.formId)))) {
      throw new OpenwopError('validation_error', 'An application step needs a form of this organization.', 400, { field: 'steps', stepId: st.stepId });
    }
  }
  if (opts.requirePublishedPages) {
    const missing = await unpublishedStepPages(tenantId, orgId, f);
    if (missing.length > 0) {
      throw new OpenwopError('conflict', 'Publish the funnel\'s step pages first; publishing a funnel never publishes its pages.', 409, { reason: 'step_pages_unpublished', pageIds: missing });
    }
  }
  if (f.primaryHostname) {
    const d = await getDomain(tenantId, orgId, f.primaryHostname);
    if (!d || !isServingDomain(d)) {
      throw new OpenwopError('validation_error', 'The funnel\'s primary domain is no longer live. Choose another or clear it.', 400, { field: 'primaryHostname', code: 'domain_not_serving' });
    }
  }
  await assertSlugFree(tenantId, orgId, f.slug, f.funnelId);
  await assertClientSettlement(tenantId, orgId, f.steps); // ADR 0948 D8
}

export async function publishFunnel(tenantId: string, orgId: string, funnelId: string, opts: PublishFunnelOpts = {}): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (opts.expectedDigest !== undefined && funnelPublishDigest(f) !== opts.expectedDigest) {
    throw new OpenwopError('conflict', 'This funnel changed after it was submitted for publishing. Request publishing again.', 409, { reason: 'stale_review', funnelId });
  }
  await assertFunnelPublishable(tenantId, orgId, f, opts);
  const next: Funnel = { ...f, status: 'published', publishedAt: nowIso(), updatedAt: nowIso() };
  // The approval lane (pinned or pages-required) always writes by CAS from the row it
  // checked: a concurrent edit is refused, never overwritten with the checked copy.
  if (opts.expectedDigest !== undefined || opts.requirePublishedPages) {
    // ADR 0949 P2c — `f` is a hydrated read: compare the row as stored, store the pointer form.
    if (!(await swapStored(f, next))) {
      throw new OpenwopError('conflict', 'This funnel changed while it was being published. Request publishing again.', 409, { reason: 'stale_review', funnelId });
    }
    return next;
  }
  await casFunnel(f, next);
  return next;
}

export async function unpublishFunnel(tenantId: string, orgId: string, funnelId: string): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (f.status !== 'published') return f;
  const next: Funnel = { ...f, status: 'draft', updatedAt: nowIso() };
  delete next.publishedAt;
  await casFunnel(f, next);
  return next;
}

export async function archiveFunnel(tenantId: string, orgId: string, funnelId: string): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (f.status === 'archived') return f;
  const next: Funnel = { ...f, status: 'archived', updatedAt: nowIso() };
  delete next.publishedAt;
  await casFunnel(f, next);
  return next;
}

export async function deleteFunnel(tenantId: string, orgId: string, funnelId: string): Promise<boolean> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return false;
  await funnels.delete(funnelId);
  // ADR 0949 P1b — the funnel row is the only pointer to its step experiments.
  for (const st of f.steps) if (st.experiment) await releaseStepExperiment(tenantId, orgId, st.experiment.experimentId, nowIso());
  return true;
}

// ── Public serving (Phase 2 — unauthed; org→tenant from the URL; toggle-gated
//    in the route; published-only at every layer; uniform 404s, no leak) ──────

export interface PublicFunnelStep {
  ix: number;
  stepId: string;
  kind: FunnelStepKind;
  name?: string;
  /** The published CMS page's slug — the renderer fetches it through the
   *  EXISTING public page read (`/public/:orgId/pages/:slug`), so localization,
   *  SEO, shared-section resolution, and ADR 0236 experiments apply verbatim.
   *  Funnels never render pages. */
  pageSlug: string;
  /** ADR 0948 D2 — what this money step sells. The checkout and one-click
   *  routes accept nothing outside it when they are given this step. */
  offer?: FunnelOffer;
  /** ADR 0948 D4 — a webinar step's public facts: title and start time only (never
   *  the provider event id or any join link). Absent when the webinar is gone. */
  webinar?: { title: string; startsAt?: string };
  /** ADR 0332 — pass to a form section's submit as `context` (+ the renderer's
   *  own consented `?vk=` as `visitor`) so the submission attributes back to
   *  this funnel step via the attribution sink. */
  formContext: { funnelId: string; stepId: string };
  /** Phase 4 — present only when a running step split assigned this
   *  (consented) visitor a variant; echoed onto the step events. */
  experiment?: { experimentId: string; variant: string };
}

/** Resolve a step for the public surface: the funnel must be published AND the
 *  served page must currently be published (tolerate-on-read: a page
 *  unpublished after funnel-publish makes the STEP unavailable — an honest 404
 *  — never a leak of draft content). `consentedVk` (Phase 4) is the visitor
 *  key AFTER the route's consent gate; a running step split then swaps the
 *  served page for the assigned variant's. A variant page that is missing or
 *  unpublished degrades to the holdout WITHOUT a stamp (the ADR 0236 rule —
 *  never attribute content the visitor didn't see). */
export async function publicFunnelStep(tenantId: string, orgId: string, funnel: Funnel, ix: number, consentedVk = ''): Promise<PublicFunnelStep | null> {
  const step = funnel.steps[ix];
  if (!step) return null;
  const holdout = await getPage(tenantId, orgId, step.pageId);
  if (!holdout || holdout.status !== 'published') return null;
  let pageSlug = holdout.slug;
  let stamp: { experimentId: string; variant: string } | undefined;
  const exp = consentedVk ? await resolveStepExperiment(tenantId, orgId, funnel.funnelId, step.stepId, step.experiment) : null;
  // ADR 0949 P4 — an Optimize split keeps a returning visitor's first
  // exposure; ADR 0950 — a promotion ramp assigns by its epoch's band layout.
  const engineRow = exp?.engineMode ? await getExperimentRow(tenantId, orgId, exp.experimentId) : null;
  const engineArm = engineRow && exp?.status === 'running'
    ? (engineRow.mode === 'optimize' ? await stickyAssign(engineRow, consentedVk, nowIso()) : assignAt(engineRow, consentedVk, nowIso()))
    : null;
  const variant = exp
    ? (engineRow ? (engineArm ? exp.variants.find((v) => v.key === engineArm.arm.key) ?? null : null) : assignStepVariant(funnel, { ...step, experiment: exp }, consentedVk))
    : null;
  if (exp && variant) {
    if (variant.pageId === null) {
      stamp = { experimentId: exp.experimentId, variant: variant.key };
    } else {
      const page = await getPage(tenantId, orgId, variant.pageId);
      if (page && page.status === 'published') {
        pageSlug = page.slug;
        stamp = { experimentId: exp.experimentId, variant: variant.key };
      }
    }
  }
  // ADR 0332 §D2 — ready-made embed context for a form section on this step's
  // page: the renderer merges its own consented `?vk=` as `visitor` and passes
  // the object to the public form submit (`meta.context`). Additive; opaque to
  // forms; the attribution sink (`formsAttributionSink.ts`) closes the loop.
  const ev = step.kind === 'webinar' && step.webinar ? await getMarketingEvent(tenantId, orgId, step.webinar.marketingEventId) : null;
  return {
    ix, stepId: step.stepId, kind: step.kind, ...(step.name ? { name: step.name } : {}), pageSlug,
    ...(step.offer ? { offer: step.offer } : {}),
    ...(ev ? { webinar: { title: ev.title, ...(ev.startsAt ? { startsAt: ev.startsAt } : {}) } } : {}),
    ...(stamp ? { experiment: stamp } : {}), formContext: { funnelId: funnel.funnelId, stepId: step.stepId },
  };
}

// ── Step experiments (Phase 4 — the ADR 0236 model on funnel steps) ──────────

export function coerceExperimentVariants(raw: unknown): StepExperimentVariant[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX.variants) {
    throw new OpenwopError('validation_error', `An experiment needs 2–${MAX.variants} variants.`, 400, { field: 'variants' });
  }
  const variants: StepExperimentVariant[] = raw.map((item) => {
    const o = (item ?? {}) as { key?: unknown; pageId?: unknown; weight?: unknown };
    const key = cleanString(o.key, MAX.variantKey);
    if (!key) throw new OpenwopError('validation_error', 'Every variant needs a key.', 400, { field: 'variants' });
    const weight = Number(o.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
      throw new OpenwopError('validation_error', 'Variant weight must be an integer 1..100.', 400, { field: 'variants' });
    }
    const pageId = o.pageId === null || o.pageId === undefined ? null : String(o.pageId).trim();
    return { key, pageId: pageId || null, weight };
  });
  if (new Set(variants.map((v) => v.key)).size !== variants.length) {
    throw new OpenwopError('validation_error', 'Variant keys must be unique.', 400, { field: 'variants' });
  }
  if (variants.reduce((sum, v) => sum + v.weight, 0) !== 100) {
    throw new OpenwopError('validation_error', 'Variant weights must sum to exactly 100.', 400, { field: 'variants' });
  }
  return variants;
}

/** Create + start a step split (replaces any prior experiment on the step —
 *  a NEW experimentId/salt, so assignments never bleed between runs). */
export async function setStepExperiment(tenantId: string, orgId: string, funnelId: string, stepId: string, rawVariants: unknown): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (f.status === 'archived') throw new OpenwopError('validation_error', 'An archived funnel cannot run experiments.', 400, {});
  const ix = f.steps.findIndex((s) => s.stepId === stepId);
  if (ix === -1) throw new OpenwopError('not_found', 'Step not found.', 404, {});
  // ADR 0949 P2a — a running Decide experiment on this step is changed in Experiments.
  const prior = f.steps[ix].experiment;
  if (prior && prior.status === 'running' && await isManagedExperiment(tenantId, orgId, prior.experimentId)) {
    throw new OpenwopError('conflict', 'A managed experiment is running on this step; stop it in Experiments first.', 409, { reason: 'managed_by_experiments', experimentId: prior.experimentId });
  }
  const variants = coerceExperimentVariants(rawVariants);
  for (const v of variants) {
    if (v.pageId !== null && !(await getPage(tenantId, orgId, v.pageId))) {
      throw new OpenwopError('validation_error', `Variant page not found in this workspace: ${v.pageId}`, 400, { field: 'variants' });
    }
  }
  const experiment: StepExperiment = {
    experimentId: randomUUID(), status: 'running', salt: randomUUID().slice(0, 8),
    variants, createdAt: nowIso(),
  };
  // ADR 0949 P1b — the engine first (the record), then the funnel row (the
  // pointer + rollback mirror), then the replaced experiment goes (as before,
  // a new split never inherits the old one's assignments or results).
  await saveStepExperiment(tenantId, orgId, funnelId, stepId, experiment);
  const replaced = f.steps[ix].experiment;
  const steps = f.steps.slice();
  steps[ix] = { ...steps[ix], experiment };
  const next: Funnel = { ...f, steps, updatedAt: nowIso() };
  await casFunnel(f, next);
  if (replaced) await releaseStepExperiment(tenantId, orgId, replaced.experimentId, nowIso());
  return next;
}

export async function stopStepExperiment(tenantId: string, orgId: string, funnelId: string, stepId: string): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  const ix = f.steps.findIndex((s) => s.stepId === stepId);
  if (ix === -1 || !f.steps[ix].experiment) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
  if (await isManagedExperiment(tenantId, orgId, f.steps[ix].experiment!.experimentId)) {
    throw new OpenwopError('conflict', 'This experiment is managed in Experiments; stop it there.', 409, { reason: 'managed_by_experiments' });
  }
  const current = await resolveStepExperiment(tenantId, orgId, funnelId, stepId, f.steps[ix].experiment) ?? f.steps[ix].experiment!;
  const stopped: StepExperiment = { ...current, status: 'stopped', stoppedAt: current.stoppedAt ?? nowIso() };
  await saveStepExperiment(tenantId, orgId, funnelId, stepId, stopped);
  const steps = f.steps.slice();
  steps[ix] = { ...steps[ix], experiment: stopped };
  const next: Funnel = { ...f, steps, updatedAt: nowIso() };
  await casFunnel(f, next);
  return next;
}

/** Deterministic variant for a consented visitor on a running step split —
 *  the SHARED bucketer with the funnel-scoped unit (ADR 0294 §5). */
export function assignStepVariant(funnel: Funnel, step: FunnelStep, consentedVk: string): StepExperimentVariant | null {
  const exp = step.experiment;
  if (!exp || exp.status !== 'running' || !consentedVk) return null;
  // ADR 0949 P1b — the engine's assignArm on the legacy scope (byte-identical).
  const arm = assignArm({ ...stepToEngine(funnel.tenantId, funnel.orgId, funnel.funnelId, step.stepId, exp), assignmentScope: stepAssignmentScope(funnel.funnelId, step.stepId) }, consentedVk);
  return arm ? exp.variants.find((v) => v.key === arm.key) ?? null : null;
}

/** Every (tenant, org) scope holding at least one funnel — the stats sweep's
 *  work list (a full-collection scan, the same class as the other sweeps). */
export async function listFunnelScopes(): Promise<Array<{ tenantId: string; orgId: string }>> {
  const seen = new Set<string>();
  const out: Array<{ tenantId: string; orgId: string }> = [];
  for (const f of await funnels.list()) {
    const key = `${f.tenantId}:${f.orgId}`;
    if (!seen.has(key)) { seen.add(key); out.push({ tenantId: f.tenantId, orgId: f.orgId }); }
  }
  return out;
}

/** Test-only. */
export async function __resetFunnels(): Promise<void> {
  for (const f of await funnels.list()) await funnels.delete(f.funnelId);
}

// ── ADR 0949 P2a — the funnel.step experiment adapter's writes ────────────────

/** Point a step at a launched (or stopped) engine-managed experiment: the
 *  funnel row's embedded copy is the pointer the public read follows. Refuses
 *  while another experiment is running on the step. */
export async function attachStepExperiment(tenantId: string, orgId: string, funnelId: string, stepId: string, exp: StepExperiment): Promise<void> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
  if (f.status === 'archived') throw new OpenwopError('validation_error', 'An archived funnel cannot run experiments.', 400, {});
  const ix = f.steps.findIndex((s) => s.stepId === stepId);
  if (ix === -1) throw new OpenwopError('not_found', 'Step not found.', 404, {});
  const prior = f.steps[ix].experiment;
  if (prior && prior.experimentId !== exp.experimentId) {
    const live = await resolveStepExperiment(tenantId, orgId, funnelId, stepId, prior);
    if (live?.status === 'running') {
      throw new OpenwopError('conflict', 'Another experiment is already running on this step.', 409, { runningExperimentId: prior.experimentId });
    }
  }
  const steps = f.steps.slice();
  steps[ix] = { ...steps[ix], experiment: exp };
  await casFunnel(f, { ...f, steps, updatedAt: nowIso() });
  if (prior && prior.experimentId !== exp.experimentId) await releaseStepExperiment(tenantId, orgId, prior.experimentId, nowIso());
}

/** The step and funnel an experiment targets, if they still exist in the org. */
export async function findFunnelStep(tenantId: string, orgId: string, funnelId: string, stepId: string): Promise<{ funnel: Funnel; step: FunnelStep } | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  const step = f?.steps.find((s) => s.stepId === stepId);
  return f && step ? { funnel: f, step } : null;
}

/** ADR 0950 P1 — swap a step's page (a promotion's finalize or rollback).
 *  Returns the page it replaced. */
export async function setStepPage(tenantId: string, orgId: string, funnelId: string, stepId: string, pageId: string): Promise<string> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
  const ix = f.steps.findIndex((s) => s.stepId === stepId);
  if (ix === -1) throw new OpenwopError('not_found', 'Step not found.', 404, {});
  if (!(await getPage(tenantId, orgId, pageId))) throw new OpenwopError('validation_error', `Page not found in this workspace: ${pageId}`, 400, { field: 'pageId' });
  const previous = f.steps[ix].pageId;
  const steps = f.steps.slice();
  steps[ix] = { ...steps[ix], pageId };
  await casFunnel(f, { ...f, steps, updatedAt: nowIso() });
  return previous;
}

/** ADR 0950 recovery — pointer and operation receipt are ONE CAS. A committed
 * write with a lost acknowledgement is reconciled from this row; neither retry
 * can replace the original baseline or reopen an already rolled-back effect. */
export async function reconcileStepPromotion(
  tenantId: string, orgId: string, funnelId: string, stepId: string,
  experimentId: string, winnerRef: string | null, operation: 'finalize' | 'rollback',
): Promise<{ baselineRef: string }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const f = await getFunnel(tenantId, orgId, funnelId);
    if (!f) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
    const index = f.steps.findIndex((step) => step.stepId === stepId);
    const step = f.steps[index];
    if (!step) throw new OpenwopError('not_found', 'Step not found.', 404, {});
    const receipts = f.promotionReceipts ?? {};
    const prior = Object.hasOwn(receipts, experimentId) ? receipts[experimentId] : undefined;
    if (prior && (prior.stepId !== stepId || prior.winnerRef !== winnerRef)) {
      throw new OpenwopError('conflict', 'This promotion receipt belongs to different work.', 409, { reason: 'promotion_receipt_mismatch' });
    }
    if (prior?.outcome === 'rolled_back') {
      if (operation === 'finalize') throw new OpenwopError('conflict', 'This promotion was rolled back.', 409, { reason: 'promotion_rolled_back' });
      return { baselineRef: prior.baselineRef };
    }
    if (prior && operation === 'finalize') return { baselineRef: prior.baselineRef };
    if (operation === 'finalize' && f.status === 'archived') {
      throw new OpenwopError('conflict', 'An archived funnel cannot be promoted.', 409, { reason: 'promotion_target_changed' });
    }
    if (step.experiment?.experimentId !== experimentId) {
      throw new OpenwopError('conflict', 'The step no longer belongs to this experiment.', 409, { reason: 'promotion_target_changed' });
    }
    const baselineRef = prior?.baselineRef ?? step.pageId;
    const pageId = operation === 'rollback' ? baselineRef : winnerRef ?? step.pageId;
    // A manual edit must not be overwritten by restoration of an older receipt.
    if (operation === 'rollback' && prior && step.pageId !== (winnerRef ?? baselineRef) && step.pageId !== baselineRef) {
      throw new OpenwopError('conflict', 'The promoted step was edited. Reconcile that edit before restoring its baseline.', 409, { reason: 'promotion_target_changed' });
    }
    const page = await getPage(tenantId, orgId, pageId);
    if (!page || (operation === 'finalize' && winnerRef !== null && page.status !== 'published')) {
      throw new OpenwopError('conflict', 'The promotion page is missing or no longer publishable.', 409, { reason: 'promotion_content_changed' });
    }
    const steps = f.steps.slice();
    steps[index] = { ...step, pageId };
    const next: Funnel = { ...f, steps, updatedAt: nowIso(), promotionReceipts: { ...f.promotionReceipts,
      [experimentId]: { stepId, winnerRef, baselineRef, outcome: operation === 'finalize' ? 'finalized' : 'rolled_back' },
    } };
    if (await swapStored(f, next)) return { baselineRef };
  }
  throw new OpenwopError('conflict', 'The funnel changed repeatedly. Retry the promotion.', 409, { reason: 'funnel_changed' });
}
