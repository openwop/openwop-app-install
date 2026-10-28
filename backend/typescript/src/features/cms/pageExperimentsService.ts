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
import { assignArm } from '../../host/experiments/assign.js';
import { deleteFirstExposures, stickyAssign } from '../../host/experiments/sticky.js';
import { assignAt } from '../../host/experiments/runFreeze.js';
import { checkPromotionGates } from '../../host/experiments/promotion.js';
import type { GateReport } from '../../host/experiments/gates.js';
import { deleteExperimentRow, getExperimentRow, insertExperimentRowIfAbsent, listExperimentRows, listTenantExperimentRows, mutateExperimentRow, putExperimentRow } from '../../host/experiments/store.js';
import type { Experiment } from '../../host/experiments/types.js';
import type { LegacyResultHealth } from '../../host/experiments/legacyHealth.js';
import { projectLegacyResults } from '../../host/experiments/legacyProjection.js';
import { deleteExperimentRollup } from '../../host/experiments/rollup.js';
import { createLogger } from '../../observability/logger.js';
import { featureAccessRefusal, type LaunchSubject } from '../../host/workflowFeatureGate.js';
import { listEventsForExperiment } from '../analytics/analyticsService.js';
import { registerExperimentStampResolver } from '../analytics/experimentStampResolver.js';
import { isApprovalGateOn, liveEditGateActive, queueContentApproval } from './contentApproval.js';
import { advancePagePromotion, preparePagePromotion, assertNoPublishBlockers, recordPageUnpublishedByRestore, getPage, getVersion, restoreVersion, transitionPage, type Page } from './cmsService.js';

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
import { MIN_SESSIONS_PER_VARIANT, twoProportionZ } from '../../host/variantAssignment.js';
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
  /** ADR 0949 P4 — set (internal) when the engine row is an Optimize experiment,
   *  so the public serving path reads the first-exposure store only for those. */
  engineMode?: 'optimize' | 'ramp';
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

/**
 * ADR 0949 P1a — EXPAND/CONTRACT. The engine store (`host/experiments/store.ts`)
 * is the system of record. This legacy collection WAS its rollback mirror
 * (P1a/P1b), for images older than P1a, which read only this collection. ADR
 * 0949 P2c contracted it: nothing writes it any more, an org's rows are still
 * imported once on that org's first read, and `contractLegacyCmsExperiments`
 * (every boot; a no-op once the collection is empty) imports what was never
 * read and deletes every row. The rollback target (P2b and later) reads the
 * engine, so it still finds every experiment.
 */
const legacyMirror = new DurableCollection<PageExperiment>('cms:pageexperiment', (e) => e.experimentId);

/** The engine surface kind for a CMS page experiment. */
export const CMS_PAGE_SURFACE = 'cms.page';

/** PageExperiment → the engine's Experiment (ADR 0949 D5: legacy, same id,
 *  same salt, same arm order and weights, so assignment is byte-identical). */
export function toEngineExperiment(p: PageExperiment): Experiment {
  const weights = Object.fromEntries(p.variants.map((v) => [v.key, v.weight]));
  return {
    experimentId: p.experimentId, tenantId: p.tenantId, orgId: p.orgId,
    name: p.name, hypothesis: '',
    surface: { kind: CMS_PAGE_SURFACE, ref: p.pageId },
    unit: 'visitor',
    design: { type: p.variants.length > 2 ? 'abn' : 'ab' },
    arms: p.variants.map((v) => ({ key: v.key, ref: v.versionId, weight: v.weight })),
    mode: 'decide', status: p.status, salt: p.salt,
    epochs: p.startedAt ? [{ epoch: 0, weights, at: p.startedAt, reason: 'launch' }] : [],
    legacy: true,
    createdBy: p.createdBy, createdAt: p.createdAt, updatedAt: p.updatedAt,
    ...(p.startedAt ? { startedAt: p.startedAt } : {}),
    ...(p.stoppedAt ? { stoppedAt: p.stoppedAt } : {}),
  };
}

const LEGACY_STATUSES: ReadonlyArray<ExperimentStatus> = ['draft', 'running', 'stopped', 'promoted'];

