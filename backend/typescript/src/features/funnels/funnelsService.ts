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
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { assignWeightedVariant } from '../../host/variantAssignment.js';
import { getPage } from '../cms/cmsService.js';
import { STEP_OUTCOMES, type StepOutcome, type StepRule } from './funnelRouting.js';

const nowIso = (): string => new Date().toISOString();
const MAX = { name: 200, slug: 80, stepName: 120, steps: 20, perOrg: 200, rulesPerStep: 10, utm: 200, variants: 4, variantKey: 40 } as const;

export const FUNNEL_STEP_KINDS = ['landing', 'optin', 'sales', 'checkout', 'upsell', 'downsell', 'thankyou'] as const;
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
}

export interface StepExperimentVariant {
  key: string;
  /** A CMS pageId, or null = the holdout (the step's own page). */
  pageId: string | null;
  /** Integer percentage 1..100; the set sums to exactly 100. */
  weight: number;
}

export interface StepExperiment {
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
}

const funnels = new DurableCollection<Funnel>('funnels:funnel', (f) => f.funnelId, undefined, (f) => f.tenantId);

// ── Reads ─────────────────────────────────────────────────────────────────────
export async function listFunnels(tenantId: string, orgId: string): Promise<Funnel[]> {
  return (await funnels.listForTenantIndexed(tenantId))
    .filter((f) => f.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.funnelId.localeCompare(b.funnelId));
}

export async function getFunnel(tenantId: string, orgId: string, funnelId: string): Promise<Funnel | null> {
  const f = await funnels.get(funnelId);
  return f && f.tenantId === tenantId && f.orgId === orgId ? f : null;
}

/** Phase-2 seam: resolve a PUBLISHED funnel by its public slug. */
export async function getPublishedFunnelBySlug(tenantId: string, orgId: string, slug: string): Promise<Funnel | null> {
  const all = await listFunnels(tenantId, orgId);
  return all.find((f) => f.status === 'published' && f.slug === slug) ?? null;
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
  const clash = (await listFunnels(tenantId, orgId))
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
    const key = cleanString(u.key, MAX.utm);
    const value = cleanString(u.value, MAX.utm);
    if (!key || !value) throw new OpenwopError('validation_error', 'A utm rule needs key and value.', 400, { field: 'steps' });
    when.utm = { key, value };
  }
  if (when.outcome === undefined && when.utm === undefined) return { goto };
  return { when, goto };
}

/** Validate the steps array: kinds legal, pages resolve for THIS tenant+org (IDOR guard). */
async function coerceSteps(tenantId: string, orgId: string, raw: unknown): Promise<FunnelStep[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', 'steps must be an array.', 400, { field: 'steps' });
  if (raw.length > MAX.steps) throw new OpenwopError('validation_error', `A funnel may have at most ${MAX.steps} steps.`, 400, { field: 'steps' });
  const steps: FunnelStep[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as { stepId?: unknown; kind?: unknown; pageId?: unknown; name?: unknown; routing?: unknown };
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
    steps.push({
      stepId: typeof o.stepId === 'string' && o.stepId.trim() ? o.stepId.trim() : randomUUID(),
      kind, pageId, ...(name ? { name } : {}), ...(routing ? { routing } : {}),
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
}

export async function createFunnel(input: FunnelCreateInput): Promise<Funnel> {
  const name = cleanString(input.name, MAX.name);
  if (!name) throw new OpenwopError('validation_error', 'A funnel name is required.', 400, { field: 'name' });
  if ((await listFunnels(input.tenantId, input.orgId)).length >= MAX.perOrg) {
    throw new OpenwopError('validation_error', 'Funnel limit reached for this workspace.', 400, {});
  }
  const slug = coerceSlug(input.slug, name);
  await assertSlugFree(input.tenantId, input.orgId, slug);
  const steps = await coerceSteps(input.tenantId, input.orgId, input.steps);
  const ts = nowIso();
  const funnel: Funnel = {
    funnelId: randomUUID(), tenantId: input.tenantId, orgId: input.orgId,
    name, slug, status: 'draft', steps,
    createdBy: input.createdBy, createdAt: ts, updatedAt: ts,
  };
  await funnels.put(funnel);
  return funnel;
}

export interface FunnelUpdateInput { name?: unknown; slug?: unknown; steps?: unknown; completionCta?: unknown }

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
  if (input.steps !== undefined) next.steps = carryExperiments(f.steps, await coerceSteps(tenantId, orgId, input.steps));
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
  await funnels.put(next);
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
  const safe = /^\/(?![\/\\])/.test(url) || /^https?:\/\//i.test(url);
  if (!label || !url || !safe) return null;
  return { label, url };
}

/** Publish: ≥1 step and every step page must still resolve (a page deleted since
 *  authoring must fail loudly here, not 404 at the public read). */
export async function publishFunnel(tenantId: string, orgId: string, funnelId: string): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (f.status === 'archived') throw new OpenwopError('validation_error', 'An archived funnel cannot be published.', 400, {});
  if (f.steps.length === 0) throw new OpenwopError('validation_error', 'A funnel needs at least one step to publish.', 400, { field: 'steps' });
  for (const step of f.steps) {
    if (!(await getPage(tenantId, orgId, step.pageId))) {
      throw new OpenwopError('validation_error', `Step page no longer exists: ${step.pageId}`, 400, { field: 'steps' });
    }
  }
  await assertSlugFree(tenantId, orgId, f.slug, funnelId);
  const next: Funnel = { ...f, status: 'published', publishedAt: nowIso(), updatedAt: nowIso() };
  await funnels.put(next);
  return next;
}

export async function unpublishFunnel(tenantId: string, orgId: string, funnelId: string): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (f.status !== 'published') return f;
  const next: Funnel = { ...f, status: 'draft', updatedAt: nowIso() };
  delete next.publishedAt;
  await funnels.put(next);
  return next;
}

