/**
 * Challenge Factory candidates (ADR 0415 P1; PRD §7.1–§7.3).
 *
 * A FactoryCandidate is the durable record of ONE challenge being produced:
 * intake brief → deterministic risk classification → research dossier →
 * (D2) plan → (D3) gates + publish. `kicktodo-creator` owns candidate
 * artifacts/gates/state; research corpus bodies live with their owners
 * (Notebooks/KB/Documents) — the dossier stores REFS + hashes only.
 *
 * HONESTY FAIL-CLOSED (PRD §7.4): a dossier recorded for a publication-bound
 * candidate REFUSES stub/demo search sources (`core.web.search` returns
 * `stub: true` or `engine: 'demo'` when no real adapter is configured) —
 * placeholder retrieval can exercise a workflow but can never enter a
 * release-bound evidence record.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { engineIsDurable } from '../../host/webSearchCapability.js';
import { createLogger } from '../../observability/logger.js';
import type { SimulationVerdict } from './lessonAssembly.js';
import { fireCandidateDeath } from './candidateLifecycle.js';
import { draftFromPlan, isChallengePlan, type ChallengePlan } from './planService.js';
import type { ChallengeDefinition } from '../kicktodo-core/types.js';

const log = createLogger('kicktodo.creator');

export type RiskTier = 'general' | 'sensitive' | 'regulated-adjacent' | 'prohibited';
export type CandidateState = 'intake' | 'researched' | 'planned' | 'published' | 'withdrawn';

export interface ResearchSource {
  url: string;
  domain: string;
  title: string;
  /** sha256 over url|title — the dedup/citation key (bodies live with their owners). */
  hash: string;
  engine: string;
  rank?: number;
  /** ADR 0494 P2c — was this source's CONTENT actually retrieved and readable?
   *
   *  A search result is not evidence until something reads it, and in practice
   *  many authoritative publishers refuse a server-side fetch outright (a probe of
   *  real results returned HTTP 403 from mayoclinic.org). Those sources are already
   *  excluded from what a model may cite, but the dossier still RECORDED them — so
   *  a human approver saw six sources when two backed anything.
   *
   *  Absent ⇒ unknown (dossiers recorded before this existed); `false` ⇒ found but
   *  not read. Never inferred from the presence of a citation. */
  retrieved?: boolean;
}

/** ADR 0494 P2b — whether a CITED source actually SUPPORTS the claim.
 *
 *  The structural check proves a source was recorded; it cannot prove the source
 *  says what the claim says. That distinction is the field's dangerous case:
 *  "real sources applied incorrectly" (Stanford 2026: 17–34% of legal-AI queries
 *  mis-sourced, accuracy under 66% while users trust more and verify less). */
export type ClaimVerdict = 'supports' | 'contradicts' | 'unrelated' | 'unverifiable';

export interface ClaimSupport {
  /** The cited source this verdict is about. */
  sourceHash: string;
  verdict: ClaimVerdict;
  /** The passage the judgement rests on — what makes the verdict auditable. */
  span?: string;
  /** ADR 0494 P2b — the TARGETED second opinion. Requested only where the first
   *  judgement said `supports`, because a false SUPPORTS is the dangerous error;
   *  a false `unrelated` merely loses a claim. Absent ⇒ never sought.
   *  DISAGREEMENT IS RECORDED, NOT RESOLVED: the field's finding is that
   *  disagreement is the signal for human scrutiny, so collapsing it to one
   *  verdict discards the thing worth surfacing. */
  secondOpinion?: ClaimVerdict;
}

export interface ResearchClaim {
  claimId: string;
  text: string;
  /** Source hashes the claim CITES. Structure-checked on record: a hash that
   *  matches no recorded source cannot support anything. */
  sourceHashes: string[];
  /** Per-cited-source entailment verdicts (ADR 0494 P2b). Absent on dossiers
   *  recorded before verification existed — `claimsGate` then falls back to the
   *  structural check, so older candidates keep their prior meaning. */
  support?: ClaimSupport[];
}

