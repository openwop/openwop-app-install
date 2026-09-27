/**
 * KickTodo accountability FE client (ADR 0419 P5) — React-free (the ADR 0413
 * shared-contract posture). Rides /host/openwop-app/circles/*.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

export interface Circle {
  id: string;
  type: string;
  enrollmentId: string;
  name: string;
  conversationId: string;
}

export interface Grant {
  circleId: string;
  granteeSubject: string;
  scopes: string[];
  state: string;
  invitedAt: string;
}

export interface CircleFeed {
  circleId: string;
  summary?: { currentDay: number; durationDays: number; completedActivities: number; totalRequiredActivities: number; state: string };
  actions?: Array<{ title: string; completed: boolean; note?: string }>;
}

const B = () => `${config.baseUrl}/host/openwop-app/circles`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`circles request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function listCircles(): Promise<Circle[]> {
  const res = await fetch(B(), { ...fetchOpts({}), headers: authedHeaders({}) });
  return (await json<{ circles: Circle[] }>(res)).circles;
}

export async function createCircle(enrollmentId: string, type: string, name: string): Promise<Circle> {
  const res = await fetch(B(), {
    ...fetchOpts({}), method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ enrollmentId, type, name }),
  });
  return json<Circle>(res);
}

export async function listGrants(circleId: string): Promise<Grant[]> {
  const res = await fetch(`${B()}/${encodeURIComponent(circleId)}/grants`, { ...fetchOpts({}), headers: authedHeaders({}) });
  return (await json<{ grants: Grant[] }>(res)).grants;
}

export async function invite(circleId: string, granteeSubject: string, scopes: string[]): Promise<Grant> {
  const res = await fetch(`${B()}/${encodeURIComponent(circleId)}/invite`, {
    ...fetchOpts({}), method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ granteeSubject, scopes }),
  });
  return json<Grant>(res);
}

export async function revoke(circleId: string, granteeSubject: string): Promise<void> {
  const res = await fetch(`${B()}/${encodeURIComponent(circleId)}/revoke`, {
    ...fetchOpts({}), method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ granteeSubject }),
  });
  await json(res);
}

export async function getFeed(circleId: string): Promise<CircleFeed> {
  const res = await fetch(`${B()}/${encodeURIComponent(circleId)}/feed`, { ...fetchOpts({}), headers: authedHeaders({}) });
  return json<CircleFeed>(res);
}

/** ADR 0459 P2 — a coach plan-change proposal, read-only in the FE. The DECISION
 *  lives on the approval card in the circle conversation / reviews rail, not here;
 *  this list is history only. */
export interface PlanChangeProposal {
  id: string;
  circleId: string;
  enrollmentId: string;
  coachSubject: string;
  note: string;
  state: 'proposed' | 'applied' | 'dismissed';
  createdAt: string;
  resolvedAt?: string;
  /** ADR 0459 grade-fix — the approval CARD this proposal raised. Present ⇒ decide it
   *  on the card (the conversation / reviews rail). ABSENT ⇒ the raise degraded, so the
   *  honest apply/dismiss fallback on the retained route is the only way to decide it. */
  approvalId?: string;
}

/** The participant's own proposals for an enrollment. Owner-gated server-side: a
 *  non-owner (or a gone enrollment) 404s — treated as an empty history (the section
 *  stays hidden), NOT an error. Any OTHER non-2xx throws, so the caller can render an
 *  honest section-load error instead of silently swallowing a real failure. */
export async function listProposals(enrollmentId: string): Promise<PlanChangeProposal[]> {
  const url = `${config.baseUrl}/host/openwop-app/kicktodo/enrollments/${encodeURIComponent(enrollmentId)}/proposals`;
  const res = await fetch(url, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (res.status === 404) return [];
  return (await json<{ proposals: PlanChangeProposal[] }>(res)).proposals;
}

/** ADR 0459 grade-fix — the participant resolves a proposal through the retained
 *  per-enrollment route. Used ONLY for the DEGRADED case (a proposal with no approval
 *  card): when a card exists, the decision belongs on the card, not here. The route
 *  reconciles any linked card server-side, so this never leaves a stranded pending. */
export async function resolveProposalAction(
  enrollmentId: string,
  proposalId: string,
  action: 'apply' | 'dismiss',
): Promise<PlanChangeProposal> {
  const url = `${config.baseUrl}/host/openwop-app/kicktodo/enrollments/${encodeURIComponent(enrollmentId)}/proposals/${encodeURIComponent(proposalId)}`;
  const res = await fetch(url, {
    ...fetchOpts({}), method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ action }),
  });
  return json<PlanChangeProposal>(res);
}

