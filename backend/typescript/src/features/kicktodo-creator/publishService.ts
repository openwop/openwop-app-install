/**
 * Rights decisions + gated publication (ADR 0415 P3/D3; PRD §7.3 W5–W7).
 *
 * RIGHTS (fail-closed, versioned policy — never an LLM's copyright guess):
 * the MVP factory only ever CITES sources (link + attribution) — content
 * REUSE lanes (quote/import/generate-from) are out of MVP scope entirely, so
 * the safe floor for an unknown domain is `link-only` (citation is always
 * permitted; nothing is copied). Domains the policy names as AI-processing-
 * prohibited (e.g. TED per its terms) are `blocked`: a claim entailed ONLY by
 * blocked sources is unsupported and fails the gate.
 *
 * PUBLICATION (the N-gate, PRD §7.3 W7): submit → hard deterministic gates →
 * ONE `challenge-publish` approval on the existing approvalService queue →
 * COMPLETE by a DIFFERENT identity (separation of duties — closes KT-R1) →
 * atomic immutable publish into the kicktodo-core owner + candidate
 * projection. Replay/retry safe: every transition is CAS or idempotent.
 */

import { createLogger } from '../../observability/logger.js';
import {
  createChallengePublishApproval,
  getApproval,
  resolveApproval,
  type PendingApproval,
} from '../../host/approvalService.js';
import { OpenwopError } from '../../types.js';
import { getChallenge, publishChallenge } from '../kicktodo-core/challengeService.js';
import { getCandidate, setCandidatePublished, anonymizeCreatorAuthor, ERASED_SUBJECT, claimSupportedBy, disputedSupport, type FactoryCandidate, type ResearchClaim } from './creatorService.js';
import { REQUIRED_SIM_PERSONAS } from './lessonAssembly.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';

const log = createLogger('kicktodo.publish');

/** Versioned rights policy (operator-ownable; v1 ships the conservative
 *  defaults the PRD names). Terms change independently of code — the policy
 *  is data, not logic. */
export interface RightsPolicy {
  version: number;
  /** Domains whose content may NOT enter AI processing / evidence use. */
  blockedDomains: string[];
}

export const DEFAULT_RIGHTS_POLICY: RightsPolicy = {
  version: 1,
  blockedDomains: ['ted.com', 'www.ted.com'],
};

export type RightsDisposition = 'link-only' | 'blocked';

export interface RightsDecision {
  sourceHash: string;
  domain: string;
  disposition: RightsDisposition;
  policyVersion: number;
}

export function decideRights(
  sources: ReadonlyArray<{ hash: string; domain: string }>,
  policy: RightsPolicy = DEFAULT_RIGHTS_POLICY,
): RightsDecision[] {
  const blocked = new Set(policy.blockedDomains.map((d) => d.toLowerCase()));
  return sources.map((s) => ({
    sourceHash: s.hash,
    domain: s.domain,
    disposition: blocked.has(s.domain.toLowerCase()) ? 'blocked' : 'link-only',
    policyVersion: policy.version,
  }));
}

export interface PublicationRecord {
  approvalId: string;
  challengeId: string;
  challengeVersion: number;
  submittedBy: string;
  rightsDecisions: RightsDecision[];
  completedBy?: string;
  completedAt?: string;
}

export type PublicationPhase = 'submitted' | 'completed';

/** KT-EXP-7 (grade-data) — the record carries no `state`; the FE client type +
 *  the Provenance Spine expect one. Derive it at the read boundary so a completed
 *  publication actually reads as completed (else the spine's publication phase and
 *  the "Approve & publish" step were driven by a permanently-undefined field). */
export function publicationView(r: PublicationRecord): PublicationRecord & { state: PublicationPhase } {
  return { ...r, state: r.completedAt ? 'completed' : 'submitted' };
}

/** Keyed `${tenant}::${candidateId}` — ONE publication act per candidate. */
const publications = new DurableCollection<PublicationRecord & { tenantId: string; candidateId: string }>(
  'kicktodo-publications',
  (p) => `${p.tenantId}::${p.candidateId}`,
);

export class PublicationGateError extends Error {
  constructor(public readonly gate: string, message: string) {
    super(message);
  }
}