/** Do the recorded verdicts show this claim actually SUPPORTED by `hash`?
 *  A disputed pair (second opinion disagrees) is NOT support — it is exactly the
 *  case a human should look at, so it must not silently pass a gate. */
export function claimSupportedBy(claim: ResearchClaim, hash: string): boolean {
  const v = claim.support?.find((sp) => sp.sourceHash === hash);
  if (!v) return false;
  if (v.verdict !== 'supports') return false;
  return v.secondOpinion === undefined || v.secondOpinion === 'supports';
}

/**
 * ADR 0458 §2.2 (correction, 2026-09-15) — the EVIDENCE a text-producing model
 * call receives: every recorded claim with its id, whether the dossier counts it
 * as supported, and the sources that cite it. This is what `plan-generate`,
 * `lesson-batch-build` and the skeptic persona are grounded on, replacing the
 * three-claim prose `evidenceSummary`; the ids are the closed world `claimRefs`
 * must live in. Bounded so a large dossier cannot blow a prompt; `text` is
 * truncated, never dropped silently — the count says how many made it.
 */
export interface EvidenceClaimBrief {
  claimId: string;
  text: string;
  /** Recorded as supported: cited, not in `unsupportedClaimIds`, and (when
   *  entailment verdicts exist) actually SUPPORTED by at least one cited source. */
  supported: boolean;
  sources: Array<{ title: string; url: string; domain: string }>;
}

export const EVIDENCE_BRIEF_LIMITS = { maxClaims: 60, maxTextChars: 400, maxSourcesPerClaim: 3 } as const;

export function evidenceClaimsForPrompt(dossier: ResearchDossier | undefined): EvidenceClaimBrief[] {
  if (!dossier) return [];
  const unsupported = new Set(dossier.unsupportedClaimIds ?? []);
  const byHash = new Map(dossier.sources.map((sc) => [sc.hash, sc] as const));
  return dossier.claims.slice(0, EVIDENCE_BRIEF_LIMITS.maxClaims).map((cl) => {
    const cited = cl.sourceHashes.filter((h) => byHash.has(h));
    const supported = !unsupported.has(cl.claimId) && cited.length > 0
      && (cl.support === undefined || cited.some((h) => claimSupportedBy(cl, h)));
    return {
      claimId: cl.claimId,
      text: cl.text.length > EVIDENCE_BRIEF_LIMITS.maxTextChars ? `${cl.text.slice(0, EVIDENCE_BRIEF_LIMITS.maxTextChars)}…` : cl.text,
      supported,
      sources: cited.slice(0, EVIDENCE_BRIEF_LIMITS.maxSourcesPerClaim).map((h) => {
        const sc = byHash.get(h)!;
        return { title: sc.title, url: sc.url, domain: sc.domain };
      }),
    };
  });
}

/** The closed world a plan's / lesson's `claimRefs` may cite: the dossier's
 *  SUPPORTED claim ids only. A recorded-but-unsupported claim is exactly what a
 *  citation must not lean on (re-grade KTF-EV-1), so it is outside the world by
 *  construction — the validator refuses it, not just the prompt. */
export function supportedClaimIds(dossier: ResearchDossier | undefined): string[] {
  return evidenceClaimsForPrompt(dossier).filter((c) => c.supported).map((c) => c.claimId);
}

/** Pairs where the two judgements disagreed — surfaced to the human approver
 *  rather than auto-failed. */
export function disputedSupport(claim: ResearchClaim): ClaimSupport[] {
  return (claim.support ?? []).filter(
    (sp) => sp.secondOpinion !== undefined && sp.secondOpinion !== sp.verdict,
  );
}

