/**
 * CMS page experiments (ADR 0236 — campaign gap D1, the E6/E7 floor).
 *
 * Visitor-scoped experimentation over EXISTING CMS page versions — no new
 * content type, no client-side editor, no MVT, no stats engine beyond a
 * two-proportion z-test. A variant is a `PageVersion` reference (or `null` =
 * the reserved HOLDOUT serving the live published content, still tracked).
 * Assignment is sticky/salted/weighted via the SHARED `variantAssignment`
 * helper (extracted from the toggle engine — one bucketing implementation,
 * never a fork) keyed by the CONSENT-GATED anonymous visitor key (the
 * analytics beacon `sessionKey`). No key / no consent ⇒ the plain published
 * page (honest degradation — the publishing seam owns that gate).
 *
 * Promote-winner reuses the EXISTING CMS verbs: `restoreVersion` → the
 * `publish` transition (or `submit` + the approvals inbox when the
 * `cms-approval-gate` is ON — reported honestly as `pendingApproval`).
 *
 * @see docs/adr/0236-cms-page-experiments.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { assignWeightedVariant } from '../../host/variantAssignment.js';
import { createLogger } from '../../observability/logger.js';
import { listEventsForExperiment } from '../analytics/analyticsService.js';
import { registerExperimentStampResolver } from '../analytics/experimentStampResolver.js';
import { isApprovalGateOn, liveEditGateActive, queueContentApproval } from './contentApproval.js';
import { getPage, getVersion, restoreVersion, transitionPage, type Page } from './cmsService.js';

const log = createLogger('feature.cms.experiments');

const MAX = {
  name: 120,
  variantKey: 40,
  variants: 6,
  perPageExperiments: 20,
} as const;

/** Below this many sessions per compared variant, significance is not reported
 *  as a verdict — sample-size honesty over fake precision. */
// ADR 0294 P4 — the shared experiment math lives in host/variantAssignment
// (one z-test + one honesty floor for every experiment surface); re-exported
// here so existing consumers keep their import path.
import { MIN_SESSIONS_PER_VARIANT, Z_95, twoProportionZ } from '../../host/variantAssignment.js';
export { MIN_SESSIONS_PER_VARIANT, twoProportionZ };

export type ExperimentStatus = 'draft' | 'running' | 'stopped' | 'promoted';

export interface ExperimentVariant {
  /** Bounded unique key, e.g. `control` / `B`. */
  key: string;
  /** A CMS `PageVersion.versionId`, or null = the HOLDOUT (live published content). */
  versionId: string | null;
  /** Integer percentage 1..100; the set sums to exactly 100. */
  weight: number;
}

