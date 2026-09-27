/**
 * KickTodo Creator Studio FE client (ADR 0415 D5 / KTC-3) — React-free over
 * `/host/openwop-app/kicktodo/creator/*`.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const BASE = `${config.baseUrl}/host/openwop-app/kicktodo/creator`;

export interface ResearchSource {
  url: string;
  domain: string;
  title: string;
  hash: string;
  engine: string;
  rank?: number;
}

export interface ResearchClaim {
  claimId: string;
  text: string;
  /** Source hashes that entail this claim; empty ⇒ the claim is unsupported. */
  sourceHashes: string[];
}

export interface ResearchDossier {
  questions: string[];
  sources: ResearchSource[];
  claims: ResearchClaim[];
  unsupportedClaimIds: string[];
  engines: string[];
  recordedAt: string;
}

export interface FactoryCandidate {
  id: string;
  topic: string;
  audience: string;
  transformation: string;
  durationDaysTarget: number;
  dailyMinutesTarget: number;
  riskTier: string;
  riskSignals: string[];
  state: string;
  createdAt: string;
  updatedAt?: string;
  /** Present on the DETAIL read (`getCandidate`), absent from the list projection. */
  dossier?: ResearchDossier;
  /** ADR 0441 (TD1 binding) — the challenge DRAFT this candidate's plan was
   *  decomposed into (via the plan-builder workflow). Its presence is what makes
   *  "Submit for publication" possible; absent until the plan is decomposed. */
  draft?: { challengeId: string; challengeVersion: number };
}

export interface PublicationState {
  state: string;
  approvalId?: string;
  submittedBy?: string;
  completedBy?: string;
}

export interface SourceHealthFinding {
  sourceHash: string;
  url: string;
  health: 'ok' | 'redirected' | 'broken' | 'unreachable';
  httpStatus?: number;
  checkedAt: string;
}