/**
 * The SSoT for the CLAIM-EXTRACTION contract handed to the model (ADR 0494 P2).
 *
 * Shared with `recordResearch`'s validator by construction, exactly as
 * `CHALLENGE_PLAN_JSON_SCHEMA` is shared with `validatePlan` — the model receives
 * this as `responseSchema`, so prompt and validator cannot drift.
 *
 * `sourceHashes` cites the hashes supplied in the prompt. A model that invents or
 * mis-copies one is NOT trusted on that basis: `recordResearch` re-derives every
 * hash from `(url, title)` and re-points citations, so a claim citing a hash that
 * matches no recorded source lands in `unsupportedClaimIds`. The schema asks for
 * good behaviour; the recorder enforces it.
 */
export const CLAIM_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      maxItems: 24,
      description: 'Factual claims supported by the supplied source content. Omit anything the content does not state.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimId', 'text', 'sourceHashes'],
        properties: {
          claimId: { type: 'string', description: 'Stable short id, e.g. c-1.' },
          text: { type: 'string', description: 'ONE self-contained factual statement, in your own words.' },
          sourceHashes: {
            type: 'array',
            minItems: 1,
            description: 'Hashes of the supplied sources that state this claim. Cite ONLY hashes given to you.',
            items: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

/** ADR 0494 P2b — the SSoT for one entailment judgement handed to the model.
 *  Shared with the verify node as `responseSchema` (the `planSchema` pattern), so
 *  prompt and consumer cannot drift. `span` is REQUIRED for `supports`: a
 *  judgement that cannot quote the passage is not auditable, and an unauditable
 *  "supports" is exactly the false-support this phase exists to catch. */
export const CLAIM_VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['supports', 'contradicts', 'unrelated', 'unverifiable'],
      description:
        'supports = the source states or directly entails the claim. contradicts = the source states the opposite. '
        + 'unrelated = the source is about something else. unverifiable = the source is too vague or truncated to tell.',
    },
    span: {
      type: 'string',
      description: 'The exact passage from the SOURCE that decides it. REQUIRED when the verdict is `supports`.',
    },
  },
} as const;

export interface ResearchDossier {
  /** ADR 0494 P2c — hashes of the sources whose content was actually retrieved.
   *  Input-only on record (stamped onto each source as `retrieved`); not part of
   *  the stored dossier shape. */
  readSourceHashes?: string[];
  questions: string[];
  sources: ResearchSource[];
  claims: ResearchClaim[];
  unsupportedClaimIds: string[];
  engines: string[];
  recordedAt: string;
}

/** ADR 0458 §2.3 — the candidate's VALIDATED plan revision: the single source of
 *  truth for `decompose` and the canvas seed. Stamped inside the draftFromPlan
 *  flow on every successful draft derivation (`revision` increments); the
 *  challenge-outline canvas is only ever a working draft over this. */
export interface CandidatePlanRevision {
  plan: ChallengePlan;
  revision: number;
  recordedAt: string;
}

export interface FactoryCandidate {
  id: string;
  tenantId: string;
  topic: string;
  audience: string;
  transformation: string;
  durationDaysTarget: number;
  dailyMinutesTarget: number;
  riskTier: RiskTier;
  /** Why the classifier chose the tier (the matched signals — reviewable). */
  riskSignals: string[];
  state: CandidateState;
  createdBy: string;
  dossier?: ResearchDossier;
  /** ADR 0441 (TD1 binding) — the challenge DRAFT this candidate's plan was
   *  decomposed into. The candidate→challenge binding the publication submit needs;
   *  stamped by `setCandidateDraft` at decompose time, read verbatim (never
   *  re-resolved). Absent until the plan is decomposed. */
  draft?: { challengeId: string; challengeVersion: number };
  /** ADR 0458 §2.3 — the validated plan the current draft was derived from (the
   *  SSoT). Absent until the first successful decompose; `revision` bumps on
   *  every re-derivation. Not a person-link — survives author erasure. */
  plan?: CandidatePlanRevision;
  /** ADR 0458 P2 — the three sim personas' structured verdicts against the
   *  validated plan (closed-world normalized by `lessonAssembly`). The
   *  publication `simulation` gate reads these; absent until the sim stage runs.
   *  Not a person-link — survives author erasure untouched. */
  simulation?: { verdicts: SimulationVerdict[]; recordedAt: string };
  createdAt: string;
  updatedAt?: string;
}