export async function archiveFunnel(tenantId: string, orgId: string, funnelId: string): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (f.status === 'archived') return f;
  const next: Funnel = { ...f, status: 'archived', updatedAt: nowIso() };
  delete next.publishedAt;
  await funnels.put(next);
  return next;
}

export async function deleteFunnel(tenantId: string, orgId: string, funnelId: string): Promise<boolean> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return false;
  await funnels.delete(funnelId);
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
  const variant = assignStepVariant(funnel, step, consentedVk);
  if (variant) {
    if (variant.pageId === null) {
      stamp = { experimentId: step.experiment!.experimentId, variant: variant.key };
    } else {
      const page = await getPage(tenantId, orgId, variant.pageId);
      if (page && page.status === 'published') {
        pageSlug = page.slug;
        stamp = { experimentId: step.experiment!.experimentId, variant: variant.key };
      }
    }
  }
  // ADR 0332 §D2 — ready-made embed context for a form section on this step's
  // page: the renderer merges its own consented `?vk=` as `visitor` and passes
  // the object to the public form submit (`meta.context`). Additive; opaque to
  // forms; the attribution sink (`formsAttributionSink.ts`) closes the loop.
  return { ix, stepId: step.stepId, kind: step.kind, ...(step.name ? { name: step.name } : {}), pageSlug, ...(stamp ? { experiment: stamp } : {}), formContext: { funnelId: funnel.funnelId, stepId: step.stepId } };
}

// ── Step experiments (Phase 4 — the ADR 0236 model on funnel steps) ──────────

function coerceExperimentVariants(raw: unknown): StepExperimentVariant[] {
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
  const steps = f.steps.slice();
  steps[ix] = { ...steps[ix], experiment };
  const next: Funnel = { ...f, steps, updatedAt: nowIso() };
  await funnels.put(next);
  return next;
}

export async function stopStepExperiment(tenantId: string, orgId: string, funnelId: string, stepId: string): Promise<Funnel | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  const ix = f.steps.findIndex((s) => s.stepId === stepId);
  if (ix === -1 || !f.steps[ix].experiment) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
  const steps = f.steps.slice();
  steps[ix] = { ...steps[ix], experiment: { ...steps[ix].experiment!, status: 'stopped', stoppedAt: nowIso() } };
  const next: Funnel = { ...f, steps, updatedAt: nowIso() };
  await funnels.put(next);
  return next;
}

/** Deterministic variant for a consented visitor on a running step split —
 *  the SHARED bucketer with the funnel-scoped unit (ADR 0294 §5). */
export function assignStepVariant(funnel: Funnel, step: FunnelStep, consentedVk: string): StepExperimentVariant | null {
  const exp = step.experiment;
  if (!exp || exp.status !== 'running' || !consentedVk) return null;
  const key = assignWeightedVariant(consentedVk, `funnel:${funnel.funnelId}:step:${step.stepId}`, exp.salt, exp.variants);
  return exp.variants.find((v) => v.key === key) ?? null;
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
