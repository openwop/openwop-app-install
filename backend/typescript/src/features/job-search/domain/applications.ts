/**
 * ADR 0540 D1/P2 — an application IS a CRM deal.
 *
 * Every write here goes through `crmEntitiesService`, never a direct collection
 * write. That is the Forms→`crmService` precedent and it is not a style
 * preference: CRM owns the deal's authz, validation, stage history and events,
 * and a direct write would produce an application that CRM's own surfaces
 * (timeline, reports, merge) cannot see or explain.
 *
 * The scalar job fields ride CRM's typed custom fields; the structured digest
 * does not (D2 — `customFields` is scalars-only).
 */
import { createDeal, updateDeal, listDeals, listFieldDefs, createFieldDef, listPipelines, createPipeline, deletePipeline } from '../../crm/crmEntitiesService.js';
import type { Deal } from '../../crm/entities/deals.js';
import { jobDigests, type JobDigest } from './digest.js';
import { checkEligibility, type ApplicantConstraints, type EligibilityVerdict } from './eligibility.js';
import { projectFitScores, JOB_FIT_CRITERIA, type FitProfile } from './fitScoring.js';
import { computePriority } from '../../../host/weightedScoring.js';
import { listBoardAdapters } from '../boards/adapters.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';

/** The pipeline every application lands on. `non-revenue` by construction — a
 *  revenue pipeline here would produce the misleading rollup ADR 0540 D3 removes. */
export const APPLICATION_PIPELINE_NAME = 'Job search';

const APPLICATION_STAGES = [
  { name: 'Applied', probability: 10 },
  { name: 'Screening', probability: 30 },
  { name: 'Interviewing', probability: 60 },
  { name: 'Offer', probability: 90 },
];

/**
 * The scalar fields (D1). `matchScore`/`matchReason` are recorded AT DECISION
 * TIME and never recomputed on read (matrix row 9): a re-scored application
 * would silently rewrite the reason a past decision was made for.
 */
export const APPLICATION_FIELD_DEFS: ReadonlyArray<{ key: string; label: string; type: 'string' | 'number' | 'date' }> = [
  { key: 'jobUrl', label: 'Job URL', type: 'string' },
  { key: 'board', label: 'Source board', type: 'string' },
  { key: 'matchScore', label: 'Match score', type: 'number' },
  { key: 'matchReason', label: 'Match reason', type: 'string' },
  { key: 'appliedAt', label: 'Applied at', type: 'date' },
  { key: 'resumeVariantId', label: 'Résumé variant', type: 'string' },
];

/**
 * The stored form of a field key.
 *
 * `buildFieldSpec` normalises on the way in (`host/customFields/index.ts`:
 * lowercase, non-`[a-z0-9_]` → `_`), so `jobUrl` is STORED as `joburl`. Applying
 * the same transform here is what makes the comparison below meaningful.
 */
const storedKeyForm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9_]/g, '_');

/**
 * Infer the board from a posting URL, or `''` when it is not one we know.
 *
 * Matches on the adapter registry rather than a private list, so a newly
 * registered board attributes without a second edit here. Deliberately returns
 * empty rather than guessing: a wrong source attribution would send someone to
 * abandon a board that is actually working for them.
 */
function boardFromUrl(sourceUrl: string | null): string {
  if (!sourceUrl) return '';
  let host: string;
  try { host = new URL(sourceUrl).hostname.toLowerCase(); } catch { return ''; }
  for (const a of listBoardAdapters()) {
    const origin = a.origin.toLowerCase();
    if (host === origin || host.endsWith(`.${origin}`)) return a.id;
    // `boards-api.greenhouse.io` (the API origin) vs `boards.greenhouse.io`
    // (where a human-facing posting lives) share a registrable domain; matching
    // the last two labels covers both without a per-board special case.
    const tail = origin.split('.').slice(-2).join('.');
    if (tail && (host === tail || host.endsWith(`.${tail}`))) return a.id;
  }
  return '';
}

/**
 * Idempotent: seeds any missing definition, leaves existing ones untouched.
 *
 * The comparison MUST normalise. This function claimed idempotency while
 * comparing the camelCase literal `jobUrl` against the stored `joburl`, so the
 * guard never matched and the second call threw `A field \`joburl\` already
 * exists`. Nothing caught it because every existing test creates ONE application
 * per tenant; ADR 0545's campaign loop is the first caller to create a second,
 * and it failed on listing #2 — i.e. every user would have hit this on their
 * second job application.
 */