/** ADR 0444 S1 — one scheduled cohort session (happens in the circle's chat). */
export interface CohortSession {
  circleId: string;
  atIso: string;
  title: string;
  conversationId: string;
}

export async function listSessions(circleId: string): Promise<CohortSession[]> {
  const res = await fetch(`${B()}/${encodeURIComponent(circleId)}/sessions`, { ...fetchOpts({}), headers: authedHeaders({}) });
  return (await json<{ sessions: CohortSession[] }>(res)).sessions;
}

/** Coach (circle owner) only; idempotent per (circle, instant). */
export async function scheduleSession(circleId: string, atIso: string, title: string): Promise<CohortSession> {
  const res = await fetch(`${B()}/${encodeURIComponent(circleId)}/sessions`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ at: atIso, title }),
  });
  return json<CohortSession>(res);
}

// ── ADR 0501 (console) — the coach's side ─────────────────────────────────────

export interface CoachProposalView {
  id: string;
  state: 'proposed' | 'applied' | 'dismissed';
  note: string;
  hasCommands: boolean;
  createdAt: string;
  resolvedAt?: string;
}

export interface CaseloadRow {
  circleId: string;
  circleName: string;
  enrollmentId: string;
  summary: { currentDay: number; durationDays: number; completedActivities: number; totalRequiredActivities: number; state: string } | null;
  flagged: boolean;
  proposals: CoachProposalView[];
}

/** One executable plan-revision command — the closed world of ADR 0429 lanes the
 *  server validates (`validateRevisionCommands`). `substitute` needs activity ids a
 *  coach does not see, so the console composes the other three. */
export type RevisionCommand =
  | { lane: 'schedule'; daypart: 'morning' | 'afternoon' | 'evening' | null }
  | { lane: 'substitute'; cardId: string; alternativeId: string }
  | { lane: 'recovery' }
  | { lane: 'move'; day: number; toDate: string };

const KT = () => `${config.baseUrl}/host/openwop-app/kicktodo`;

/** Every circle where the caller holds a LIVE coach grant, with the caller's own proposals. */
export async function getCaseload(): Promise<CaseloadRow[]> {
  const res = await fetch(`${KT()}/coach/caseload`, { ...fetchOpts({}), headers: authedHeaders({}) });
  return (await json<{ caseload: CaseloadRow[] }>(res)).caseload;
}

/** The coach's dry run: the server validates the commands under the coach grant and
 *  returns the humanized lines it would show the participant. Reads no plan, persists
 *  nothing. A 422 is an off-lane command — surfaced to the composer, never swallowed. */
export async function dryRunProposal(circleId: string, commands: RevisionCommand[]): Promise<{ lines: string[] }> {
  const res = await fetch(`${B()}/${encodeURIComponent(circleId)}/proposals/dry-run`, {
    ...fetchOpts({}), method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ commands }),
  });
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? 'One of the commands is outside the lanes a coach can propose.');
  }
  return json<{ lines: string[] }>(res);
}

/** A coach proposes. `commands` absent ⇒ advice-only (never applyable); present ⇒
 *  executable, validated server-side, decided by the participant on their card. */
export async function createProposal(circleId: string, note: string, commands?: RevisionCommand[]): Promise<PlanChangeProposal> {
  const res = await fetch(`${B()}/${encodeURIComponent(circleId)}/proposals`, {
    ...fetchOpts({}), method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(commands ? { note, commands } : { note }),
  });
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? 'The proposal was refused.');
  }
  return json<PlanChangeProposal>(res);
}
