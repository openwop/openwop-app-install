/**
 * ADR 0458 Phase 2 — the per-lesson assembly seams the Challenge Factory needs
 * between the outline gate and publication:
 *
 *  - `computeCheckpointBatches` — the DETERMINISTIC batching that turns a
 *    validated plan's days into ≤4 contiguous checkpoint batches (host policy,
 *    never model judgment). The executor is acyclic with no node re-entry and a
 *    chat gate is a re-invoke-style node with one seeded resolution per resume,
 *    so a per-DAY cadence (thirty sequential gates) is not expressible as a
 *    node graph; per-day cadence is APPROXIMATED by ≤4 fixed batch checkpoints.
 *    A `checkpointEvery` of 'outline-only' produces zero batches (the outline
 *    gate was the only human checkpoint).
 *  - Lesson MEDIA pointers — an APP-OWNED pointer from `(candidate, day)` to the
 *    Media-library asset the factory generated for that lesson. The media
 *    feature's `createAssetFromServeUrl` has no caller-supplied key, so the
 *    deterministic `<candidateId>:day-<n>` pointer lives here: replace-on-retry
 *    (a re-generated day overwrites its one pointer, never orphans a second),
 *    keyed per `(tenant, candidate, day)` so the parallel per-batch builds never
 *    contend on a shared row.
 *  - `normalizeSimulationVerdicts` — the CLOSED-WORLD validator for the three
 *    sim personas' structured verdicts. Model output (the sim agents' returns)
 *    reaches the candidate's durable state only through this — an off-shape
 *    verdict is dropped, never trusted, and an unknown `verdict` degrades to the
 *    conservative `block` (a sim that can't be read cannot silently pass a
 *    challenge).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
// ADR 0458 grade-pass I2/I4 — the DELIBERATE feature-layer coupling to the
// (always-on) Media service for asset cleanup. The factory CREATES lesson assets
// through the run-time `ctx.features.media.createAssetFromServeUrl` surface, but a
// candidate-death purge / retry-supersede runs OUTSIDE a run (no surface), so it
// calls the sanctioned service-side delete directly. `deleteAsset` needs the org;
// `getAssetByIdForTenant` resolves it from the tenant-scoped record (the pointer
// carries no org). Media is always-on substrate, so this edge adds no dependency
// lock (feature-dependency-parity ratchet is exempt for always-on targets).
import { createLogger } from '../../observability/logger.js';
import { getAssetByIdForTenant, deleteAsset } from '../media/mediaService.js';

const log = createLogger('features.kicktodo-creator.lessonAssembly');

/** The maximum number of parent-run checkpoint gates the factory wires (the
 *  executor constraint — see `builtinWorkflows.ts`). */
export const MAX_CHECKPOINT_SLOTS = 4;

/**
 * ADR 0458 §2.2 (correction, 2026-09-15) — the lesson-shape SSoT the
 * `lesson-batch-build` node fetches at call time (surface `lessonSchema`) and
 * hands the model as `responseSchema` + prompt grounding, replacing the
 * placeholder `{type:'object'}` it shipped with. A lesson is gate-reviewed node
 * output (never durable domain state), so the node keeps its own closed-world
 * validator — but that validator and this schema now describe ONE shape, and
 * `claimRefs` is how a lesson's factual content stays traceable to the dossier:
 * the node refuses an id the evidence does not list.
 */
export const LESSON_JSON_SCHEMA = {
  type: 'object',
  description: 'A participant-facing lesson for ONE challenge day, expanded from the plan day and grounded ONLY in the supplied evidence. The node validates authoritatively after generation.',
  additionalProperties: false,
  required: ['day', 'title', 'body', 'steps', 'claimRefs'],
  properties: {
    day: { type: 'integer', minimum: 1, description: 'Echo the day number exactly.' },
    title: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 40, description: 'The teaching content. Every factual statement must be backed by a claim in the EVIDENCE and cited in claimRefs; without evidence, keep to the day\'s own instruction and rationale.' },
    steps: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Concrete steps the participant does today.' },
    claimRefs: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'The claimIds from the EVIDENCE this lesson relies on. Only ids the evidence lists are accepted; an empty array means the lesson makes no factual claim beyond the day\'s instruction.' },
  },
} as const;