/** The engine's Experiment → the CMS PageExperiment view (null for a row that is
 *  not a CMS page experiment or carries a status the CMS model cannot hold). */
export function fromEngineExperiment(e: Experiment): PageExperiment | null {
  if (e.surface.kind !== CMS_PAGE_SURFACE || !LEGACY_STATUSES.includes(e.status as ExperimentStatus)) return null;
  return {
    experimentId: e.experimentId, tenantId: e.tenantId, orgId: e.orgId, pageId: e.surface.ref,
    name: e.name, status: e.status as ExperimentStatus, salt: e.salt,
    variants: e.arms.map((a) => ({ key: a.key, versionId: a.ref, weight: a.weight })),
    ...(e.mode === 'optimize' ? { engineMode: 'optimize' as const } : e.epochs.some((x) => x.layout) ? { engineMode: 'ramp' as const } : {}),
    createdBy: e.createdBy, createdAt: e.createdAt, updatedAt: e.updatedAt,
    ...(e.startedAt ? { startedAt: e.startedAt } : {}),
    ...(e.stoppedAt ? { stoppedAt: e.stoppedAt } : {}),
  };
}

/** One durable marker per (tenant, org): its legacy rows are in the engine.
 *  The org lives in the key only: a row with an `orgId` field counts as org
 *  business data, and `deleteOrg` refuses while any exists (RI-7), so a marker
 *  must never keep an emptied org alive. */
const migrations = new DurableCollection<{ key: string; tenantId: string; at: string }>(
  'experiments:legacy-migration', (m) => m.key, undefined, (m) => m.tenantId,
);

/**
 * Migrate an org's legacy rows into the engine, once. The legacy collection has
 * no tenant index, so this is a full scan, run at most once per (tenant, org):
 * the marker is written last, and after it every read is a point read or an
 * org prefix. `insertIfAbsent` never overwrites an engine row written since.
 */
async function ensureOrgMigrated(tenantId: string, orgId: string): Promise<void> {
  const markerKey = `${tenantId}::${orgId}::${CMS_PAGE_SURFACE}`;
  if (await migrations.get(markerKey)) return;
  for (const row of await legacyMirror.list()) {
    if (row.tenantId === tenantId && row.orgId === orgId) await insertExperimentRowIfAbsent(toEngineExperiment(row));
  }
  await migrations.put({ key: markerKey, tenantId, at: nowIso() });
}

/** Write through the engine (authoritative), then mirror for rollback. */
async function saveExperiment(exp: PageExperiment, expectedStatus?: ExperimentStatus): Promise<void> {
  // ADR 0949 P2a — an engine-managed (Decide) experiment carries fields the CMS
  // shape cannot hold (plan, hypothesis, mode, epochs). Rebuilding the row from
  // the CMS shape would strip them, so only the lifecycle fields are merged.
  const current = await getExperimentRow(exp.tenantId, exp.orgId, exp.experimentId);
  if (current && current.legacy !== true) {
    const saved = await mutateExperimentRow(exp.tenantId, exp.orgId, exp.experimentId, (row) => {
      if (row.legacy === true || row.status !== (expectedStatus ?? current.status)) {
        throw new OpenwopError('conflict', 'The experiment changed before its lifecycle update.', 409, { reason: 'experiment_changed' });
      }
      const next: Experiment = { ...row, status: exp.status, updatedAt: exp.updatedAt };
      if (exp.startedAt) next.startedAt = exp.startedAt; else delete next.startedAt;
      if (exp.stoppedAt) next.stoppedAt = exp.stoppedAt; else delete next.stoppedAt;
      return next;
    });
    if (!saved) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
  } else {
    await putExperimentRow(toEngineExperiment(exp));
  }
}

/**
 * ADR 0949 P2c — the contract step. Every legacy row goes: a row of an org
 * already imported (its marker exists) is only deleted, because the engine has
 * had it since that import (and a user may have deleted it there since, so
 * re-importing would resurrect it); a row of an org never read is imported
 * (insert-if-absent) and then deleted. Idempotent, and safe on two instances at
 * once. One full scan of what is left, so after the first run it scans an empty
 * collection (production held 0 rows on 2026-10-26).
 */