const candidates = new DurableCollection<FactoryCandidate>(
  'kicktodo-candidates',
  (c) => `${c.tenantId}::${c.id}`,
);

const nowIso = (): string => new Date().toISOString();

/**
 * Deterministic risk classification (ADR 0415 P1; PRD §7.3 workflow 1).
 * Keyword-tier matching over the brief — deliberately conservative and
 * REVIEWABLE (the matched signals are stored). Tiers only ever escalate;
 * `prohibited` topics are refused at intake (PRD §7.7 defers them until a
 * qualified review program exists). An LLM never decides the tier.
 */
const PROHIBITED = ['suicide', 'self-harm', 'eating disorder', 'anorexia', 'crash diet', 'day trading', 'crypto invest', 'gambling', 'minor', 'medication', 'prescription'];
const REGULATED = ['medical', 'diagnos', 'therapy', 'mental health', 'depression', 'anxiety treatment', 'invest', 'credit repair', 'tax', 'legal advice', 'lawsuit', 'weight loss'];
const SENSITIVE = ['fitness', 'diet', 'nutrition', 'grief', 'relationship', 'addiction', 'sleep', 'stress', 'fasting'];

export function classifyRisk(text: string): { tier: RiskTier; signals: string[] } {
  const hay = text.toLowerCase();
  const hits = (list: string[]) => list.filter((k) => hay.includes(k));
  const prohibited = hits(PROHIBITED);
  if (prohibited.length) return { tier: 'prohibited', signals: prohibited };
  const regulated = hits(REGULATED);
  if (regulated.length) return { tier: 'regulated-adjacent', signals: regulated };
  const sensitive = hits(SENSITIVE);
  if (sensitive.length) return { tier: 'sensitive', signals: sensitive };
  return { tier: 'general', signals: [] };
}

export class ProhibitedTopicError extends Error {
  constructor(public readonly signals: string[]) {
    super('This topic is prohibited until a qualified review program exists (PRD §7.7).');
  }
}

export class StubSourceError extends Error {
  constructor(public readonly engines: string[]) {
    super('Research contains stub/demo search results — a publication-bound dossier requires a real configured search adapter (fail-closed).');
  }
}

export interface CreateCandidateInput {
  tenantId: string;
  createdBy: string;
  topic: string;
  audience: string;
  transformation: string;
  durationDaysTarget: number;
  dailyMinutesTarget: number;
}

export async function createCandidate(input: CreateCandidateInput): Promise<FactoryCandidate> {
  const { tier, signals } = classifyRisk(`${input.topic} ${input.audience} ${input.transformation}`);
  if (tier === 'prohibited') throw new ProhibitedTopicError(signals);
  const candidate: FactoryCandidate = {
    id: `cand:${randomUUID()}`,
    tenantId: input.tenantId,
    topic: input.topic,
    audience: input.audience,
    transformation: input.transformation,
    durationDaysTarget: input.durationDaysTarget,
    dailyMinutesTarget: input.dailyMinutesTarget,
    riskTier: tier,
    riskSignals: signals,
    state: 'intake',
    createdBy: input.createdBy,
    createdAt: nowIso(),
  };
  await candidates.put(candidate);
  log.info('kicktodo_candidate_created', { candidateId: candidate.id, riskTier: tier });
  return candidate;
}

export async function getCandidate(tenantId: string, id: string): Promise<FactoryCandidate | null> {
  const c = await candidates.get(`${tenantId}::${id}`);
  return c && c.tenantId === tenantId ? c : null;
}