export async function ensureApplicationFieldDefs(tenantId: string, orgId: string): Promise<number> {
  const existing = await listFieldDefs(tenantId, orgId, 'deal');
  const have = new Set(existing.map((d) => storedKeyForm(d.key)));
  let created = 0;
  for (const def of APPLICATION_FIELD_DEFS) {
    if (have.has(storedKeyForm(def.key))) continue;
    await createFieldDef({ tenantId, orgId, entityType: 'deal', key: def.key, label: def.label, type: def.type });
    created += 1;
  }
  return created;
}

// ── Pipeline binding (grade-trio residual closure) ───────────────────────────
// The vertical used to find its pipeline BY NAME on every read — renaming
// "Job search" in CRM silently unbound the whole feature (surfaced honestly
// as pipelineFound:false, but still unbound). The binding row pins the
// pipeline BY ID per (tenant, org); reads resolve the id first and fall back
// to the name exactly once for legacy tenants, WRITING the binding on the way
// out (self-healing). Binding writes are STRICT CAS — insert-if-absent for a
// first bind, swap-from-a-known-row for a dangling rebind — never a blind
// overwrite (the re-grade caught the first version silently degrading to
// last-writer-wins, which reopened the duplicate-pipeline TOCTOU it claimed
// to close).
interface PipelineBinding {
  key: string; // `${tenantId}:${orgId}`
  tenantId: string;
  // Deliberately NO `orgId` field (the org is recoverable from the key):
  // `countOrgHostExtRows` blocks org deletion while ANY row whose JSON carries
  // a matching `orgId` survives, and nothing tears bindings down on org
  // deletion — a stored `orgId` would 409-block `DELETE /orgs/:id` forever.
  pipelineId: string;
}
const pipelineBindings = new DurableCollection<PipelineBinding>(
  'job-search:pipeline-binding',
  (b) => b.key,
  undefined,
  (b) => b.tenantId,
);

/** The bound application pipeline, or null. Resolves the ID binding first;
 *  falls back to the name for legacy tenants and self-heals the binding. */
export async function resolveApplicationPipeline(tenantId: string, orgId: string) {
  const key = `${tenantId}:${orgId}`;
  const bound = await pipelineBindings.get(key);
  const all = await listPipelines(tenantId, orgId); // one fetch serves both lookups
  if (bound) {
    const byId = all.find((p) => p.pipelineId === bound.pipelineId);
    if (byId) return byId; // renames are harmless — the id survives them
    // The bound pipeline was DELETED: fall through to the name path (which
    // may re-provision) rather than serving a dangling binding.
  }
  const byName = all.find((p) => p.name === APPLICATION_PIPELINE_NAME);
  if (byName) {
    const row: PipelineBinding = { key, tenantId, pipelineId: byName.pipelineId };
    // CAS from exactly the state we observed: `null` (first bind) or the
    // verified-dangling row (rebind). A lost race means a concurrent writer
    // bound first — leave THEIR binding alone; serving byName is still right
    // for this request, and the next resolve reads the settled binding.
    await pipelineBindings.compareAndSwap(bound ?? null, row);
    return byName;
  }
  return null;
}

export async function ensureApplicationPipeline(tenantId: string, orgId: string) {
  const resolved = await resolveApplicationPipeline(tenantId, orgId);
  if (resolved) return resolved;
  const created = await createPipeline(tenantId, orgId, APPLICATION_PIPELINE_NAME, APPLICATION_STAGES, 'non-revenue');
  const key = `${tenantId}:${orgId}`;
  // Insert-if-absent, STRICTLY: if a concurrent first-run bound its pipeline
  // while ours was being created, the CAS loses, we DELETE our just-created
  // duplicate (it has no deals yet, so `deletePipeline` accepts) and serve
  // the winner's — one pipeline per tenant:org, the TOCTOU closure.
  const inserted = await pipelineBindings.compareAndSwap(null, { key, tenantId, pipelineId: created.pipelineId });
  if (!inserted) {
    const winner = await pipelineBindings.get(key);
    if (winner && winner.pipelineId !== created.pipelineId) {
      const winnerPipeline = (await listPipelines(tenantId, orgId)).find((p) => p.pipelineId === winner.pipelineId);
      if (winnerPipeline) {
        try {
          await deletePipeline(tenantId, orgId, created.pipelineId);
        } catch {
          // Best-effort: an undeleted loser is INERT (unbound, no deals) — a
          // failed cleanup must not fail the request that can serve the winner.
        }
        return winnerPipeline;
      }
    }
  }
  return created;
}