export async function contractLegacyCmsExperiments(): Promise<{ imported: number; deleted: number }> {
  let imported = 0;
  let deleted = 0;
  for (const row of await legacyMirror.list()) {
    const marked = await migrations.get(`${row.tenantId}::${row.orgId}::${CMS_PAGE_SURFACE}`);
    if (!marked && await insertExperimentRowIfAbsent(toEngineExperiment(row))) imported += 1;
    if (await legacyMirror.delete(row.experimentId)) deleted += 1;
  }
  if (imported || deleted) log.info('legacy cms experiments contracted', { imported, deleted });
  return { imported, deleted };
}

/** Boot hook: run the contract once, in the background; a failure is logged
 *  and the next boot retries (every step is idempotent). */
export function startLegacyCmsExperimentContract(): void {
  void contractLegacyCmsExperiments().catch((err: unknown) => {
    log.warn('legacy cms experiment contract failed; it reruns on the next boot', { error: err instanceof Error ? err.message : String(err) });
  });
}

/** ADR 0949 P2a — the CMS experiment routes edit, start, stop, delete and
 *  promote LEGACY experiments only. An engine-managed (Decide) experiment
 *  changes through the experiments routes, which hold its plan lock. */
async function assertNotManaged(tenantId: string, orgId: string, experimentId: string): Promise<void> {
  const row = await getExperimentRow(tenantId, orgId, experimentId);
  if (row && row.legacy !== true) {
    throw new OpenwopError('conflict', 'This experiment is managed in Experiments; change it there.', 409, { reason: 'managed_by_experiments', experimentId });
  }
}

/** For the experiments engine's `cms.page` adapter: the CMS variant rules
 *  (versions of this page, weights summing to 100) over engine arms. */
export async function validateCmsArms(tenantId: string, orgId: string, pageId: string, arms: ReadonlyArray<{ key: string; ref: string | null; weight: number }>): Promise<void> {
  await requirePage(tenantId, orgId, pageId);
  await validateVariants(tenantId, orgId, pageId, arms.map((a) => ({ key: a.key, versionId: a.ref, weight: a.weight })));
}