export async function listCandidates(tenantId: string): Promise<FactoryCandidate[]> {
  const rows = await candidates.listByPrefix(`${tenantId}::`);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Kill-switch projection (ADR 0415 P4): withdrawn with the audited reason.
 *  CAS; terminal — a withdrawn candidate never returns to the pipeline. */
export async function __setCandidateWithdrawn(
  tenantId: string,
  candidateId: string,
  reason: string,
  actor: string,
): Promise<FactoryCandidate | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await getCandidate(tenantId, candidateId);
    if (!c) return null;
    if (c.state === 'withdrawn') return c;
    const next: FactoryCandidate = {
      ...c,
      state: 'withdrawn',
      riskSignals: [...c.riskSignals, `withdrawn: ${reason} (by ${actor})`],
      updatedAt: nowIso(),
    };
    if (await candidates.compareAndSwap(c, next)) {
      // ADR 0458 grade-pass I2 — the SINGLE withdraw owner: fire candidate-death
      // AFTER the terminal flip commits (best-effort, never throws), so a killed
      // candidate's sidecar rows (outline canvas + lesson media) are pruned. Only
      // on the real transition — the idempotent "already withdrawn" return above
      // does NOT re-fire.
      await fireCandidateDeath({ tenantId, candidateId });
      return next;
    }
  }
  return await getCandidate(tenantId, candidateId);
}

/**
 * KT-EXP-9 (grade-data) — advance the candidate to `published` once its challenge
 * publishes (called from `completePublication`). Without this the lifecycle never
 * reached `published`: the Provenance Spine's publication/monitor phases and the
 * kill-switch eligibility (published-only) were all keyed off a state the candidate
 * never took. CAS-guarded; only a non-withdrawn candidate advances, idempotent.
 */
export async function setCandidatePublished(
  tenantId: string,
  candidateId: string,
): Promise<FactoryCandidate | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await getCandidate(tenantId, candidateId);
    if (!c) return null;
    if (c.state === 'published' || c.state === 'withdrawn') return c;
    const next: FactoryCandidate = { ...c, state: 'published', updatedAt: nowIso() };
    if (await candidates.compareAndSwap(c, next)) return next;
  }
  return await getCandidate(tenantId, candidateId);
}

/**
 * ADR 0441 (TD1 binding) — stamp the decomposed challenge draft onto the candidate
 * and move it to `planned`. Called from the decompose surface method after
 * `draftFromPlan`, so the publication submit can read `candidate.draft` instead of
 * the FE guessing the challenge id. CAS-guarded, idempotent-latest-wins (a
 * re-decompose repoints to the newest draft); TERMINAL states (`published`,
 * `withdrawn`) refuse a re-bind — the immutable published version and the retired
 * candidate are never re-pointed.
 */
export async function setCandidateDraft(
  tenantId: string,
  candidateId: string,
  challengeId: string,
  challengeVersion: number,
): Promise<FactoryCandidate | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await getCandidate(tenantId, candidateId);
    if (!c) return null;
    if (c.state === 'published' || c.state === 'withdrawn') return c;
    const next: FactoryCandidate = {
      ...c,
      draft: { challengeId, challengeVersion },
      state: 'planned',
      updatedAt: nowIso(),
    };
    if (await candidates.compareAndSwap(c, next)) return next;
  }
  return await getCandidate(tenantId, candidateId);
}

/**
 * ADR 0458 §2.3 — record the VALIDATED plan revision on the candidate (the SSoT).
 * CAS-guarded; `revision` increments monotonically from any prior revision.
 * TERMINAL states (`published`, `withdrawn`) refuse a re-record — a live/retired
 * challenge's plan is frozen. The plan must already be validated (the caller
 * only reaches here after `draftFromPlan` accepted it); this only persists it.
 */