export interface PageExperiment {
  experimentId: string;
  tenantId: string;
  orgId: string;
  pageId: string;
  name: string;
  status: ExperimentStatus;
  /** Assignment salt — fixed at creation so assignment stays sticky for the
   *  experiment's whole life (the toggle-engine salt semantics). */
  salt: string;
  variants: ExperimentVariant[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
}

const experiments = new DurableCollection<PageExperiment>('cms:pageexperiment', (e) => e.experimentId);

function nowIso(): string {
  return new Date().toISOString();
}

// ── Audit (mirrors cmsService.recordCmsAction — payload.tenantId REQUIRED) ───

/** Best-effort `cms.experiment.*` audit row — bookkeeping never fails the write
 *  it describes; `payload.tenantId` is required (the tenant-scoped governance
 *  read withholds rows without it, fail-closed). */
function recordExperimentAction(action: string, exp: PageExperiment, actor: string, extra?: Record<string, unknown>): void {
  const at = nowIso();
  const payload = {
    tenantId: exp.tenantId,
    orgId: exp.orgId,
    pageId: exp.pageId,
    experimentId: exp.experimentId,
    name: exp.name,
    status: exp.status,
    actor,
    at,
    ...extra,
  };
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `cms.experiment.${action}`, resource: exp.experimentId, outcome: 'success', payload })
      .catch((err) => log.warn('experiment audit append failed', { action, experimentId: exp.experimentId, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
}

// ── Validation ───────────────────────────────────────────────────────────────

const VARIANT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

/**
 * ADR 0593 §C3 (CMSA-11) — a variant may only bind a snapshot that was REVIEWED.
 *
 * The class this closes is the same read-time indirection the batch enumerated:
 * a variant's CONTENT is immutable, but WHICH snapshot live traffic gets is
 * chosen by experiment config, and `snapshotPage` fires on SUBMIT as well as on
 * publish — so a version that was submitted and then REJECTED leaves a durable,
 * addressable row that `validateVariants` would happily bind. On a gated org
 * that puts refused content in front of a share of real visitors with no
 * approval row anywhere.
 *
 * The report's prescribed cure — "restrict `versionId` to versions with a
 * `publishedBy` stamp" — is a NO-OP: `publishedBy` is the capturing actor and
 * every row has one, submit-captured rows included. `origin` is the field that
 * actually carries the distinction.
 *
 * Scoped to the gate deliberately. With `cms-approval-gate` OFF the same admin
 * can publish the rejected content outright in one click, so refusing the
 * variant binding buys nothing and only removes a legitimate "test the old
 * content" workflow. And the PAGE's own status is deliberately NOT checked:
 * experiments only run on published pages, so refusing on `published` would
 * disable the whole feature for gated orgs — the gate-with-no-exit shape.
 *
 * ADR 0593 §C8 (adversarial review F2) — AN UNKNOWN ORIGIN IS ALLOWED, and the
 * first version of this guard refusing it was a gate with no exit.
 *
 * The reasoning that produced the refusal was the CMSA-7 rule ("a guard that
 * cannot identify its subject must refuse"). Building the exit falsified it
 * here, because CMSA-7's refusal REPINS THE ROW IN THE SAME CALL — it refuses
 * once and then can succeed. This one cannot: to make an unstamped historic
 * snapshot bindable you must publish it, publishing it means `restoreVersion`,
 * and `restoreVersion` BUMPS `page.version`, so the publish mints a NEW row and
 * the bound `versionId` keeps its unstamped row forever. The prescribed exit
 * did not work. And `updateExperiment` refuses a non-`draft` experiment, so a
 * STOPPED experiment could not be repointed either — on the deploy that added
 * this field, every pre-existing row is unstamped, so every gated org's stopped
 * experiment would have become unrestartable with `deleteExperiment` (which
 * discards the salt and orphans its analytics) as the only escape.
 *
 * So the guard refuses only what it can POSITIVELY identify. The residual is
 * stated rather than hidden: on a gated org, a snapshot captured before this
 * field existed can still be bound even if it was rejected. It is bounded
 * (history is capped at 50 rows per page, so unstamped rows age out and every
 * new capture is stamped) and it is transitional, which a permanent dead end
 * for a working feature is not. This is the same posture the batch's own
 * `aiDraftedLocales` takes for pre-fix rows: absence makes no claim.
 */
async function assertVariantSnapshotReviewed(
  tenantId: string,
  orgId: string,
  variantKey: string,
  version: { versionId: string; version: number; origin?: 'publish' | 'submit' },
): Promise<void> {
  if (version.origin !== 'submit') return; // 'publish' ⇒ reviewed; undefined ⇒ unidentifiable, see above
  // ADR 0593 §C9 (review F3) — `liveEditGateActive`, NOT a fourth hand-written
  // composition of "is the gate in force". This called `isApprovalGateOn`
  // directly and was therefore the ONLY gate in the feature that did not
  // exempt the reserved system site — whose rationale (no members, no
  // approvers, no route to one) applies here unchanged. Fail-safe, but it is
  // C1's own root cause recurring inside the PR that hoisted the one owner.
  if (!(await liveEditGateActive(tenantId, orgId))) return;
  throw new OpenwopError(
    'conflict',
    `Publishing is gated on approval — variant \`${variantKey}\` points at version ${version.version}, which was captured when the page was submitted for review and never approved. Point the variant at a published version, or use the holdout.`,
    409,
    { gate: 'cms-approval-gate', reason: 'unreviewed_snapshot', key: variantKey, versionId: version.versionId },
  );
}

/** Validate + normalize the variant set: 2..MAX variants, bounded unique keys,
 *  integer weights 1..100 summing to exactly 100, and every non-null versionId
 *  an EXISTING version of THIS page (IDOR-guarded through `getVersion`). */
async function validateVariants(tenantId: string, orgId: string, pageId: string, raw: unknown): Promise<ExperimentVariant[]> {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new OpenwopError('validation_error', 'An experiment needs at least 2 variants.', 400, { field: 'variants' });
  }
  if (raw.length > MAX.variants) {
    throw new OpenwopError('validation_error', `At most ${MAX.variants} variants.`, 400, { field: 'variants', max: MAX.variants });
  }
  const out: ExperimentVariant[] = [];
  const keys = new Set<string>();
  for (const v of raw) {
    const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key.trim() : '';
    if (!key || key.length > MAX.variantKey || !VARIANT_KEY_RE.test(key)) {
      throw new OpenwopError('validation_error', `Each variant needs a key (1..${MAX.variantKey} chars, alphanumeric/space/_/-).`, 400, { field: 'variants', key: r.key });
    }
    if (keys.has(key)) {
      throw new OpenwopError('validation_error', `Duplicate variant key \`${key}\`.`, 400, { field: 'variants', key });
    }
    keys.add(key);
    const weight = r.weight;
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1 || weight > 100) {
      throw new OpenwopError('validation_error', 'Each variant weight must be an integer 1..100.', 400, { field: 'variants', key, weight });
    }
    let versionId: string | null = null;
    if (r.versionId !== null && r.versionId !== undefined && r.versionId !== '') {
      if (typeof r.versionId !== 'string') {
        throw new OpenwopError('validation_error', '`versionId` must be a version id string or null (holdout).', 400, { field: 'variants', key });
      }
      const version = await getVersion(tenantId, orgId, pageId, r.versionId);
      if (!version) {
        throw new OpenwopError('validation_error', `Variant \`${key}\` references a version that does not exist for this page.`, 400, { field: 'variants', key, versionId: r.versionId });
      }
      await assertVariantSnapshotReviewed(tenantId, orgId, key, version); // ADR 0593 §C3
      versionId = r.versionId;
    }
    out.push({ key, versionId, weight });
  }
  const total = out.reduce((s, v) => s + v.weight, 0);
  if (total !== 100) {
    throw new OpenwopError('validation_error', `Variant weights must sum to exactly 100 (got ${total}).`, 400, { field: 'variants', total });
  }
  return out;
}