async function readExperiment(tenantId: string, orgId: string, experimentId: string): Promise<PageExperiment | null> {
  await ensureOrgMigrated(tenantId, orgId);
  const row = await getExperimentRow(tenantId, orgId, experimentId);
  return row ? fromEngineExperiment(row) : null;
}

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
  version: { versionId: string; version: number; origin?: 'publish' | 'submit' | 'seed'; promotionBaseline?: unknown },
): Promise<void> {
  if (version.promotionBaseline) {
    throw new OpenwopError('conflict', 'An internal rollback capture cannot be an experiment arm.', 409,
      { reason: 'internal_snapshot', key: variantKey, versionId: version.versionId });
  }
  // ADR 0817 — a seed offer was never the page's content, gate or no gate:
  // a person adopts it with Restore, then publishes the page they reviewed.
  if (version.origin === 'seed') {
    throw new OpenwopError(
      'conflict',
      `Variant \`${variantKey}\` points at a seeded update the page never adopted. Restore it into the draft and publish first, or point the variant at a published version.`,
      409,
      { reason: 'seed_offer', key: variantKey, versionId: version.versionId },
    );
  }
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
  // ADR 0949 P1a — an org prefix on the engine store; the old full
  // cross-tenant `list()` ran on every published-page read (findRunningExperiment).
  await ensureOrgMigrated(tenantId, orgId);
  return (await listExperimentRows(tenantId, orgId, { kind: CMS_PAGE_SURFACE, ref: pageId }))
    .map(fromEngineExperiment)
    .filter((e): e is PageExperiment => e !== null && e.pageId === pageId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getExperiment(tenantId: string, orgId: string, pageId: string, experimentId: string): Promise<PageExperiment | null> {
  const e = await readExperiment(tenantId, orgId, experimentId);
  return e && e.pageId === pageId ? e : null;
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
  await saveExperiment(exp);
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
  await assertNotManaged(tenantId, orgId, experimentId);
  if (exp.status !== 'draft') {
    throw new OpenwopError('validation_error', `Only a draft experiment can be edited (status: \`${exp.status}\`).`, 409, { status: exp.status });
  }
  const next: PageExperiment = { ...exp, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanString(patch.name, MAX.name, exp.name);
  if (patch.variants !== undefined) next.variants = await validateVariants(tenantId, orgId, pageId, patch.variants);
  await saveExperiment(next);
  recordExperimentAction('update', next, actor);
  return next;
}

/** Delete a non-running experiment (stop it first — deleting a live assignment
 *  config out from under visitors is never one click). */
export async function deleteExperiment(tenantId: string, orgId: string, pageId: string, experimentId: string, actor: string, opts: { pageCascade?: boolean } = {}): Promise<boolean> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return false;
  // A deleted page takes every experiment on it, managed or not.
  if (!opts.pageCascade) await assertNotManaged(tenantId, orgId, experimentId);
  if (exp.status === 'running') {
    throw new OpenwopError('conflict', 'Stop the experiment before deleting it.', 409, { status: exp.status });
  }
  await deleteExperimentRow(tenantId, orgId, experimentId);
  await deleteExperimentRollup(tenantId, orgId, experimentId);
  await deleteFirstExposures({ tenantId, experimentId });
  await legacyMirror.delete(experimentId).catch(() => false);
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
export async function startExperiment(tenantId: string, orgId: string, pageId: string, experimentId: string, actor: string, opts: { managed?: boolean } = {}): Promise<PageExperiment | null> {
  return withStartLock(`${tenantId}::${orgId}::${pageId}`, async () => {
    const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
    if (!exp) return null;
    if (!opts.managed) await assertNotManaged(tenantId, orgId, experimentId);
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
      // ADR 0836 D9 — START serves the variant to visitors, so it meets the
      // publish blockers (a seed offer is a version row too, and may carry one).
      assertNoPublishBlockers({ pageId, sections: version.snapshot.sections });
    }
    const next: PageExperiment = { ...exp, status: 'running', startedAt: nowIso(), updatedAt: nowIso() };
    delete next.stoppedAt;
    await saveExperiment(next, exp.status);
    recordExperimentAction('start', next, actor);
    return next;
  });
}

export async function stopExperiment(tenantId: string, orgId: string, pageId: string, experimentId: string, actor: string, opts: { managed?: boolean } = {}): Promise<PageExperiment | null> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return null;
  if (!opts.managed) await assertNotManaged(tenantId, orgId, experimentId);
  if (exp.status !== 'running') {
    throw new OpenwopError('validation_error', `Cannot stop an experiment in status \`${exp.status}\`.`, 409, { status: exp.status });
  }
  const next: PageExperiment = { ...exp, status: 'stopped', stoppedAt: nowIso(), updatedAt: nowIso() };
  await saveExperiment(next, exp.status);
  recordExperimentAction('stop', next, actor);
  return next;
}

// ── Assignment (the shared sticky/salted/weighted helper) ────────────────────

/** Sticky variant for a visitor key — pure + deterministic (the extracted
 *  toggle-engine math; same key ⇒ same variant for this experiment's life). */
export function assignVariantForVisitor(experiment: PageExperiment, visitorKey: string): ExperimentVariant | null {
  // ADR 0949 D3 — the engine's one assignment function (byte-identical: same
  // scope = experiment id, same salt, same arm order and weights).
  const arm = assignArm(toEngineExperiment(experiment), visitorKey);
  return arm ? experiment.variants.find((v) => v.key === arm.key) ?? null : null;
}

/** ADR 0950 P0 — the promotion gates for a page experiment, read-only. Reading
 *  them reads the analytics projection, so it needs `analytics` like the
 *  results (ADR 0820 §7). Null when the experiment is not on this page. */
export async function experimentGates(tenantId: string, orgId: string, pageId: string, experimentId: string, subject: LaunchSubject = {}): Promise<GateReport | null> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return null;
  const refusal = await featureAccessRefusal(EXPERIMENT_RESULTS_SOURCE_FEATURE, tenantId, subject);
  if (refusal) {
    throw new OpenwopError('forbidden', 'Promotion checks read Analytics, which is not available in this workspace.', 403,
      { feature: EXPERIMENT_RESULTS_SOURCE_FEATURE, reason: refusal === 'plan' ? 'not_entitled' : refusal === 'unresolved' ? 'feature_unavailable' : 'feature_disabled' });
  }
  const row = await getExperimentRow(tenantId, orgId, experimentId);
  return row ? checkPromotionGates(row, nowIso()) : null;
}