export async function setCandidatePlan(
  tenantId: string,
  candidateId: string,
  plan: ChallengePlan,
): Promise<FactoryCandidate | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await getCandidate(tenantId, candidateId);
    if (!c) return null;
    if (c.state === 'published' || c.state === 'withdrawn') return c;
    const next: FactoryCandidate = {
      ...c,
      plan: { plan, revision: (c.plan?.revision ?? 0) + 1, recordedAt: nowIso() },
      updatedAt: nowIso(),
    };
    if (await candidates.compareAndSwap(c, next)) return next;
  }
  return await getCandidate(tenantId, candidateId);
}

/** ADR 0458 §2.3 — the candidate's current validated plan revision, or null. */
export async function getCandidatePlan(tenantId: string, candidateId: string): Promise<CandidatePlanRevision | null> {
  const c = await getCandidate(tenantId, candidateId);
  return c?.plan ?? null;
}

/** ADR 0458 §2.3 — a re-derivation onto an already-published draft id is refused:
 *  `createDraft` returns the frozen published row UNCHANGED (published-immutability),
 *  so the edit did not apply. The shared derive path raises this typed conflict
 *  rather than silently stamping a new plan revision that the frozen draft ignores. */
export class DraftAlreadyPublishedError extends Error {
  constructor(public readonly challengeId: string, public readonly challengeVersion: number) {
    super('This candidate’s challenge version is already published and immutable — publish a new version instead.');
  }
}

/**
 * ADR 0458 §2.3 — THE draftFromPlan flow (the surface decompose op AND the canvas
 * apply route share it, so "the plan revision is the SSoT" is enforced in one
 * place). `draftFromPlan` validates the plan (throws `PlanInvalidError` on any
 * defect — no revision bump, no draft), CAS-writes the ONE deterministic draft,
 * and returns the frozen row unchanged if that id is already published. On that
 * published case we raise `DraftAlreadyPublishedError` BEFORE stamping, so the
 * SSoT never records a revision the draft can't reflect. On success: stamp the
 * plan revision, then bind the draft (both CAS on the candidate).
 */
export async function deriveAndBindCandidateDraft(
  tenantId: string,
  authorSubject: string,
  candidateId: string,
  planInput: unknown,
): Promise<{ challenge: ChallengeDefinition; candidate: FactoryCandidate | null }> {
  // ADR 0458 §2.2 (correction) — the plan's claimRefs are validated against THIS
  // candidate's dossier (closed-world provenance); no dossier ⇒ refs unchecked.
  const owner = await getCandidate(tenantId, candidateId);
  const challenge = await draftFromPlan(tenantId, authorSubject, planInput, candidateId,
    owner?.dossier ? { knownClaimIds: supportedClaimIds(owner.dossier) } : undefined);
  if (challenge.status !== 'draft') throw new DraftAlreadyPublishedError(challenge.id, challenge.version);
  // `draftFromPlan` accepted `planInput`, so it narrows to `ChallengePlan`; the
  // guard is defensive (unreachable) and keeps the stamp cast-free.
  if (isChallengePlan(planInput)) await setCandidatePlan(tenantId, candidateId, planInput);
  const candidate = await setCandidateDraft(tenantId, candidateId, challenge.id, challenge.version);
  return { challenge, candidate };
}

/**
 * ADR 0458 P2 — record the three sim personas' verdicts on the candidate (the
 * `simulation` publication gate reads them). CAS-guarded, idempotent-latest-wins
 * (a re-sim replaces the verdicts); a TERMINAL candidate (`published`,
 * `withdrawn`) refuses a re-record — a live/retired challenge is never
 * re-simulated. Verdicts are closed-world-normalized by the caller
 * (`lessonAssembly.normalizeSimulationVerdicts`) — this only persists them.
 */