async function requirePage(tenantId: string, orgId: string, pageId: string): Promise<Page> {
  const page = await getPage(tenantId, orgId, pageId);
  if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId });
  return page;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listExperiments(tenantId: string, orgId: string, pageId: string): Promise<PageExperiment[]> {
  return (await experiments.list())
    .filter((e) => e.tenantId === tenantId && e.orgId === orgId && e.pageId === pageId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getExperiment(tenantId: string, orgId: string, pageId: string, experimentId: string): Promise<PageExperiment | null> {
  const e = await experiments.get(experimentId);
  return e && e.tenantId === tenantId && e.orgId === orgId && e.pageId === pageId ? e : null;
}

export async function createExperiment(input: {
  tenantId: string;
  orgId: string;
  pageId: string;
  name: string;
  variants: unknown;
  createdBy: string;
}): Promise<PageExperiment> {
  await requirePage(input.tenantId, input.orgId, input.pageId);
  const existing = await listExperiments(input.tenantId, input.orgId, input.pageId);
  if (existing.length >= MAX.perPageExperiments) {
    throw new OpenwopError('validation_error', `This page has the maximum ${MAX.perPageExperiments} experiments — delete finished ones first.`, 409, { max: MAX.perPageExperiments });
  }
  const ts = nowIso();
  const exp: PageExperiment = {
    experimentId: `pexp:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    pageId: input.pageId,
    name: cleanString(input.name, MAX.name, 'Untitled experiment'),
    status: 'draft',
    salt: `pexp-salt:${randomUUID()}`,
    variants: await validateVariants(input.tenantId, input.orgId, input.pageId, input.variants),
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await experiments.put(exp);
  recordExperimentAction('create', exp, input.createdBy);
  return exp;
}

/** Edit a DRAFT experiment (name/variants). Running/finished experiments are
 *  immutable — editing weights mid-flight would silently reshuffle visitors. */
export async function updateExperiment(
  tenantId: string,
  orgId: string,
  pageId: string,
  experimentId: string,
  patch: { name?: string; variants?: unknown },
  actor: string,
): Promise<PageExperiment | null> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return null;
  if (exp.status !== 'draft') {
    throw new OpenwopError('validation_error', `Only a draft experiment can be edited (status: \`${exp.status}\`).`, 409, { status: exp.status });
  }
  const next: PageExperiment = { ...exp, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanString(patch.name, MAX.name, exp.name);
  if (patch.variants !== undefined) next.variants = await validateVariants(tenantId, orgId, pageId, patch.variants);
  await experiments.put(next);
  recordExperimentAction('update', next, actor);
  return next;
}

/** Delete a non-running experiment (stop it first — deleting a live assignment
 *  config out from under visitors is never one click). */
export async function deleteExperiment(tenantId: string, orgId: string, pageId: string, experimentId: string, actor: string): Promise<boolean> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return false;
  if (exp.status === 'running') {
    throw new OpenwopError('conflict', 'Stop the experiment before deleting it.', 409, { status: exp.status });
  }
  await experiments.delete(experimentId);
  recordExperimentAction('delete', exp, actor);
  return true;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Per-page in-process serialization of the start transition (grade-code
// AUDIT-14): the one-running-per-page check was check-then-put with awaits
// between — two concurrent starts of different experiments on the same page
// both saw none-running and both went live, contaminating each other's
// measurement. Serializing per (tenant,page) closes the same-instance race (the
// dominant case for an admin action); the withSendLock precedent from
// emailService. Cross-instance concurrency remains a documented residual.
const startLocks = new Map<string, Promise<unknown>>();
async function withStartLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = startLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => gate);
  startLocks.set(key, chained);
  await prev.catch(() => undefined);
  try { return await fn(); }
  finally { release(); if (startLocks.get(key) === chained) startLocks.delete(key); }
}

/** Start a draft/stopped experiment. ONE running experiment per page — two
 *  concurrent assignments over the same page would contaminate each other's
 *  measurement (serialized per page; see withStartLock). */
export async function startExperiment(tenantId: string, orgId: string, pageId: string, experimentId: string, actor: string): Promise<PageExperiment | null> {
  return withStartLock(`${tenantId}::${orgId}::${pageId}`, async () => {
    const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
    if (!exp) return null;
    if (exp.status !== 'draft' && exp.status !== 'stopped') {
      throw new OpenwopError('validation_error', `Cannot start an experiment in status \`${exp.status}\`.`, 409, { status: exp.status });
    }
    const running = (await listExperiments(tenantId, orgId, pageId)).find((e) => e.status === 'running');
    if (running) {
      throw new OpenwopError('conflict', `Another experiment is already running on this page (\`${running.name}\`).`, 409, { runningExperimentId: running.experimentId });
    }
    // Re-validate variant version references at start time — a referenced
    // snapshot may have aged out of the per-page version cap since creation.
    //
    // ADR 0593 §C3 (CMSA-11) — and re-check the REVIEW stamp here rather than
    // trusting the create-time check: the gate may have been turned ON since
    // (the CMSA-4 lesson — a decision taken from a toggle read in an earlier
    // request is not a decision), and START is the moment content reaches live
    // traffic. This route is the one the class table missed.
    for (const v of exp.variants) {
      if (!v.versionId) continue;
      const version = await getVersion(tenantId, orgId, pageId, v.versionId);
      if (!version) {
        throw new OpenwopError('conflict', `Variant \`${v.key}\` references a version that no longer exists.`, 409, { key: v.key, versionId: v.versionId });
      }
      await assertVariantSnapshotReviewed(tenantId, orgId, v.key, version);
    }
    const next: PageExperiment = { ...exp, status: 'running', startedAt: nowIso(), updatedAt: nowIso() };
    delete next.stoppedAt;
    await experiments.put(next);
    recordExperimentAction('start', next, actor);
    return next;
  });
}

export async function stopExperiment(tenantId: string, orgId: string, pageId: string, experimentId: string, actor: string): Promise<PageExperiment | null> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return null;
  if (exp.status !== 'running') {
    throw new OpenwopError('validation_error', `Cannot stop an experiment in status \`${exp.status}\`.`, 409, { status: exp.status });
  }
  const next: PageExperiment = { ...exp, status: 'stopped', stoppedAt: nowIso(), updatedAt: nowIso() };
  await experiments.put(next);
  recordExperimentAction('stop', next, actor);
  return next;
}

// ── Assignment (the shared sticky/salted/weighted helper) ────────────────────

/** Sticky variant for a visitor key — pure + deterministic (the extracted
 *  toggle-engine math; same key ⇒ same variant for this experiment's life). */
export function assignVariantForVisitor(experiment: PageExperiment, visitorKey: string): ExperimentVariant | null {
  const key = assignWeightedVariant(visitorKey, experiment.experimentId, experiment.salt, experiment.variants);
  return key ? experiment.variants.find((v) => v.key === key) ?? null : null;
}

/** The page's RUNNING experiment, if any (at most one — enforced at start). */
export async function findRunningExperiment(tenantId: string, orgId: string, pageId: string): Promise<PageExperiment | null> {
  return (await listExperiments(tenantId, orgId, pageId)).find((e) => e.status === 'running') ?? null;
}

// ── Promote winner (EXISTING CMS verbs — no republish machinery) ────────────

export interface PromoteResult {
  experiment: PageExperiment;
  /** True when the org gates publishing: the restore landed and the page was
   *  SUBMITTED to the approvals inbox — it is NOT live yet (and the page left
   *  the public surface until the reviewer decides). Honest, not hidden. */
  pendingApproval: boolean;
  /** The page after the promote verbs ran (null on the holdout no-op path). */
  page: Page | null;
}

/**
 * Promote a variant of a RUNNING experiment, then stop it (status `promoted`).
 *   holdout (versionId null) → nothing to publish; the live page already IS the
 *     winner — the experiment just ends.
 *   version variant → `restoreVersion` (existing verb; page → draft) then the
 *     `publish` transition — or, when `cms-approval-gate` is ON, `submit` + the
 *     shared approvals queue (the inbox is the ONLY publish path for a gated
 *     org; promote reports `pendingApproval: true` rather than bypassing it).
 */
export async function promoteExperiment(
  tenantId: string,
  orgId: string,
  pageId: string,
  experimentId: string,
  variantKey: string,
  actor: string,
): Promise<PromoteResult | null> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return null;
  if (exp.status !== 'running') {
    throw new OpenwopError('validation_error', `Cannot promote from status \`${exp.status}\` — only a running experiment has a winner to promote.`, 409, { status: exp.status });
  }
  const variant = exp.variants.find((v) => v.key === variantKey);
  if (!variant) {
    throw new OpenwopError('validation_error', `\`${variantKey}\` is not a variant of this experiment.`, 400, { variantKey });
  }

  let page: Page | null = null;
  let pendingApproval = false;
  if (variant.versionId !== null) {
    // EXISTING verbs only. restoreVersion → draft (it audits `cms.restore`
    // itself); then the same publish/approval composition the CMS routes use.
    // ADR 0593 CORRECTION (review F5) — the review closure happens HERE, inside
    // `restoreVersion`, because this call runs first and unconditionally. The
    // arm below used to call `rejectPendingApprovalForPage` itself; that was
    // DEAD CODE (the row was already resolved, so the CAS refused) and it
    // recorded the restore's generic note as the cause. Deleting it changed
    // nothing observable — which is exactly how its own test was vacuous.
    page = await restoreVersion(
      tenantId, orgId, pageId, variant.versionId, actor,
      `Closed automatically — superseded by promoting experiment winner "${variant.key}".`,
    );
    if (!page) return null; // page deleted between read and restore
    // ADR 0593 (CMSA-4 / CMSAWF-2) — ONE gate predicate (`isApprovalGateOn`),
    // and the gated arm queues UNCONDITIONALLY. This was the last caller of
    // `queueContentApprovalIfGated`, and it re-read the toggle four lines after
    // reading it here: a flip in that window left the page `in_review` with NO
    // row on the inbox lane. Post-C1 doctrine is that a submit always queues.
    if (await isApprovalGateOn(tenantId)) {
      page = await transitionPage(tenantId, orgId, pageId, 'submit', actor);
      if (page) {
        await queueContentApproval(tenantId, orgId, page, `Publish experiment winner "${variant.key}" of "${exp.name}" (page "${page.title}")`);
      }
      pendingApproval = true;
    } else {
      page = await transitionPage(tenantId, orgId, pageId, 'publish', actor);
    }
  }

  const done: PageExperiment = { ...exp, status: 'promoted', stoppedAt: nowIso(), updatedAt: nowIso() };
  await experiments.put(done);
  recordExperimentAction('promote', done, actor, { variantKey, pendingApproval, holdout: variant.versionId === null });
  return { experiment: done, pendingApproval, page };
}