export type CheckpointCadence = 'outline-only' | 'batched';

export interface CheckpointBatch {
  /** 1-based checkpoint index (0..MAX_CHECKPOINT_SLOTS-1). */
  slot: number;
  /** Contiguous, ascending day numbers this batch builds. */
  days: number[];
  /** Inclusive human-facing range for the gate title (`Days 1–8`). */
  fromDay: number;
  toDay: number;
}

export interface CheckpointPlan {
  cadence: CheckpointCadence;
  batches: CheckpointBatch[];
  /** Fixed-length (MAX_CHECKPOINT_SLOTS) liveness flags — `slotLive[i]` is true
   *  iff batch `i` exists. The factory conditions each slot's build edge on this
   *  so an absent slot is skipped (never a gate over an empty batch). */
  slotLive: boolean[];
  /** True when NO slot is live (outline-only, or a zero-day plan) — the factory's
   *  bypass edge to the post-checkpoint stage. */
  noLiveSlots: boolean;
}

/**
 * Partition a validated plan's day numbers into ≤MAX_CHECKPOINT_SLOTS contiguous
 * batches. Deterministic and total: any day list + cadence yields the same plan,
 * so it is replay/fork-safe from a node. Contiguous & balanced (earlier batches
 * absorb the remainder) so a gate title names a clean ascending range.
 *
 * 'outline-only' ⇒ zero batches. 'batched' ⇒ `min(MAX_SLOTS, N)` batches, so a
 * 1-day plan is one checkpoint and any plan ≥4 days is four. Batch size is
 * `ceil(remaining/remaining-slots)`, which stays ≤10 for plans up to 40 days
 * (the common case) and grows to at most 15 for the 60-day validator ceiling —
 * the per-batch build iterates a small bounded array either way.
 */
export function computeCheckpointBatches(dayNumbers: number[], cadence: CheckpointCadence): CheckpointPlan {
  const days = [...new Set(dayNumbers.filter((d) => Number.isInteger(d) && d >= 1))].sort((a, b) => a - b);
  const slotLive = new Array<boolean>(MAX_CHECKPOINT_SLOTS).fill(false);
  if (cadence === 'outline-only' || days.length === 0) {
    return { cadence, batches: [], slotLive, noLiveSlots: true };
  }
  const batchCount = Math.min(MAX_CHECKPOINT_SLOTS, days.length);
  const batches: CheckpointBatch[] = [];
  let cursor = 0;
  for (let slot = 0; slot < batchCount; slot++) {
    const remainingDays = days.length - cursor;
    const remainingSlots = batchCount - slot;
    const take = Math.ceil(remainingDays / remainingSlots);
    const slice = days.slice(cursor, cursor + take);
    cursor += take;
    batches.push({ slot, days: slice, fromDay: slice[0]!, toDay: slice[slice.length - 1]! });
    slotLive[slot] = true;
  }
  return { cadence, batches, slotLive, noLiveSlots: false };
}

/* ─── Lesson media pointers (app-owned, deterministic, replace-on-retry) ───── */

export type LessonMediaKind = 'image' | 'video';

export interface LessonMediaPointer {
  tenantId: string;
  candidateId: string;
  day: number;
  assetId: string;
  kind: LessonMediaKind;
  updatedAt: string;
}

/** Keyed `${tenant}::${candidateId}::day-${day}` — ONE pointer per lesson day, so
 *  a re-generated day (suspend/resume/retry) OVERWRITES rather than duplicating,
 *  and parallel per-batch builds writing different days never contend. */
const lessonMedia = new DurableCollection<LessonMediaPointer>(
  'kicktodo-lesson-media',
  (p) => `${p.tenantId}::${p.candidateId}::day-${p.day}`,
);

const KIND_VALUES: ReadonlySet<string> = new Set<LessonMediaKind>(['image', 'video']);

export interface SetLessonMediaInput {
  tenantId: string;
  candidateId: string;
  day: number;
  assetId: string;
  kind: LessonMediaKind;
}

/** Delete a Media asset the factory generated, best-effort, through the sanctioned
 *  service-side delete (frees the bytes + usage rows + fires media's own lifecycle
 *  seam). The pointer carries no org, so the org is resolved from the tenant-scoped
 *  asset record first. Never throws — a cleanup failure must not block the caller
 *  (retry-supersede / candidate death). Returns whether an asset was deleted. */