/** ADR 0950: reconcile the CMS-owned receipt, using the existing restore,
 * transition and approval owners. Every content write advances the receipt in
 * its primary CAS, so lost acknowledgements never replay a publish. */
async function reconcilePagePromotion(
  tenantId: string, orgId: string, pageId: string, experimentId: string, winnerRef: string | null,
  actor: string, title: string, operation: 'finalize' | 'rollback',
): Promise<{ baselineRef: string | null; pendingApproval: boolean }> {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const page = await preparePagePromotion(tenantId, orgId, pageId, experimentId, winnerRef, actor, operation);
      const receipt = page.promotionReceipts![experimentId]!;
      const guard = (to: typeof receipt.phase, pendingApproval?: boolean) => ({ experimentId, from: receipt.phase, to,
        ...(pendingApproval === undefined ? {} : { pendingApproval }) });
      const result = () => ({ baselineRef: receipt.baselineRef, pendingApproval: receipt.pendingApproval === true });
      if (operation === 'finalize') {
        if (receipt.phase === 'finalized') return result();
        if (receipt.phase === 'prepared' && winnerRef === null) {
          await advancePagePromotion(tenantId, orgId, pageId, guard('finalized', false));
        } else if (receipt.phase === 'prepared') {
          const content = await checkArmPromotable(tenantId, orgId, pageId, winnerRef, 'winner');
          if (!content.ok) throw new OpenwopError('conflict', 'The winner cannot be published now.', 409, { reason: 'gate_failed', gates: ['G8'] });
          const gated = await isApprovalGateOn(tenantId);
          await restoreVersion(tenantId, orgId, pageId, winnerRef!, actor,
            `Closed automatically — superseded by the promotion of "${title}".`,
            { republishing: !gated, promotion: guard('restored') });
        } else if (receipt.phase === 'restored') {
          const gated = await isApprovalGateOn(tenantId);
          await transitionPage(tenantId, orgId, pageId, gated ? 'submit' : 'publish', actor,
            { promotion: guard(gated ? 'submitted' : 'finalized', gated) });
        } else if (receipt.phase === 'submitted') {
          if (page.status === 'in_review') {
            await queueContentApproval(tenantId, orgId, page, `Publish the promoted winner of "${title}" (page "${page.title}")`, { submittedBy: actor, notify: true });
          } else if (page.status !== 'published') {
            throw new OpenwopError('conflict', 'The promotion review was closed or the page changed.', 409, { reason: 'promotion_changed' });
          }
          await advancePagePromotion(tenantId, orgId, pageId, guard('finalized', page.status === 'in_review'));
        } else throw new OpenwopError('conflict', 'The promotion was closed.', 409, { reason: 'promotion_rolled_back' });
      } else {
        if (receipt.phase === 'rolled_back') return result();
        if (receipt.phase === 'superseded') throw new OpenwopError('conflict', 'A later promotion owns this page.', 409, { reason: 'promotion_changed' });
        if (receipt.phase === 'prepared' || (receipt.phase === 'finalized' && winnerRef === null)) {
          // No content write happened: close only, preserving the original posture.
          await advancePagePromotion(tenantId, orgId, pageId, guard('rolled_back', false));
        } else if (!['rolling_back', 'rollback_restored', 'rollback_submitted'].includes(receipt.phase)) {
          // This CAS closes admission before any restoration; a paused finalizer
          // cannot commit its stale prepared/restored/submitted phase afterwards.
          await advancePagePromotion(tenantId, orgId, pageId, guard('rolling_back'));
        } else if (receipt.phase === 'rolling_back') {
          const gated = receipt.baselinePublished && await isApprovalGateOn(tenantId);
          await restoreVersion(tenantId, orgId, pageId, receipt.restoreRef, actor,
            `Closed automatically — the promotion of "${title}" was rolled back.`,
            { republishing: receipt.baselinePublished && !gated, promotion: guard(receipt.baselinePublished ? 'rollback_restored' : 'rolled_back', false) });
        } else if (receipt.phase === 'rollback_restored') {
          const gated = await isApprovalGateOn(tenantId);
          await transitionPage(tenantId, orgId, pageId, gated ? 'submit' : 'publish', actor,
            { promotion: guard(gated ? 'rollback_submitted' : 'rolled_back', gated) });
        } else if (receipt.phase === 'rollback_submitted') {
          if (page.status === 'in_review') {
            await queueContentApproval(tenantId, orgId, page, `Restore the page after rolling back "${title}" (page "${page.title}")`, { submittedBy: actor, notify: true });
          } else if (page.status !== 'published') throw new OpenwopError('conflict', 'The baseline review was closed or the page changed.', 409, { reason: 'promotion_changed' });
          await advancePagePromotion(tenantId, orgId, pageId, guard('rolled_back', page.status === 'in_review'));
        }
      }
    } catch (err) {
      // A competing receipt write is re-read; an acknowledgement failure and
      // content/approval refusal propagate without guessing that no write landed.
      if (err instanceof OpenwopError && err.httpStatus === 409
        && (err.details?.reason === undefined || err.details.reason === 'promotion_changed')) continue;
      throw err;
    }
  }
  throw new OpenwopError('conflict', 'The page keeps changing. Retry the promotion.', 409, { reason: 'promotion_changed' });
}