// ── Results (read-time projection over stamped analytics events) ─────────────

export interface VariantResult {
  key: string;
  versionId: string | null;
  weight: number;
  /** Distinct beacon sessions stamped with this variant. */
  sessions: number;
  /** Distinct sessions with a stamped `conversion` event. */
  conversions: number;
  /** conversions / sessions (0 when no sessions). */
  conversionRate: number;
  /** Two-proportion z vs the FIRST variant (the baseline; null on the baseline
   *  itself, or when either side has zero sessions / zero pooled variance). */
  zScore: number | null;
  /** |z| ≥ 1.96 — two-sided 95%. Only reported when the sample is sufficient. */
  significant: boolean | null;
  /** True below MIN_SESSIONS_PER_VARIANT sessions on this variant or the
   *  baseline — the honest "not enough data for a verdict" flag. */
  insufficientSample: boolean;
}

export interface ExperimentResults {
  experimentId: string;
  status: ExperimentStatus;
  baselineKey: string;
  minSessionsPerVariant: number;
  variants: VariantResult[];
  /** ANL-18 / ANL-UX-29 — stamps this projection did NOT count. `legacy`: rows
   *  stamped BEFORE ADR 0651 D3 made stamps server-derived (client-claimed, so
   *  untrusted — the pre-fix forgery window is quarantined, not counted);
   *  `dropped`: rows whose stamp was refused at ingest for THIS experiment. */
  unattributed: { legacy: number; dropped: number };
}

