/**
 * Job-search API client (ADR 0539/0541) — the SPA half of the
 * `/host/openwop-app/job-search/orgs/:orgId/*` host-extension surface.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import type { VerifierClaim } from './attestationVerifyClient.js';
export { listOrgs, type Org } from '../crm/crmOrgClient.js';

const root = `${config.baseUrl}/host/openwop-app`;
const base = (orgId: string): string => `${root}/job-search/orgs/${encodeURIComponent(orgId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The projected grant the "what have I authorised" surface renders. */
export interface ApplyGrantView {
  grantId: string;
  subjectId: string;
  grantedBy: string;
  campaignId: string;
  maxSubmits: number;
  submitsUsed: number;
  maxPrepared: number;
  preparedUsed: number;
  ratePerHour: number;
  tiers: string[];
  origins: string[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateGrantInput {
  campaignId: string;
  maxSubmits: number;
  maxPrepared: number;
  ratePerHour: number;
  origins: string[];
  expiresAt: string;
  tiers?: string[];
}

export async function listGrants(orgId: string): Promise<ApplyGrantView[]> {
  const res = await fetch(`${base(orgId)}/grants`, { ...fetchOpts(), headers: authedHeaders() });
  return (await asJson<{ grants: ApplyGrantView[] }>(res, 'listGrants')).grants;
}

export async function createGrant(orgId: string, input: CreateGrantInput): Promise<ApplyGrantView> {
  const res = await fetch(`${base(orgId)}/grants`, {
    ...fetchOpts(), method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input),
  });
  return (await asJson<{ grant: ApplyGrantView }>(res, 'createGrant')).grant;
}

/** WF-JS-1 — queue one campaign pass as a card on the career agent's board.
 *  201 = a new card; 200 = an identical card was already waiting (idempotent). */
export async function queueCampaign(orgId: string): Promise<{ created: boolean; boardId?: string }> {
  const res = await fetch(`${base(orgId)}/agent/queue-campaign`, {
    ...fetchOpts(), method: 'POST', headers: authedHeaders(),
  });
  const body = await asJson<{ created: boolean; boardId?: string }>(res, 'queueCampaign');
  return { created: body.created === true, ...(typeof body.boardId === 'string' && body.boardId ? { boardId: body.boardId } : {}) };
}

export async function revokeGrant(orgId: string, grantId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/grants/${encodeURIComponent(grantId)}`, {
    ...fetchOpts(), method: 'DELETE', headers: authedHeaders(),
  });
  if (!res.ok && res.status !== 404) throw new Error(`revokeGrant returned ${res.status}`);
}


/** A job listing as the tenant sees it (ADR 0542 D2 — a kernel entity façade). */
export interface JobListing {
  listingId: string;
  title: string;
  companyName: string;
  location: string | null;
  remote: boolean | null;
  sourceBoard: string | null;
  sourceUrl: string | null;
}

export async function listListings(orgId: string): Promise<JobListing[]> {
  const res = await fetch(`${base(orgId)}/listings`, { ...fetchOpts(), headers: authedHeaders() });
  return (await asJson<{ listings: JobListing[] }>(res, 'listListings')).listings;
}

export async function getListingsVisibility(orgId: string): Promise<{ public: boolean }> {
  const res = await fetch(`${base(orgId)}/listings/visibility`, { ...fetchOpts(), headers: authedHeaders() });
  return asJson<{ public: boolean }>(res, 'getListingsVisibility');
}

export async function setListingsVisibility(orgId: string, isPublic: boolean): Promise<void> {
  const res = await fetch(`${base(orgId)}/listings/visibility`, {
    ...fetchOpts(), method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ public: isPublic }),
  });
  if (!res.ok) throw new Error(`setListingsVisibility returned ${res.status}`);
}


// ── Applications + attestation (ADR 0540 P2 / ADR 0544 P4) ──────────────────

/** An application as the applicant sees it. A CRM deal underneath (ADR 0540). */
export interface JobApplication {
  dealId: string;
  title: string;
  companyName: string | null;
  stage: string | null;
  appliedAt: string | null;
}

export async function listApplications(orgId: string): Promise<JobApplication[]> {
  const res = await fetch(`${base(orgId)}/applications`, { ...fetchOpts(), headers: authedHeaders() });
  const raw = await asJson<{
    applications: Array<{
      deal: Record<string, unknown>;
      digest: Record<string, unknown> | null;
      stageName: string | null;
      appliedAt: string | null;
    }>;
  }>(res, 'listApplications');
  // `stageName` and `appliedAt` are resolved by the ROUTE. The client used to
  // read `deal.stageName`, which does not exist on a deal (it carries
  // `stageId`), so the Stage column was permanently empty — visible only by
  // rendering the page.
  return raw.applications.map((r) => ({
    dealId: String(r.deal.dealId ?? ''),
    title: String(r.digest?.title ?? r.deal.title ?? ''),
    companyName: (r.digest?.companyName as string | undefined) ?? null,
    stage: r.stageName ?? null,
    appliedAt: r.appliedAt ?? null,
  }));
}

/**
 * What issuing WOULD disclose. Distinguishes the two refusals, because they mean
 * different things to the applicant and neither is a bug: `not-attestable` says
 * this host has no record of sending it (so there is nothing to vouch for), and
 * `not-the-subject` says the application is someone else's.
 */
export type AttestationPreview =
  | { kind: 'ok'; claims: VerifierClaim[] }
  | { kind: 'not-attestable' }
  | { kind: 'not-the-subject' }
  | { kind: 'failed' };

export async function previewAttestation(orgId: string, dealId: string): Promise<AttestationPreview> {
  let res: Response;
  try {
    res = await fetch(`${base(orgId)}/applications/${encodeURIComponent(dealId)}/attestation-preview`, {
      ...fetchOpts(), headers: authedHeaders(),
    });
  } catch {
    return { kind: 'failed' };
  }
  if (res.status === 404) return { kind: 'not-attestable' };
  if (res.status === 403) return { kind: 'not-the-subject' };
  if (!res.ok) return { kind: 'failed' };
  try {
    return { kind: 'ok', claims: (await res.json() as { claims: VerifierClaim[] }).claims };
  } catch {
    return { kind: 'failed' };
  }
}

/** Issue. The raw token comes back ONCE — there is no route that re-reads it. */
export async function issueAttestation(orgId: string, dealId: string): Promise<{ token: string; attestationId: string }> {
  const res = await fetch(`${base(orgId)}/attestations`, {
    ...fetchOpts(), method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ dealId }),
  });
  return asJson<{ token: string; attestationId: string }>(res, 'issueAttestation');
}

export interface AttestationRow {
  attestationId: string;
  dealId: string;
  issuedAt: string;
  revokedAt?: string;
}

export async function listIssuedAttestations(orgId: string): Promise<AttestationRow[]> {
  const res = await fetch(`${base(orgId)}/attestations`, { ...fetchOpts(), headers: authedHeaders() });
  return (await asJson<{ attestations: AttestationRow[] }>(res, 'listIssuedAttestations')).attestations;
}

export async function revokeAttestation(orgId: string, attestationId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/attestations/${encodeURIComponent(attestationId)}`, {
    ...fetchOpts(), method: 'DELETE', headers: authedHeaders(),
  });
  if (!res.ok && res.status !== 404) throw new Error(`revokeAttestation returned ${res.status}`);
}