/**
 * The five publication gates, and the ONE set of predicates that BOTH the
 * authoritative write path (`assertGates`) and the display-only read
 * (`evaluateGates` → ADR 0460 §3 read 1) derive from, so the honest matrix the
 * Studio renders can never drift from what the engine actually enforces.
 *
 * ADR 0460 §2 correction note: `rights` is NOT an independent write-path throw —
 * blocked-domain sources are folded INTO the `claims` predicate (a claim entailed
 * only by blocked sources is unsupported). So `assertGates` throws on FOUR gates
 * (evidence → claims → safety → simulation, first-fail, verbatim messages); the
 * matrix additionally surfaces `rights` as a DISPLAY-ONLY disclosure row (which
 * domains were blocked), never a pass/fail the engine enforces.
 */
export type CreatorGate = 'evidence' | 'claims' | 'rights' | 'safety' | 'simulation' | 'disputed';
export type GateState = 'pass' | 'open';
export interface GateRow {
  gate: CreatorGate;
  state: GateState;
  detail: string;
  /** `rights` is a disclosure row (blocked-domain transparency), not a gate the
   *  write path enforces — the FE renders it as info, not the pass/open grammar. */
  informational?: boolean;
}

/** Each predicate returns the failing `detail` (→ state `open`) or `null` (→ `pass`).
 *  The messages are the verbatim `assertGates` strings — copying them here is what
 *  keeps the read honest; the parity test pins that they never diverge. */
function evidenceGate(c: FactoryCandidate): string | null {
  if (!c.dossier) return 'No research dossier — a challenge cannot publish without evidence.';
  if (c.dossier.engines.some((e) => e === 'stub' || e === 'demo')) return 'Stub/demo retrieval in the dossier — fail-closed.';
  return null;
}
function claimsGate(c: FactoryCandidate, rights: RightsDecision[]): string | null {
  // No dossier ⇒ claims are unverifiable, not satisfied. The write path never
  // reaches this branch (evidence throws first), but the READ shows all rows at
  // once — reporting `pass` here would paint a green it can't back (ADR 0460 OQ2).
  if (!c.dossier) return 'Cannot evaluate claims — no research dossier (see the evidence gate).';
  const blockedHashes = new Set(rights.filter((r) => r.disposition === 'blocked').map((r) => r.sourceHash));
  // A citation is USABLE when the source is recorded and not rights-blocked.
  const usable = (cl: ResearchClaim, h: string) =>
    !blockedHashes.has(h) && c.dossier!.sources.some((s) => s.hash === h)
    // ADR 0494 P2b — when entailment verdicts EXIST for a claim, structure is no
    // longer enough: the cited source must actually SUPPORT it. This is the
    // "real sources applied incorrectly" case. Dossiers recorded before
    // verification carry no `support`, and fall back to the structural check so
    // older candidates keep their prior meaning rather than silently failing.
    && (cl.support === undefined || claimSupportedBy(cl, h));
  const effectiveUnsupported = c.dossier.claims
    .filter((cl) => !cl.sourceHashes.some((h) => usable(cl, h)))
    .map((cl) => cl.claimId);
  return effectiveUnsupported.length ? `Unsupported claims after rights blocking: ${effectiveUnsupported.join(', ')}.` : null;
}
function safetyGate(c: FactoryCandidate): string | null {
  return c.riskTier === 'prohibited' ? 'Prohibited-tier candidates never publish.' : null;
}
// ADR 0458 §2.2 — the simulation gate is REAL: a verdict from ALL three sim
// personas (fail-closed COVERAGE — a missing/unreadable persona is normalized to
// absent/`block` upstream, never a silent pass) and NONE may be `block`. A `flag`
// PASSES (advisory — recorded into the approval context for the human approver).
function simulationGate(c: FactoryCandidate): string | null {
  const sim = c.simulation;
  const missing = REQUIRED_SIM_PERSONAS.filter((p) => !sim?.verdicts.some((v) => v.sim === p));
  if (!sim || missing.length) return `The challenge has not been simulated against all participant personas (missing: ${missing.join(', ') || 'all'}).`;
  const blocked = sim.verdicts.filter((v) => v.verdict === 'block').map((v) => v.sim);
  return blocked.length ? `Simulation blocked publication — a participant persona could not complete the challenge (${blocked.join(', ')}).` : null;
}
/** DISPLAY-ONLY disclosure — which source domains the rights policy blocked. Never
 *  a write-path throw (the effect is already folded into `claimsGate`). */