export interface MonitorReport {
  candidateId: string;
  findings: SourceHealthFinding[];
  broken: number;
  checkedAt: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    // KTEXP-1 (grade-code): fetchOpts must be CALLED — it folds `init` in AND adds
    // `credentials: 'include'` in cookie mode. The bare `...fetchOpts` spread the
    // function object and sent every Studio request unauthenticated (401 once
    // kicktodo-creator is enabled). Every sibling client calls it.
    ...fetchOpts(init),
    headers: { 'content-type': 'application/json', ...authedHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`studio request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function listCandidates(): Promise<FactoryCandidate[]> {
  return (await req<{ candidates: FactoryCandidate[] }>('/candidates')).candidates;
}

/** SCREEN_POLISH Studio residue (ADR 0437 §4.2) — the PRECISE "Needs you"
 *  queue. `detail` is verbatim server-side text (approver note / gate message);
 *  the FE localizes only the KIND label. */
export interface NeedsYouRow {
  candidateId: string;
  topic: string;
  kind: 'returned' | 'gates-open' | 'broken-sources';
  detail: string;
  count?: number;
}
export async function getNeedsYou(): Promise<NeedsYouRow[]> {
  return (await req<{ rows: NeedsYouRow[] }>('/needs-you')).rows;
}

/** ADR 0461 P1 — the Challenge Author profile backing the Studio's embedded-chat
 *  welcome: the roster truth (agent id + assigned workflow portfolio, each row
 *  catalog-verified server-side). `null` on failure — the welcome then renders
 *  without a portfolio section rather than painting an unverified list. */
export interface AuthorWorkflow {
  workflowId: string;
  available: boolean;
  nodeCount: number;
}
export interface ChallengeAuthorProfile {
  agentId: string;
  rosterId: string;
  label: string;
  /** ADR 0461 OQ1 — the trust cue (roster truth; e.g. 'review'). */
  autonomyLevel?: string;
  workflows: AuthorWorkflow[];
}
export async function getChallengeAuthor(): Promise<ChallengeAuthorProfile | null> {
  try {
    return await req<ChallengeAuthorProfile>('/author');
  } catch (err) {
    // Degrade to a portfolio-less welcome, but leave a trace — a silent null
    // made a 500 (provisioning failure) indistinguishable from 403/offline.
    console.warn('kicktodo: challenge-author read failed', err);
    return null;
  }
}

/** The candidate DETAIL read (ADR 0437 UX-2.2) — the full record incl. its research
 *  dossier. Backs the candidate workspace + provenance spine. */
export async function getCandidate(candidateId: string): Promise<FactoryCandidate | null> {
  try {
    return await req<FactoryCandidate>(`/candidates/${encodeURIComponent(candidateId)}`);
  } catch {
    return null;
  }
}

/** ADR 0458 §2.3 — the challenge-outline canvas binding. */
export interface OutlineEnsureResult {
  /** The per-candidate outline canvas (created idempotently, keyed one per
   *  candidate). */
  canvasId: string;
  /** What a fresh seed used: 'plan' = the validated plan revision (the SSoT);
   *  'skeleton' = the candidate's intake targets with EMPTY days (no validated
   *  plan yet). Surface 'skeleton' honestly — it is not a generated plan. */
  seededFrom: 'plan' | 'skeleton';
  /** True ⇒ an existing canvas was returned (not seeded this call). */
  reused: boolean;
}

/** A plan-validation defect surfaced to the creator VERBATIM (the participant-
 *  facing honesty of `validatePlan` — never softened). */
export interface OutlineDefect {
  code: string;
  message: string;
  ref?: string;
}

export interface OutlineApplyResult {
  /** True ⇒ the working draft validated and a new plan revision was persisted. */
  applied: boolean;
  /** Non-empty ⇒ the draft was rejected (HTTP 422); render these verbatim. */
  defects: OutlineDefect[];
  /** The new draft challenge version, present only when applied. */
  challengeVersion?: number;
  /** True ⇒ HTTP 409: the bound draft is already published and cannot be
   *  re-applied (a new candidate/version is the path). Surfaced distinctly. */
  publishedConflict?: boolean;
}

/** Ensure (create-or-return) the candidate's outline canvas, then hand back its
 *  id so the caller can open `/challenge-outline/<canvasId>`. Idempotent — the
 *  backend keys ONE canvas per candidate. */
export async function ensureOutlineCanvas(candidateId: string): Promise<OutlineEnsureResult> {
  return await req<OutlineEnsureResult>(`/candidates/${encodeURIComponent(candidateId)}/outline`, { method: 'POST' });
}

/** Apply the working-draft outline: the backend reads the SAVED canvas, projects
 *  it back to a plan, runs `validatePlan`, and — only on zero defects — persists
 *  a new plan revision through the candidate owner (draft → validate → persist).
 *
 *  The wire contract is the standard validate pattern: on pass the backend
 *  returns `{ revision, challengeId, challengeVersion }`; on failure it returns
 *  HTTP 422 with the defect list in `details.defects` (the participant-facing
 *  honesty of `validatePlan`). This wrapper NORMALIZES both into
 *  `OutlineApplyResult` so a rejected draft surfaces its defects rather than a
 *  generic error. Other statuses (404 — never opened; 409 — version conflict /
 *  already published) throw for the caller's generic error path. */
export async function applyOutline(candidateId: string): Promise<OutlineApplyResult> {
  const res = await fetch(`${BASE}/candidates/${encodeURIComponent(candidateId)}/outline/apply`, {
    ...fetchOpts({ method: 'POST' }),
    headers: { 'content-type': 'application/json', ...authedHeaders() },
  });
  if (res.ok) {
    const body = (await res.json()) as { challengeVersion?: number };
    return { applied: true, defects: [], ...(typeof body.challengeVersion === 'number' ? { challengeVersion: body.challengeVersion } : {}) };
  }
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { details?: { defects?: OutlineDefect[] } };
    return { applied: false, defects: Array.isArray(body.details?.defects) ? body.details!.defects! : [] };
  }
  if (res.status === 409) {
    // The bound draft is already published — re-applying is refused (published
    // immutability). Distinct from a defect: nothing the creator edits fixes it.
    return { applied: false, defects: [], publishedConflict: true };
  }
  throw new Error(`apply outline failed: ${res.status}`);
}

export async function getPublication(candidateId: string): Promise<PublicationState | null> {
  try {
    return await req<PublicationState>(`/candidates/${encodeURIComponent(candidateId)}/publication`);
  } catch {
    return null;
  }
}

// ── ADR 0460 Phase 1 — the honesty reads (display-only; re-derived server-side) ──

/** One row of the publication gate matrix. `informational: true` marks the `rights`
 *  disclosure row — a transparency line (which source domains were blocked), NOT a
 *  gate the publish engine enforces, so the UI renders it as info, not pass/fail. */
export interface GateRow {
  gate: 'evidence' | 'claims' | 'rights' | 'safety' | 'simulation';
  state: 'pass' | 'open';
  detail: string;
  informational?: boolean;
}

export interface SimFinding {
  severity: 'note' | 'flag' | 'block';
  text: string;
  day?: number;
}

export interface SimulationVerdict {
  sim: 'newcomer' | 'time-poor' | 'skeptic';
  verdict: 'pass' | 'flag' | 'block';
  personaSummary: string;
  findings: SimFinding[];
}

export interface SimulationVerdicts {
  verdicts: SimulationVerdict[];
  recordedAt: string;
}

/** Per-day durable build signal. There is deliberately NO `enriched` flag — the
 *  rich lesson body is ephemeral node output with no host SSoT (ADR 0460 §3), so
 *  the only honest durable signals are `planned` + `hasMedia`. */
export interface LessonDayStatus {
  day: number;
  planned: boolean;
  hasMedia: boolean;
  mediaKind?: 'image' | 'video';
}

/** The 5-gate matrix, re-derived server-side from the SAME predicates the publish
 *  path enforces. 404 (candidate absent) → null → the workspace shows the honest
 *  "not run" state, never a painted all-green. */
export async function getGateStatus(candidateId: string): Promise<GateRow[] | null> {
  try {
    return (await req<{ gates: GateRow[] }>(`/candidates/${encodeURIComponent(candidateId)}/gates`)).gates;
  } catch {
    return null;
  }
}

/** The durable three-persona simulation record, verbatim. 404 (not simulated) →
 *  null → the workspace shows "not simulated", never a fabricated verdict. */
export async function getSimulationVerdicts(candidateId: string): Promise<SimulationVerdicts | null> {
  try {
    return await req<SimulationVerdicts>(`/candidates/${encodeURIComponent(candidateId)}/simulation`);
  } catch {
    return null;
  }
}

/** Per-day build status. 404 (candidate absent) → null; an empty array = a
 *  candidate with no plan revision yet (honestly distinct from "no candidate"). */
export async function getLessonStatus(candidateId: string): Promise<LessonDayStatus[] | null> {
  try {
    return (await req<{ lessons: LessonDayStatus[] }>(`/candidates/${encodeURIComponent(candidateId)}/lessons`)).lessons;
  } catch {
    return null;
  }
}

/** The operator kill switch (ADR 0415 P4 / 0437 UX-2.6): retire the published
 *  challenge (new enrollments refused; active ones keep their pinned version) and
 *  withdraw the candidate. `reason` is REQUIRED and audited server-side. */
export async function killCandidate(candidateId: string, reason: string): Promise<FactoryCandidate> {
  return await req<FactoryCandidate>(`/candidates/${encodeURIComponent(candidateId)}/kill`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/** Latest post-publication source-health report, if any has been run (ADR 0415 P4).
 *  404 (no report yet) resolves to null — the workspace shows the honest "not run". */
export async function getMonitorReport(candidateId: string): Promise<MonitorReport | null> {
  try {
    return await req<MonitorReport>(`/candidates/${encodeURIComponent(candidateId)}/monitor`);
  } catch {
    return null;
  }
}

// ADR 0458 P4 — createCandidate/submitPublication/completePublication client fns
// removed: intake is chat-first (Challenge Author tool creates candidates) and the
// publication decision lives in the reviews inbox; the HTTP routes remain for API
// completeness, but no FE surface calls them.