export async function setCandidateSimulation(
  tenantId: string,
  candidateId: string,
  verdicts: SimulationVerdict[],
): Promise<FactoryCandidate | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await getCandidate(tenantId, candidateId);
    if (!c) return null;
    if (c.state === 'published' || c.state === 'withdrawn') return c;
    const next: FactoryCandidate = {
      ...c,
      simulation: { verdicts, recordedAt: nowIso() },
      updatedAt: nowIso(),
    };
    if (await candidates.compareAndSwap(c, next)) return next;
  }
  return await getCandidate(tenantId, candidateId);
}

/**
 * The ONE citation key. ARCH-4: the B7 fix originally added a SECOND function
 * with identical semantics and a different encoding, nineteen lines from this
 * one. Two exported functions hashing the same input to different strings is
 * the drift trap that yields a bug the first time someone compares a stored
 * key to a computed one. `recordResearch` derives every hash through THIS.
 */
export function sourceHash(url: string, title: string): string {
  return `sha256:${createHash('sha256').update(`${url}|${title}`).digest('hex').slice(0, 32)}`;
}

/**
 * Record the research dossier (structure-validated, fail-closed):
 *  - every claim's sourceHashes must resolve to a recorded source
 *    (unsupported claims are RECORDED as unsupported, never silently kept);
 *  - stub/demo engines are refused (PRD §7.4 honesty rule) — the factory
 *    never carries placeholder retrieval into a candidate's evidence.
 */

/**
 * KTFULL-B7 — the rights domain, DERIVED. Rights blocking is keyed on
 * `domain`, which also arrived from the caller, so a source could declare
 * `domain: "example.com"` for a `ted.com` URL and walk straight through the
 * blocked-domain gate. The domain now comes from the URL itself; a URL that
 * does not parse is rejected rather than defaulted, because a permissive
 * fallback here IS the bypass.
 */
export class UnparsableSourceUrlError extends Error {
  constructor(public readonly url: string) {
    super(`Source URL cannot be parsed: ${url}`);
  }
}