function rightsGate(rights: RightsDecision[]): string | null {
  const blockedDomains = [...new Set(rights.filter((r) => r.disposition === 'blocked').map((r) => r.domain))];
  return blockedDomains.length ? `Rights-blocked source domains (citation-only floor): ${blockedDomains.join(', ')}.` : null;
}

/** ADR 0494 P2b — DISPLAY-ONLY disclosure of DISPUTED entailment: pairs where the
 *  second, independent judgement disagreed with the first about whether a source
 *  supports its claim.
 *
 *  Deliberately informational, never a write-path throw. The competitive evidence
 *  is that disagreement is the SIGNAL FOR HUMAN SCRUTINY — auto-failing on it
 *  would discard the most valuable output of verifying twice. A disputed pair
 *  already fails to COUNT as support in `claimsGate` (so it cannot silently carry
 *  a claim); this row is what puts it in front of the approver.
 */
function disputedGate(c: FactoryCandidate): string | null {
  const disputed = (c.dossier?.claims ?? []).flatMap((cl) =>
    disputedSupport(cl).map((sp) => `${cl.claimId} (${sp.verdict} vs ${sp.secondOpinion})`));
  return disputed.length
    ? `Independent reviewers disagreed on whether the source supports the claim: ${disputed.join(', ')}. Read the cited passage before approving.`
    : null;
}

/** The hard deterministic gates (run at submit AND re-run at complete).
 *  Throws the FIRST open gate in the same order + with the same messages as
 *  before the ADR 0460 predicate extraction — write-path behavior is unchanged. */
function assertGates(candidate: FactoryCandidate, rights: RightsDecision[]): void {
  const ordered: ReadonlyArray<readonly [Exclude<CreatorGate, 'rights'>, string | null]> = [
    ['evidence', evidenceGate(candidate)],
    ['claims', claimsGate(candidate, rights)],
    ['safety', safetyGate(candidate)],
    ['simulation', simulationGate(candidate)],
  ];
  for (const [gate, detail] of ordered) {
    if (detail) throw new PublicationGateError(gate, detail);
  }
}

/** ADR 0460 §3 read 1 — the honest 5-gate matrix, re-derived from the SAME
 *  predicates the write path enforces (display-only; changes no state). */
export function evaluateGates(candidate: FactoryCandidate, rights: RightsDecision[]): GateRow[] {
  const row = (gate: CreatorGate, detail: string | null, informational = false): GateRow => ({
    gate,
    state: detail ? 'open' : 'pass',
    detail: detail ?? '',
    ...(informational ? { informational: true } : {}),
  });
  return [
    row('evidence', evidenceGate(candidate)),
    row('claims', claimsGate(candidate, rights)),
    row('rights', rightsGate(rights), true),
    row('disputed', disputedGate(candidate), true),
    row('safety', safetyGate(candidate)),
    row('simulation', simulationGate(candidate)),
  ];
}

/** The advisory sim findings (from `flag` verdicts) — surfaced into the approval
 *  proposal so the human approver decides WITH the simulation findings in view. */
function simulationFlagsNote(candidate: FactoryCandidate): string {
  const flagged = (candidate.simulation?.verdicts ?? []).filter((v) => v.verdict === 'flag');
  if (!flagged.length) return 'simulation: clean';
  return `simulation flags — ${flagged
    .map((v) => `${v.sim}: ${v.findings.map((f) => f.text).join('; ') || v.personaSummary || 'flagged'}`)
    .join(' | ')}`;
}

/**
 * Submit for publication: gates → rights decisions recorded → ONE approval on
 * the shared queue. Idempotent: a re-submit returns the existing pending act.
 */