/** Per-variant sessions/conversions/rate + significance vs the first variant —
 *  a READ-TIME projection over the stamped analytics events (never a second
 *  event store; the cross-feature read goes through the analytics service). */
export async function experimentResults(tenantId: string, orgId: string, pageId: string, experimentId: string): Promise<ExperimentResults | null> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return null;
  const events = await listEventsForExperiment(tenantId, orgId, experimentId);
  const sessionsByVariant = new Map<string, Set<string>>();
  const conversionsByVariant = new Map<string, Set<string>>();
  let legacy = 0; let dropped = 0;
  for (const e of events) {
    if (e.experimentDropped?.id === experimentId && !e.experiment) { dropped += 1; continue; }
    if (!e.sessionKey || !e.experiment) continue;
    // ANL-18 — only a SERVER-DERIVED stamp counts. A pre-D3 row carries the
    // client's claim verbatim; counting it would let last week's forgery still
    // decide `significant` (and the promote that follows).
    if (e.experiment.derived !== true) { legacy += 1; continue; }
    const v = e.experiment.variant;
    if (!sessionsByVariant.has(v)) { sessionsByVariant.set(v, new Set()); conversionsByVariant.set(v, new Set()); }
    sessionsByVariant.get(v)!.add(e.sessionKey);
    if (e.type === 'conversion') conversionsByVariant.get(v)!.add(e.sessionKey);
  }
  const baseline = exp.variants[0]!;
  const baseSessions = sessionsByVariant.get(baseline.key)?.size ?? 0;
  const baseConversions = conversionsByVariant.get(baseline.key)?.size ?? 0;
  const variants: VariantResult[] = exp.variants.map((v, i) => {
    const sessions = sessionsByVariant.get(v.key)?.size ?? 0;
    const conversions = conversionsByVariant.get(v.key)?.size ?? 0;
    const conversionRate = sessions > 0 ? conversions / sessions : 0;
    const insufficientSample = sessions < MIN_SESSIONS_PER_VARIANT || (i > 0 && baseSessions < MIN_SESSIONS_PER_VARIANT);
    const z = i === 0 ? null : twoProportionZ(baseConversions, baseSessions, conversions, sessions);
    return {
      key: v.key,
      versionId: v.versionId,
      weight: v.weight,
      sessions,
      conversions,
      conversionRate,
      zScore: z,
      // A verdict only with enough data AND a defined test — otherwise null,
      // never a fake "not significant".
      significant: i === 0 || insufficientSample || z === null ? null : Math.abs(z) >= Z_95,
      insufficientSample,
    };
  });
  return { experimentId: exp.experimentId, status: exp.status, baselineKey: baseline.key, minSessionsPerVariant: MIN_SESSIONS_PER_VARIANT, variants, unattributed: { legacy, dropped } };
}