export async function finalizePagePromotion(tenantId: string, orgId: string, pageId: string, versionId: string | null, actor: string, title: string, experimentId: string): Promise<{ baselineRef: string | null; pendingApproval: boolean }> {
  return reconcilePagePromotion(tenantId, orgId, pageId, experimentId, versionId, actor, title, 'finalize');
}

export async function restorePageBaseline(tenantId: string, orgId: string, pageId: string, _baselineVersionId: string | null, actor: string, title: string, experimentId: string, winnerRef: string | null): Promise<void> {
  await reconcilePagePromotion(tenantId, orgId, pageId, experimentId, winnerRef, actor, title, 'rollback');
}

/** ADR 0950 G8 — may this arm's content go live now? The live page (a null
 *  version) always may; a version must still exist, carry the review stamp
 *  where the gate requires one, and pass the publish blockers. Read-only. */
export async function checkArmPromotable(tenantId: string, orgId: string, pageId: string, versionId: string | null, armKey: string): Promise<{ ok: boolean; reason?: string }> {
  if (versionId === null) return { ok: true };
  const version = await getVersion(tenantId, orgId, pageId, versionId);
  if (!version) return { ok: false, reason: 'version_missing' };
  try {
    await assertVariantSnapshotReviewed(tenantId, orgId, armKey, version);
    assertNoPublishBlockers({ pageId, sections: version.snapshot.sections });
    return { ok: true };
  } catch (err) {
    const details = (err as { details?: { reason?: string } }).details;
    return { ok: false, reason: details?.reason ?? (err instanceof Error ? err.message : 'content_blocked') };
  }
}

/** ADR 0949 P4 — the visitor's variant, honouring Optimize stickiness: an
 *  Optimize experiment's weights move between epochs, so a returning visitor
 *  keeps their recorded first exposure. Decide experiments take the pure sync
 *  path above. `readOnly` is for the stamp resolver (no write on ingest). */