export async function submitForPublication(
  tenantId: string,
  candidateId: string,
  challengeId: string,
  challengeVersion: number,
  submittedBy: string,
): Promise<PublicationRecord> {
  const existing = await publications.get(`${tenantId}::${candidateId}`);
  if (existing) return existing;

  const candidate = await getCandidate(tenantId, candidateId);
  if (!candidate) throw new PublicationGateError('candidate', 'Candidate not found.');
  // KTEXP2-1 (grade-code) — the ADR 0441 binding is AUTHORITATIVE on the write
  // path. The deterministic gates run on the candidate's dossier, so a privileged
  // caller must not be able to pass candidate A's clean-evidence gate and then
  // publish an unrelated challenge B: if the candidate has a bound draft, the
  // submit MUST target exactly it.
  if (candidate.draft &&
      (candidate.draft.challengeId !== challengeId || candidate.draft.challengeVersion !== challengeVersion)) {
    throw new PublicationGateError('challenge', 'The submitted challenge does not match this candidate’s bound draft.');
  }
  const challenge = await getChallenge(tenantId, challengeId, challengeVersion);
  if (!challenge) throw new PublicationGateError('challenge', 'Challenge draft not found — decompose the plan first.');

  const rights = decideRights(candidate.dossier?.sources ?? []);
  assertGates(candidate, rights);

  const approval = await createChallengePublishApproval({
    tenantId,
    proposal:
      `Publish challenge "${challenge.title}" v${challengeVersion} from factory candidate "${candidate.topic}" ` +
      `(risk tier: ${candidate.riskTier}; ${candidate.dossier?.sources.length ?? 0} sources; policy v${rights[0]?.policyVersion ?? DEFAULT_RIGHTS_POLICY.version}; ` +
      `${simulationFlagsNote(candidate)}).`,
    candidateId,
    challengeId,
    challengeVersion,
    submittedBy,
  });

  const record = {
    tenantId,
    candidateId,
    approvalId: approval.approvalId,
    challengeId,
    challengeVersion,
    submittedBy,
    rightsDecisions: rights,
  };
  if (!(await publications.compareAndSwap(null, record))) {
    const winner = await publications.get(`${tenantId}::${candidateId}`);
    if (winner) return winner;
  }
  log.info('kicktodo_publication_submitted', { candidateId, approvalId: approval.approvalId });
  return record;
}

export class SeparationOfDutiesError extends Error {
  constructor() {
    super('Publication must be approved by someone other than the submitter (separation of duties).');
  }
}

/**
 * Complete publication: the APPROVER (≠ submitter, enforced here — closes
 * KT-R1) resolves the queued approval and the challenge publishes atomically
 * into the kicktodo-core owner. Idempotent: a completed publication returns
 * the recorded act; replay never re-publishes.
 */
export async function completePublication(
  tenantId: string,
  candidateId: string,
  approver: string,
  note?: string,
): Promise<PublicationRecord> {
  const record = await publications.get(`${tenantId}::${candidateId}`);
  if (!record) throw new PublicationGateError('publication', 'Nothing submitted for publication.');
  if (record.completedAt) return record; // idempotent — never re-publish

  if (approver === record.submittedBy) throw new SeparationOfDutiesError();

  const candidate = await getCandidate(tenantId, candidateId);
  if (!candidate) throw new PublicationGateError('candidate', 'Candidate not found.');
  assertGates(candidate, record.rightsDecisions); // gates re-run at complete

  const approval = await getApproval(record.approvalId);
  if (!approval || approval.tenantId !== tenantId) throw new PublicationGateError('approval', 'The publication approval is missing.');
  if (approval.status === 'rejected') throw new PublicationGateError('approval', 'The publication approval was rejected.');
  if (approval.status === 'pending') {
    await resolveApproval(record.approvalId, { status: 'approved', decidedBy: approver, note: note ?? `approved by ${approver}` });
  }

  const published = await publishChallenge(tenantId, record.challengeId, record.challengeVersion);
  if (!published || published.status !== 'published') {
    throw new PublicationGateError('challenge', 'The challenge draft could not be published.');
  }

  const stored = await publications.get(`${tenantId}::${candidateId}`);
  if (!stored) throw new PublicationGateError('publication', 'Nothing submitted for publication.');
  if (stored.completedAt) return stored; // a racer completed first — idempotent
  const next = { ...stored, completedBy: approver, completedAt: new Date().toISOString() };
  if (!(await publications.compareAndSwap(stored, next))) {
    const winner = await publications.get(`${tenantId}::${candidateId}`);
    if (winner) return winner;
  }
  // KT-EXP-9 (grade-data) — the candidate lifecycle reaches `published` here, once
  // its challenge is live. Idempotent + best-effort AFTER the durable publish CAS:
  // the money/immutable truth is the published challenge, and this only advances the
  // candidate projection (the spine + kill-switch eligibility read it).
  await setCandidatePublished(tenantId, candidateId);
  log.info('kicktodo_publication_completed', { candidateId, challengeId: record.challengeId, approver });
  return next;
}