// ── Test-only reset ──────────────────────────────────────────────────────────
/** ADR 0592 §8 (CMSLWF-9) — anonymize experiment creator attribution for an
 *  erased subject (any key FORM). Anonymize-not-delete: the experiment and its
 *  results are org data; the attribution is the subject-bearing field. */
export async function erasePageExperimentSubject(
  tenantId: string,
  subjectForms: ReadonlySet<string>,
  sentinel: string,
): Promise<number> {
  let touched = 0;
  for (const e of await experiments.list()) {
    if (e.tenantId !== tenantId) continue;
    if (typeof e.createdBy === 'string' && subjectForms.has(e.createdBy)) {
      await experiments.put({ ...e, createdBy: sentinel });
      touched += 1;
    }
  }
  return touched;
}

// ANLWF-3 / ADR 0651 D3 — arm the ingest-side stamp resolver. The collection is
// keyed by `experimentId` alone, so no `pageId` is needed (the beacon does not
// carry one). A stamp resolves ONLY for a running experiment that belongs to this
// tenant+org, and the variant is the deterministic assignment for THIS session —
// the client's claimed variant is never consulted.
// ANL-22 (grade-code 2026-09-10) — `stopped` is ACCEPTED alongside `running`: the
// assignment is deterministic per session, so a visitor assigned while running who
// converts after Stop is attributed to the variant they actually saw. Refusing it
// deflated whichever variant converts more slowly and made the verdict depend on
// stop timing. `draft`/`promoted` never assigned this session ⇒ `not_running`.
export function registerCmsExperimentStampResolver(): void {
  registerExperimentStampResolver(async (tenantId, orgId, experimentId, sessionKey) => {
    const exp = await experiments.get(experimentId);
    if (!exp || exp.tenantId !== tenantId || exp.orgId !== orgId) return { ok: false, reason: 'unknown' };
    if (exp.status !== 'running' && exp.status !== 'stopped') return { ok: false, reason: 'not_running', id: exp.experimentId };
    const v = assignVariantForVisitor(exp, sessionKey);
    return v ? { ok: true, id: exp.experimentId, variant: v.key } : { ok: false, reason: 'not_running', id: exp.experimentId };
  });
}