export async function assignVisitorArm(experiment: PageExperiment, visitorKey: string, opts: { readOnly?: boolean } = {}): Promise<ExperimentVariant | null> {
  // Decide (the common case) never touches a store on the public read.
  if (!experiment.engineMode) return assignVariantForVisitor(experiment, visitorKey);
  const row = await getExperimentRow(experiment.tenantId, experiment.orgId, experiment.experimentId);
  // ADR 0950 — a promotion ramp assigns by its epoch's band layout.
  if (row && experiment.engineMode === 'ramp') {
    const a = assignAt(row, visitorKey, nowIso());
    return a ? experiment.variants.find((v) => v.key === a.arm.key) ?? null : null;
  }
  if (row && row.mode === 'optimize') {
    const a = await stickyAssign(row, visitorKey, nowIso(), opts);
    return a ? experiment.variants.find((v) => v.key === a.arm.key) ?? null : null;
  }
  return assignVariantForVisitor(experiment, visitorKey);
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
 * Make a stored version the live page, through the EXISTING verbs: the publish
 * blockers on that content first, then `restoreVersion` and either `publish` or,
 * with `cms-approval-gate` ON, `submit` + the shared approvals queue (the inbox
 * is the only publish path for a gated org). Shared by the manual promote and
 * the ADR 0950 finalize/rollback, so the three can never differ. Null when the
 * page is gone.
 */
async function publishVersionAsPage(
  tenantId: string, orgId: string, pageId: string, versionId: string, actor: string, restoreNote: string, approvalTitle: string,
): Promise<{ page: Page | null; pendingApproval: boolean } | null> {
  let page: Page | null = null;
  let pendingApproval = false;
  const winner = await getVersion(tenantId, orgId, pageId, versionId);
  if (winner) assertNoPublishBlockers({ pageId, sections: winner.snapshot.sections });
  // ADR 0593 (CMSA-4 / CMSAWF-2) — ONE gate predicate (`isApprovalGateOn`),
  // and the gated arm queues UNCONDITIONALLY. This was the last caller of
  // `queueContentApprovalIfGated`, and it re-read the toggle four lines after
  // reading it here: a flip in that window left the page `in_review` with NO
  // row on the inbox lane. Post-C1 doctrine is that a submit always queues.
  // (ADR 0836 D8 moved the ONE read above the restore: the ungated arm restores
  // and republishes in one operation, so the restore must not announce an
  // `unpublished` that would race the `published` into the docs KB.)
  const gated = await isApprovalGateOn(tenantId);
  page = await restoreVersion(
    tenantId, orgId, pageId, versionId, actor,
    restoreNote,
    { republishing: !gated },
  );
  if (!page) return null; // page deleted between read and restore
  if (gated) {
    page = await transitionPage(tenantId, orgId, pageId, 'submit', actor);
    if (page) {
      // ADR 0859 D3/D4 — the promoting admin is the submitter: they cannot approve
      // their own promotion while another manager can.
      await queueContentApproval(tenantId, orgId, page, `${approvalTitle} (page "${page.title}")`, { submittedBy: actor, notify: true });
    }
    pendingApproval = true;
  } else {
    try {
      page = await transitionPage(tenantId, orgId, pageId, 'publish', actor);
    } catch (err) {
      // ADR 0836 D8 — the restore above suppressed its `unpublished` because this
      // publish was meant to follow. It did not: the page IS offline now, so say so.
      if (page) recordPageUnpublishedByRestore(page);
      throw err;
    }
  }
  return { page, pendingApproval };
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
  // A Decide experiment is promoted only by ADR 0950, on its verdict.
  await assertNotManaged(tenantId, orgId, experimentId);
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
    // ADR 0836 D9 — the blockers on the WINNER's content, before anything moves.
    // Checked after the restore, a `[TODO …]` in the variant took the live page
    // down to draft and then refused to republish it.
    const shipped = await publishVersionAsPage(tenantId, orgId, pageId, variant.versionId, actor,
      `Closed automatically — superseded by promoting experiment winner "${variant.key}".`,
      `Publish experiment winner "${variant.key}" of "${exp.name}"`);
    if (!shipped) return null; // page deleted between read and restore
    page = shipped.page;
    pendingApproval = shipped.pendingApproval;
  }

  const done: PageExperiment = { ...exp, status: 'promoted', stoppedAt: nowIso(), updatedAt: nowIso() };
  await saveExperiment(done);
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
  /** ADR 0949 P0 — the split check and the fixed-horizon notice (E-1, E-4). */
  health: LegacyResultHealth;
  /** ADR 0949 P0 — set when `significant` is withheld for every variant. */
  significanceWithheld?: 'srm';
}