export interface CreateApplicationInput {
  tenantId: string;
  orgId: string;
  actor: string;
  digest: Omit<JobDigest, 'dealId' | 'tenantId' | 'version'>;
  profile: FitProfile;
  applicant: ApplicantConstraints;
  /** Deterministic id, so a retry of the same posting cannot mint a second
   *  application (ADR 0162). Callers derive it from the listing's stable id. */
  dealId: string;
  /**
   * Which board this came from, e.g. `greenhouse`.
   *
   * `APPLICATION_FIELD_DEFS` has declared a `board` field since ADR 0540 and
   * NOTHING EVER WROTE IT — dead schema, and the reason ADR 0546 D4's "response
   * rate by source" could not be computed: the column existed and was always
   * empty. Optional because a hand-entered application genuinely has no board.
   */
  board?: string;
}

export interface CreateApplicationResult {
  deal: Deal | null;
  digest: JobDigest | null;
  eligibility: EligibilityVerdict;
  matchScore: number;
  /** True when the application already existed — a retry, not a new apply. */
  existed: boolean;
}

/**
 * Create an application, unless a stated bar disqualifies it.
 *
 * Ineligible ⇒ NO deal is created and the verdict is returned. The alternative
 * (create it, mark it skipped) would put a row in the user's pipeline for a job
 * the product decided not to apply to, and CRM's counts would then describe
 * applications that were never sent.
 */
export async function createApplication(input: CreateApplicationInput): Promise<CreateApplicationResult> {
  const { tenantId, orgId, actor, profile, applicant, dealId } = input;

  const provisional: JobDigest = { ...input.digest, dealId, tenantId, version: 1 };
  const eligibility = checkEligibility(provisional, applicant);
  const matchScore = computePriority(JOB_FIT_CRITERIA, projectFitScores(provisional, profile));
  if (!eligibility.eligible) {
    return { deal: null, digest: null, eligibility, matchScore, existed: false };
  }

  const existing = (await listDeals(tenantId, orgId, {})).find((d) => d.dealId === dealId);
  if (existing) return { deal: existing, digest: provisional, eligibility, matchScore, existed: true };

  const pipeline = await ensureApplicationPipeline(tenantId, orgId);
  await ensureApplicationFieldDefs(tenantId, orgId);
  const stageId = pipeline.stages[0]?.stageId;

  const deal = await createDeal({
    tenantId,
    orgId,
    dealId,
    title: `${provisional.title} — ${provisional.companyName}`,
    pipelineId: pipeline.pipelineId,
    ...(stageId ? { stageId } : {}),
    ...(provisional.salaryMax !== null ? { amount: provisional.salaryMax } : {}),
    ...(provisional.currency !== null ? { currency: provisional.currency } : {}),
    owner: actor,
    createdBy: actor,
    customFields: {
      ...(provisional.sourceUrl !== null ? { jobUrl: provisional.sourceUrl } : {}),
      // Prefer what the caller knows; fall back to inferring from the posting
      // URL, so applications created before this argument existed still
      // attribute rather than piling into `unknown`.
      ...(input.board ?? boardFromUrl(provisional.sourceUrl) ? { board: input.board ?? boardFromUrl(provisional.sourceUrl) } : {}),
      // Recorded at decision time — never recomputed on read (matrix row 9).
      matchScore,
      matchReason: `skills ${provisional.skills.slice(0, 3).join(', ') || 'unstated'}`,
    },
    validateCompany: async () => true,
    validateContact: async () => true,
  });

  await jobDigests.put(provisional);
  return { deal, digest: provisional, eligibility, matchScore, existed: false };
}

/** Advance an application to a named stage, through CRM so stage history records it. */
export async function advanceApplication(
  tenantId: string,
  orgId: string,
  dealId: string,
  stageName: string,
  actor: string,
): Promise<Deal | null> {
  const pipeline = await ensureApplicationPipeline(tenantId, orgId);
  const stage = pipeline.stages.find((s) => s.name.toLowerCase() === stageName.trim().toLowerCase());
  if (!stage) return null;
  return updateDeal(
    tenantId, orgId, dealId,
    { stageId: stage.stageId },
    { validateCompany: async () => true, validateContact: async () => true },
    actor,
  );
}

/** Applications for this org — deals on the application pipeline, with digests. */
export async function listApplications(tenantId: string, orgId: string): Promise<Array<{ deal: Deal; digest: JobDigest | null }>> {
  const pipeline = await ensureApplicationPipeline(tenantId, orgId);
  const deals = await listDeals(tenantId, orgId, { pipelineId: pipeline.pipelineId });
  const out: Array<{ deal: Deal; digest: JobDigest | null }> = [];
  for (const deal of deals) {
    // Point lookup by the deal's own key — never a collection scan per row.
    const digest = (await jobDigests.get(`${tenantId}:${deal.dealId}:1`)) ?? null;
    out.push({ deal, digest });
  }
  return out;
}