// ── The answer bank (ADR 0545 P2) ───────────────────────────────────────────
//
// SUBJECT-scoped, so these calls carry no orgId: the backend takes the subject
// from the session and there is no parameter through which one could be named.
// A client that appended `?subjectId=` would be describing a route that does not
// exist.

export interface StandardQuestion {
  key: string;
  prompt: string;
  kind: 'text' | 'longtext' | 'number' | 'money' | 'date' | 'boolean' | 'choice' | 'url';
  options?: string[];
  why: string;
  core: boolean;
}

export interface StoredAnswer {
  questionKey: string;
  questionText: string;
  value: string;
  source: 'profile' | 'user' | 'inferred';
  confirmedAt: string | null;
  usageCount: number;
}

export interface AnswerBankView {
  questions: StandardQuestion[];
  coreKeys: string[];
  answers: StoredAnswer[];
  coverage: { ratio: number; totalCovered: number; totalRequired: number; totalDeclined: number };
}

const ME = `${root}/job-search/me/answers`;

export async function getAnswerBank(): Promise<AnswerBankView> {
  const res = await fetch(ME, { ...fetchOpts(), headers: authedHeaders() });
  return asJson<AnswerBankView>(res, 'getAnswerBank');
}

/** A refusal is an answer, not an error — the wizard has to explain it. */
export type SaveAnswerResult =
  | { kind: 'saved' }
  | { kind: 'refused'; reason: string; message: string }
  | { kind: 'failed' };