async function deleteLessonAssetBestEffort(tenantId: string, assetId: string): Promise<boolean> {
  try {
    const asset = await getAssetByIdForTenant(tenantId, assetId);
    if (!asset) return false; // already gone (idempotent) or foreign tenant
    return await deleteAsset(tenantId, asset.orgId, assetId);
  } catch (err) {
    log.warn('lesson media asset delete failed', { tenantId, assetId, err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Upsert the pointer for one lesson day. Replace-on-retry: `put` is a
 *  deterministic-key overwrite, so re-running a day's build amends its single
 *  pointer instead of orphaning a second Media asset reference.
 *
 *  ADR 0458 grade-pass I4 — when the overwrite SUPERSEDES a pointer whose
 *  `assetId` CHANGED (a re-generated day produced a new asset), the previously
 *  referenced asset is now unreachable, so it is deleted via the sanctioned path.
 *  A same-assetId re-put (identical retry) deletes nothing. */
export async function setLessonMedia(input: SetLessonMediaInput): Promise<LessonMediaPointer> {
  if (!input.tenantId || !input.candidateId) throw new Error('tenantId and candidateId are required.');
  if (!Number.isInteger(input.day) || input.day < 1) throw new Error('day must be a positive integer.');
  if (!input.assetId) throw new Error('assetId is required.');
  if (!KIND_VALUES.has(input.kind)) throw new Error(`kind must be one of ${[...KIND_VALUES].join(', ')}.`);
  const key = `${input.tenantId}::${input.candidateId}::day-${input.day}`;
  const prior = await lessonMedia.get(key);
  const pointer: LessonMediaPointer = {
    tenantId: input.tenantId,
    candidateId: input.candidateId,
    day: input.day,
    assetId: input.assetId,
    kind: input.kind,
    updatedAt: new Date().toISOString(),
  };
  await lessonMedia.put(pointer);
  if (prior && prior.assetId && prior.assetId !== input.assetId) {
    await deleteLessonAssetBestEffort(input.tenantId, prior.assetId);
  }
  return pointer;
}

/** ADR 0458 grade-pass I2 — purge every lesson-media pointer for a candidate AND
 *  delete each referenced Media asset (sanctioned path, best-effort). Called from
 *  the candidate-death subscriber. Returns how many pointer rows were removed. */
export async function purgeLessonMediaForCandidate(tenantId: string, candidateId: string): Promise<number> {
  const pointers = await listLessonMedia(tenantId, candidateId);
  let removed = 0;
  for (const p of pointers) {
    // Delete the asset FIRST (best-effort); the pointer is the only handle to it,
    // so purging the pointer before the asset would strand the bytes.
    await deleteLessonAssetBestEffort(tenantId, p.assetId);
    try {
      if (await lessonMedia.delete(`${tenantId}::${candidateId}::day-${p.day}`)) removed += 1;
    } catch (err) {
      log.warn('lesson media pointer delete failed', { tenantId, candidateId, day: p.day, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return removed;
}

/** Every lesson-media pointer for a candidate, ascending by day. Tenant-scoped. */
export async function listLessonMedia(tenantId: string, candidateId: string): Promise<LessonMediaPointer[]> {
  const rows = await lessonMedia.listByPrefix(`${tenantId}::${candidateId}::`);
  return rows.filter((r) => r.tenantId === tenantId).sort((a, b) => a.day - b.day);
}

/* ─── Simulation verdicts (closed-world validation of the sim personas) ─────── */

export type SimPersona = 'newcomer' | 'time-poor' | 'skeptic';
export type SimVerdict = 'pass' | 'flag' | 'block';
export type SimFindingSeverity = 'note' | 'flag' | 'block';

/** One structured finding — matches `feature.kicktodo.agents/schemas/sim-verdict`
 *  `findings[]` (the sim personas' model-facing SSoT). */
export interface SimFinding {
  severity: SimFindingSeverity;
  text: string;
  day?: number;
}

/**
 * A recorded persona verdict. `verdict`/`findings`/`personaSummary` are the
 * `sim-verdict` schema the personas return against, kept VERBATIM; `sim` is the
 * persona identity derived from the dispatch PORT the verdict arrived on — the
 * schema deliberately does NOT carry it (the agent knows who it is; the return
 * does not), so attribution rides the context, never a self-declared field.
 */
export interface SimulationVerdict {
  sim: SimPersona;
  verdict: SimVerdict;
  personaSummary: string;
  findings: SimFinding[];
}

const SIM_VERDICTS: ReadonlySet<string> = new Set<SimVerdict>(['pass', 'flag', 'block']);
const SIM_SEVERITIES: ReadonlySet<string> = new Set<SimFindingSeverity>(['note', 'flag', 'block']);

/** The three personas the factory convenes — the gate's required coverage set AND
 *  the keys `sim-collect` forwards verbatim sim-verdict bodies under (persona
 *  kebab: `newcomer`/`time-poor`/`skeptic`). Persona attribution is this KEY, from
 *  the agent-runner edge the verdict arrived on — never a `sim` field in the body. */
export const REQUIRED_SIM_PERSONAS: readonly SimPersona[] = ['newcomer', 'skeptic', 'time-poor'];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function normalizeFindings(input: unknown): SimFinding[] {
  if (!Array.isArray(input)) return [];
  const out: SimFinding[] = [];
  for (const f of input) {
    if (!isRecord(f)) continue;
    const severity = typeof f.severity === 'string' && SIM_SEVERITIES.has(f.severity) ? (f.severity as SimFindingSeverity) : 'note';
    const text = typeof f.text === 'string' ? f.text.slice(0, 2000) : '';
    if (!text) continue; // the schema requires a non-empty finding text
    out.push({ severity, text, ...(typeof f.day === 'number' && Number.isInteger(f.day) ? { day: f.day } : {}) });
  }
  return out.slice(0, 50);
}

/**
 * Normalize the sim stage's raw output into typed verdicts (the closed-world
 * gate; the `sim-verdict` schema is the SSoT). Accepts EITHER shape the sim
 * stage can hand us — the `sim-collect` node's persona-TAGGED ARRAY
 * (`[{sim, verdict, findings, personaSummary}, …]`, the production producer) OR a
 * persona-KEYED map (`{ newcomer: body, … }`) — because in BOTH the persona is
 * attached by the trusted node from the dispatch PORT it read, never a model
 * self-declaration (the schema body carries no `sim`). A persona with no readable
 * body is absent (the publication `simulation` gate then fails coverage — a
 * missing persona can never silently pass). Fail-closed on the verdict TWO ways:
 * an unreadable `verdict` value degrades to `block`, AND — defense in depth — a
 * `pass`/`flag` is FORCED to `block` when ANY finding carries `severity:'block'`
 * (a persona that logged a stopper can't be overridden by a lenient headline
 * verdict). Deterministic (last body per persona wins).
 */
export function normalizeSimulationVerdicts(input: unknown): SimulationVerdict[] {
  const bodyByPersona = new Map<SimPersona, Record<string, unknown>>();
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!isRecord(item)) continue;
      const sim = item.sim; // node-attached routing tag (from the port), not model-declared
      if (typeof sim === 'string' && REQUIRED_SIM_PERSONAS.includes(sim as SimPersona)) {
        bodyByPersona.set(sim as SimPersona, item);
      }
    }
  } else if (isRecord(input)) {
    for (const persona of REQUIRED_SIM_PERSONAS) {
      const body = input[persona];
      if (isRecord(body)) bodyByPersona.set(persona, body);
    }
  }
  const out: SimulationVerdict[] = [];
  for (const [persona, body] of bodyByPersona) {
    const findings = normalizeFindings(body.findings);
    let verdict: SimVerdict = typeof body.verdict === 'string' && SIM_VERDICTS.has(body.verdict)
      ? (body.verdict as SimVerdict)
      : 'block'; // unreadable ⇒ block
    if (findings.some((f) => f.severity === 'block')) verdict = 'block'; // defense in depth
    const personaSummary = typeof body.personaSummary === 'string' ? body.personaSummary.slice(0, 4000) : '';
    out.push({ sim: persona, verdict, personaSummary, findings });
  }
  return out.sort((a, b) => a.sim.localeCompare(b.sim));
}

/** Test-only: the module-private collection, for idempotency assertions. */
export const __test = { lessonMedia };