/**
 * ADR 0458 §2.2 (correction, 2026-09-15) — the `challenge-publish` decision
 * handler the creator feature registers on the approval core at boot. APPROVE
 * is `completePublication` (the ONE publication act: approver ≠ submitter, gates
 * re-run, approval resolved, challenge published, candidate → published);
 * REJECT is a plain resolve — the candidate's "returned" read derives from the
 * rejected approval's note (`creatorReads.ts`), so no further state flips.
 * Returns `null` for an approval that is not a challenge-publish of this tenant
 * (the core maps it to 404) and `changed: false` when it was already decided
 * (the core maps it to 409). Typed refusals surface as OpenwopError so the
 * inbox shows the same 403/409 the creator route would.
 */
export async function decideChallengePublishApproval(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'challenge-publish' || !approval.challengePublish) return null;
  if (approval.status !== 'pending') return { approval, changed: false };
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) throw new OpenwopError('forbidden', 'Deciding a challenge publication requires an identified approver.', 403, {});
  if (outcome === 'rejected') {
    const lock = await resolveApproval(approvalId, { status: 'rejected', decidedBy, ...(opts.note !== undefined ? { note: opts.note } : {}) });
    return lock ? { approval: lock.approval, changed: lock.changed } : null;
  }
  try {
    await completePublication(tenantId, approval.challengePublish.candidateId, decidedBy, opts.note);
  } catch (err) {
    if (err instanceof SeparationOfDutiesError) throw new OpenwopError('forbidden', err.message, 403, {});
    if (err instanceof PublicationGateError) throw new OpenwopError('conflict', err.message, 409, { gate: err.gate });
    throw err;
  }
  const after = await getApproval(approvalId);
  return { approval: after ?? approval, changed: true };
}

export async function getPublication(tenantId: string, candidateId: string): Promise<PublicationRecord | null> {
  return (await publications.get(`${tenantId}::${candidateId}`)) ?? null;
}

// ADR 0458 P0 — the ONE kicktodo-creator subject eraser. A publication act (like the
// candidate it publishes) is an immutable GOVERNANCE/provenance record — a separation-of-
// duties approval trail — that must survive its actors' erasure, so the DSAR ANONYMIZES the
// person-links (`submittedBy` / `completedBy`) in place rather than deleting the row.
// Candidates are anonymized by creatorService's `anonymizeCreatorAuthor`; both use the same
// `[erased]` sentinel (idempotent). Registered here (publishService already imports
// creatorService, so this is the cycle-free home for the package-level eraser). No
// registerRetentionPurger: candidates, publications, and monitor reports are audit/provenance
// evidence kept for the challenge's lifetime, not aged `confidential-pii`. Tenant-scoped,
// idempotent, no notifications.
export async function eraseCreatorSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  await anonymizeCreatorAuthor(tenantId, subjectKey);
  for (const p of await publications.list()) {
    if (p.tenantId !== tenantId) continue;
    let changed = false;
    const next = { ...p };
    if (p.submittedBy === subjectKey) { next.submittedBy = ERASED_SUBJECT; changed = true; }
    if (p.completedBy === subjectKey) { next.completedBy = ERASED_SUBJECT; changed = true; }
    if (changed) await publications.put(next);
  }
}
registerSubjectEraser(eraseCreatorSubject);

/** Test-only: the module-private collection, for erasure/seed assertions. */
export const __test = { publications };