export async function saveAnswer(questionText: string, value: string): Promise<SaveAnswerResult> {
  let res: Response;
  try {
    res = await fetch(ME, {
      ...fetchOpts(), method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ questionText, value }),
    });
  } catch {
    return { kind: 'failed' };
  }
  if (res.ok) return { kind: 'saved' };
  if (res.status === 422) {
    const b = (await res.json().catch(() => ({}))) as { reason?: string; message?: string };
    return { kind: 'refused', reason: b.reason ?? 'unknown', message: b.message ?? '' };
  }
  return { kind: 'failed' };
}


// ── Batched exceptions (ADR 0545 D3/P5) ─────────────────────────────────────

export interface CampaignException {
  questionKey: string;
  questionText: string;
  reason: 'unknown' | 'unconfirmed' | 'special-category' | 'low-confidence';
  /** Applications waiting on this ONE answer. */
  blockedCount: number;
  firstSeenAt: string;
}

const EXC = `${root}/job-search/me/exceptions`;

export async function listExceptions(): Promise<CampaignException[]> {
  const res = await fetch(EXC, { ...fetchOpts(), headers: authedHeaders() });
  return (await asJson<{ exceptions: CampaignException[] }>(res, 'listExceptions')).exceptions;
}

export async function answerException(questionText: string, value: string): Promise<void> {
  const res = await fetch(EXC, {
    ...fetchOpts(), method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ questionText, value }),
  });
  if (!res.ok) throw new Error(`answerException returned ${res.status}`);
}


// ── Lifecycle (ADR 0546) ────────────────────────────────────────────────────

/** A rate with its numbers. `rate: null` means "not enough data", NEVER 0%. */
export interface Rate { numerator: number; denominator: number; rate: number | null }

export interface FunnelReport {
  reachedStage: Record<'applied' | 'screening' | 'interviewing' | 'offer', number>;
  responseRate: Rate;
  conversions: Array<{ from: string; to: string; rate: Rate }>;
  warmVsCold: { warm: Rate; cold: Rate };
  medianHoursToFirstResponse: number | null;
  bySource: Array<{ source: string; rate: Rate }>;
  silent: number;
  /** False ⇒ the "Job search" pipeline is missing/renamed — render THAT, not
   *  an empty funnel (grade-trio finding 9). */
  pipelineFound: boolean;
}

export async function getFunnel(orgId: string): Promise<FunnelReport> {
  const res = await fetch(`${base(orgId)}/funnel`, { ...fetchOpts(), headers: authedHeaders() });
  return asJson<FunnelReport>(res, 'getFunnel');
}

/** JSUX-FUN-2 (R3) — ONE request for the funnel page's three reads (the
 *  rate-limit fan-out note); same predicates server-side. */
export async function getFunnelBundle(orgId: string): Promise<{ report: FunnelReport; followUps: FollowUpRow[]; drafts: DraftRow[] }> {
  const res = await fetch(`${base(orgId)}/funnel-bundle`, { ...fetchOpts(), headers: authedHeaders() });
  return asJson<{ report: FunnelReport; followUps: FollowUpRow[]; drafts: DraftRow[] }>(res, 'getFunnelBundle');
}

export interface FollowUpRow { dealId: string; dealTitle: string; stage: string; dueAt: string }

export async function getFollowUps(orgId: string): Promise<FollowUpRow[]> {
  const res = await fetch(`${base(orgId)}/follow-ups`, { ...fetchOpts(), headers: authedHeaders() });
  return (await asJson<{ followUps: FollowUpRow[] }>(res, 'getFollowUps')).followUps;
}

export async function completeFollowUp(orgId: string, dealId: string, stage: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/follow-ups/${encodeURIComponent(dealId)}/${encodeURIComponent(stage)}/complete`, {
    ...fetchOpts(), method: 'POST', headers: authedHeaders(),
  });
  if (!res.ok && res.status !== 404) throw new Error(`completeFollowUp returned ${res.status}`);
}

export interface DraftRow {
  dealId: string;
  dealTitle: string;
  kind: 'interview-reply' | 'prep-sheet' | 'warm-intro';
  body: string;
  approvedAt?: string;
}

export async function getDrafts(orgId: string): Promise<DraftRow[]> {
  const res = await fetch(`${base(orgId)}/drafts`, { ...fetchOpts(), headers: authedHeaders() });
  return (await asJson<{ drafts: DraftRow[] }>(res, 'getDrafts')).drafts;
}

/** Records a human decision. There is no send route, by design (D2). */
export async function approveDraft(orgId: string, dealId: string, kind: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/drafts/${encodeURIComponent(dealId)}/${encodeURIComponent(kind)}/approve`, {
    ...fetchOpts(), method: 'POST', headers: authedHeaders(),
  });
  if (!res.ok) throw new Error(`approveDraft returned ${res.status}`);
}