export function sourceDomain(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnparsableSourceUrlError(url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new UnparsableSourceUrlError(url);
  return parsed.hostname.toLowerCase();
}

export async function recordResearch(
  tenantId: string,
  candidateId: string,
  dossier: Omit<ResearchDossier, 'recordedAt' | 'unsupportedClaimIds' | 'engines'>,
): Promise<FactoryCandidate | null> {
  // KTFULL-B7 — normalize BEFORE any gate reads these fields. Caller-supplied
  // `domain` and `hash` are discarded, not merely validated: validation would
  // still leave the trusted value in place when it happened to look plausible.
  const sources = dossier.sources.map((s) => ({
    ...s,
    domain: sourceDomain(s.url),
    hash: sourceHash(s.url, s.title),
  }));
  // Claims cite by hash, so re-point each claim's citations at the DERIVED
  // hash of the source it named. A citation that matches no recorded source
  // stays unmatched and is reported as unsupported.
  // ARCH-M4 — build the re-pointing map only from UNAMBIGUOUS caller hashes.
  // `new Map(...)` keeps the LAST entry, so two sources sharing a
  // caller-supplied hash silently collapsed and every claim citing it was
  // re-pointed at whichever source happened to come last — then passed the
  // support gate as "supported" by a source it never cited. A duplicated
  // caller hash is now dropped from the map, so those citations stay
  // unresolved and surface as UNSUPPORTED, which is the honest outcome.
  const seen = new Map<string, string | null>();
  for (const [i, src] of dossier.sources.entries()) {
    seen.set(src.hash, seen.has(src.hash) ? null : sources[i]!.hash);
  }
  const claims = dossier.claims.map((cl) => ({
    ...cl,
    // An unmapped or ambiguous citation is left VERBATIM; it then fails the
    // `known` check below unless it coincidentally equals a derived hash.
    sourceHashes: cl.sourceHashes.map((h) => seen.get(h) ?? h),
    // ADR 0494 P2b — verdicts are re-pointed through the SAME map as the
    // citations, or a caller-supplied hash would leave a verdict orphaned against
    // a source that was re-hashed. A verdict whose source is not recorded is
    // DROPPED: it can support nothing, and keeping it would let a fabricated
    // pairing look like evidence.
    ...(cl.support
      ? {
        support: cl.support
          .map((sp) => ({ ...sp, sourceHash: seen.get(sp.sourceHash) ?? sp.sourceHash }))
          .filter((sp) => sources.some((sc) => sc.hash === sp.sourceHash)),
      }
      : {}),
  }));
  // ADR 0494 P2c — stamp which sources were actually READ. Supplied by the
  // extraction step (the only stage that knows what the fetch returned); absent ⇒
  // leave `retrieved` undefined rather than guessing, so "unknown" and "not read"
  // stay distinguishable.
  const readSet = dossier.readSourceHashes
    ? new Set(dossier.readSourceHashes.map((h) => seen.get(h) ?? h))
    : null;
  const markedSources = readSet
    ? sources.map((sc) => ({ ...sc, retrieved: readSet.has(sc.hash) }))
    : sources;
  const normalized = { ...dossier, sources: markedSources, claims };

  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await getCandidate(tenantId, candidateId);
    if (!c) return null;
    const engines = [...new Set(normalized.sources.map((s) => s.engine))];
    // ADR 0101 Phase 4 — the refusal widened from "not a stub" to "may this be
    // STORED as evidence". A provider whose native-search links are licensed only
    // for display alongside the grounded answer they produced (Google's Grounding
    // terms) is not a valid dossier source even though its results are real: the
    // dossier keeps refs + hashes that outlive the run and back a human's
    // publication decision. `engineIsDurable` derives that from the providers
    // SSoT, so stub/demo AND answer-only engines are refused by one rule.
    if (engines.some((e) => !engineIsDurable(e))) throw new StubSourceError(engines);
    const known = new Set(normalized.sources.map((s) => s.hash));
    const unsupported = normalized.claims.filter((cl) => !cl.sourceHashes.some((h) => known.has(h))).map((cl) => cl.claimId);
    const next: FactoryCandidate = {
      ...c,
      state: c.state === 'intake' ? 'researched' : c.state,
      dossier: { ...normalized, engines, unsupportedClaimIds: unsupported, recordedAt: nowIso() },
      updatedAt: nowIso(),
    };
    if (await candidates.compareAndSwap(c, next)) {
      log.info('kicktodo_research_recorded', {
        candidateId,
        sources: normalized.sources.length,
        claims: normalized.claims.length,
        unsupported: unsupported.length,
      });
      return next;
    }
  }
  return await getCandidate(tenantId, candidateId);
}

// ADR 0458 P0 — DSAR sentinel. A FactoryCandidate is a challenge-PROVENANCE record (the
// research dossier, the risk-classification audit, the published-challenge binding) that
// must OUTLIVE its author for the evidence trail to stay intact — so on erasure we
// ANONYMIZE the person-link (`createdBy`) in place rather than delete the row. `[erased]`
// doubles as the idempotency guard (an already-anonymized row is skipped). The
// `[redacted]`/commerce-order precedent.
export const ERASED_SUBJECT = '[erased]';

/** Sever this subject's authorship on every candidate they created (in-place anonymize;
 *  the provenance row survives). Candidates are `${tenantId}::${id}`-keyed with no subject
 *  prefix → scan the tenant. Idempotent (skips rows already carrying the sentinel);
 *  tenant-scoped; returns the count re-stamped. */
export async function anonymizeCreatorAuthor(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_SUBJECT) return 0;
  let n = 0;
  for (const c of await candidates.list()) {
    if (c.tenantId === tenantId && c.createdBy === subjectKey) {
      await candidates.put({ ...c, createdBy: ERASED_SUBJECT, updatedAt: nowIso() });
      n += 1;
    }
  }
  return n;
}

/** Test-only: the module-private collection, for erasure/seed assertions. */
export const __test = { candidates };