/** ADR 0820 §7 / G11 — the feature whose data the results read. */
export const EXPERIMENT_RESULTS_SOURCE_FEATURE = 'analytics';

/** Per-variant sessions/conversions/rate + significance vs the first variant —
 *  a READ-TIME projection over the stamped analytics events (never a second
 *  event store; the cross-feature read goes through the analytics service). */
export async function experimentResults(
  tenantId: string,
  orgId: string,
  pageId: string,
  experimentId: string,
  subject: LaunchSubject = {},
): Promise<ExperimentResults | null> {
  const exp = await getExperiment(tenantId, orgId, pageId, experimentId);
  if (!exp) return null;
  // ADR 0820 §7 / G11 — the RESULTS are a projection over the analytics event
  // store (the crm bundle), so reading them needs `analytics` (toggle + plan).
  // Running the experiment (assignment, stamping) stays core CMS; only the
  // paid read refuses, typed, after the experiment's existence is settled.
  const refusal = await featureAccessRefusal(EXPERIMENT_RESULTS_SOURCE_FEATURE, tenantId, subject);
  if (refusal) {
    throw new OpenwopError(
      'forbidden',
      refusal === 'plan'
        ? 'Experiment results come from Analytics, which is not included in this workspace\'s plan.'
        : refusal === 'unresolved'
          ? 'Experiment results come from Analytics, which could not be checked right now. Try again shortly.'
          : 'Experiment results come from Analytics, which is not enabled for this workspace.',
      403,
      { feature: EXPERIMENT_RESULTS_SOURCE_FEATURE, reason: refusal === 'plan' ? 'not_entitled' : refusal === 'unresolved' ? 'feature_unavailable' : 'feature_disabled' },
    );
  }
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
  // ADR 0949 P1b (E-3) — the one shared legacy projection.
  const projection = projectLegacyResults(exp.variants.map((v) => ({
    key: v.key, weight: v.weight,
    sessions: sessionsByVariant.get(v.key)?.size ?? 0,
    conversions: conversionsByVariant.get(v.key)?.size ?? 0,
  })));
  return {
    experimentId: exp.experimentId, status: exp.status, baselineKey: exp.variants[0]!.key, minSessionsPerVariant: MIN_SESSIONS_PER_VARIANT,
    variants: projection.arms.map((a, i) => ({ ...a, versionId: exp.variants[i]!.versionId })),
    unattributed: { legacy, dropped },
    health: projection.health,
    ...(projection.significanceWithheld === 'srm' ? { significanceWithheld: 'srm' as const } : {}),
  };
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
  // ADR 0949 P1a — the engine store is the record (every surface's experiments,
  // not only CMS pages); the rollback mirror is erased too, so a rollback cannot
  // resurrect the subject.
  for (const e of await listTenantExperimentRows(tenantId)) {
    if (typeof e.createdBy === 'string' && subjectForms.has(e.createdBy)) {
      await putExperimentRow({ ...e, createdBy: sentinel });
      touched += 1;
    }
  }
  for (const e of await legacyMirror.list()) {
    if (e.tenantId === tenantId && typeof e.createdBy === 'string' && subjectForms.has(e.createdBy)) {
      await legacyMirror.put({ ...e, createdBy: sentinel });
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
    const exp = await readExperiment(tenantId, orgId, experimentId);
    if (!exp) return { ok: false, reason: 'unknown' };
    if (exp.status !== 'running' && exp.status !== 'stopped') return { ok: false, reason: 'not_running', id: exp.experimentId };
    const v = await assignVisitorArm(exp, sessionKey, { readOnly: true });
    return v ? { ok: true, id: exp.experimentId, variant: v.key } : { ok: false, reason: 'not_running', id: exp.experimentId };
  });
}
