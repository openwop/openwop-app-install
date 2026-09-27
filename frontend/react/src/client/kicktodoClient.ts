/**
 * KickTodo FE client (ADR 0414 P5) — the participant loop over the host-ext
 * surface `/host/openwop-app/kicktodo/*`. React-free (the ADR 0413 shared-
 * package seam: this module is contract material for the native client too).
 */
import { authedHeaders, config, fetchOpts } from './config.js';

export interface ChallengeActivity {
  stableActivityId: string;
  day: number;
  title: string;
  instructions: string;
  estimatedMinutes?: number;
  evidencePolicy: string;
}

export interface ChallengeSummary {
  id: string;
  version: number;
  status: string;
  title: string;
  summary: string;
  outcome: string;
  durationDays: number;
  activities: ChallengeActivity[];
  /** ADR 0443 R4 — content-depth facet; absent = unlabeled. */
  depthLevel?: 'beginner' | 'intermediate' | 'advanced';
  contentHash?: string;
}

export interface Enrollment {
  id: string;
  challengeId: string;
  challengeVersion: number;
  state: string;
  goalId: string;
  planRevision: number;
  timezone: string;
  startDateLocal: string;
  /** ADR 0443 R1 — the opt-in reminder rhythm; absent = no reminder cadence. */
  schedulePreference?: { daypart?: 'morning' | 'afternoon' | 'evening' };
}

export interface ChallengeAlternativeOption {
  stableActivityId: string;
  title: string;
  instructions: string;
}

export interface TodayAction {
  occurrence: {
    cardId: string;
    stableActivityId: string;
    occurrenceDateLocal: string;
    evidencePolicy: string;
    /** ADR 0429 — the publisher-declared alternative currently chosen. */
    substitutedActivityId?: string;
  };
  /** ADR 0429 — the closed set the participant may swap to (may be empty). */
  alternatives?: ChallengeAlternativeOption[];
  card: { id: string; title: string; description?: string; columnId: string; completed: boolean } | null;
  checkIn: { note?: string; createdAt: string } | null;
}

export interface TodayView {
  dateLocal: string;
  enrollments: Array<{
    enrollmentId: string;
    challengeId: string;
    challengeVersion: number;
    state: string;
    actions: TodayAction[];
    recovery?: { missed: number; mode: 'offer' | 'review' };
  }>;
}

/** One §5.6 trace row — one materialized action in the participant's record. */
export interface ProgressTraceRow {
  stableActivityId: string;
  day: number | null;
  title: string | null;
  recovery: boolean;
  dateLocal: string;
  completed: boolean;
  checkedInAt?: string;
}

export interface ProgressView {
  enrollmentId: string;
  state: string;
  goalState: string | null;
  currentDay: number;
  durationDays: number;
  totalRequiredActivities: number;
  completedActivities: number;
  checkInCount: number;
  /** §5.6 — evidence trace + store-backed recovery state. */
  trace: ProgressTraceRow[];
  recovery: { offered: number; completed: number };
}

const B = () => `${config.baseUrl}/host/openwop-app/kicktodo`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`kicktodo request failed: ${res.status}`);
  return (await res.json()) as T;
}

export interface NegotiatedChallenge {
  challenge: ChallengeSummary;
  /** The content locale actually served (may differ from the request). */
  servedLocale: string;
  /** False when the requested content locale was unavailable — disclose it. */
  exactLocale: boolean;
}

/** ADR 0430 P2 — Discover with CONTENT-locale negotiation, INDEPENDENT of the
 *  UI locale (the PRD keeps the two axes separate). */
export async function listChallengesForLocale(contentLocale: string): Promise<NegotiatedChallenge[]> {
  const res = await fetch(`${B()}/catalog?contentLocale=${encodeURIComponent(contentLocale)}`, {
    ...fetchOpts({}),
    headers: authedHeaders({}),
  });
  return (await json<{ challenges: NegotiatedChallenge[] }>(res)).challenges;
}

/**
 * ADR 0684 phase 4 / ADR 0641 phase 3 — the ANONYMOUS catalog.
 *
 * `GET /public/:orgId/challenges` resolves org → tenant SERVER-side, so a
 * signed-out visitor reads the declared default workspace's catalog rather than
 * their own empty `anon:<sid>` tenant. No credential, and deliberately no
 * enrollment state: `enrollmentService.ts:175` fetches the challenge from the
 * ENROLLING tenant, so a stranger cannot enroll from here and there is nothing
 * of theirs to show. Enrolling is what signing up is for.
 *
 * The org id is the stable one `kicktodo-core` declares (ADR 0684 §3), so this
 * needs no per-deployment configuration.
 */
export const PUBLIC_CATALOG_ORG = 'host-kicktodo';

export async function publicChallengeCatalog(
  contentLocale: string, orgId: string = PUBLIC_CATALOG_ORG,
): Promise<ChallengeSummary[]> {
  // No `authedHeaders` — this is the anonymous family. Sending a credential here
  // would make a shared-cacheable response look per-caller.
  const res = await fetch(`${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/challenges`, {
    ...fetchOpts({}),
    headers: { 'Accept-Language': contentLocale },
  });
  // The anonymous wire (`PublicChallenge`, publicCatalogService.ts) is spelled
  // out field by field and names the id `challengeId`; the SPA's card model
  // names it `id`. A bare cast hid that from tsc and every public card linked to
  // `/discover/undefined` (measured on production 2026-09-15). Normalise here,
  // once, at the boundary — and keep `status: 'published'`, which the public
  // route guarantees by construction.
  const { challenges } = await json<{ challenges: PublicChallengeWire[] }>(res);
  return challenges.map(publicChallengeToSummary);
}

/** The anonymous catalog entry as the wire actually carries it (additive-only;
 *  mirrors `PublicChallenge` in kicktodo-core/publicCatalogService.ts). */
export interface PublicChallengeWire {
  challengeId: string;
  version: number;
  title: string;
  summary: string;
  outcome: string;
  durationDays: number;
  servedLocale: string;
  exactLocale: boolean;
  /** Shaped as `publicCatalogService.project` emits it, not as the stored row:
   *  no `stableActivityId` (a mechanic, kept off the anonymous wire). The first
   *  cut typed this as `ChallengeActivity[]`, which let a test fixture carry
   *  fields the wire never did — and the signed-out preview read "just check
   *  in" on production for a challenge whose signed-in page said "note".
   *  `evidencePolicy` is optional ONLY for a list served by a backend older
   *  than the 2026-09-16 correction; the page treats absence as "shown after
   *  sign-in", never as the weakest policy. */
  activities: Array<Omit<ChallengeActivity, 'stableActivityId' | 'evidencePolicy'> & { evidencePolicy?: string }>;
  depthLevel?: 'beginner' | 'intermediate' | 'advanced';
}

/** Pure, so a test can prove the mapping from a public-shaped fixture. */
export function publicChallengeToSummary(c: PublicChallengeWire): ChallengeSummary {
  return {
    id: c.challengeId,
    version: c.version,
    status: 'published',
    title: c.title,
    summary: c.summary,
    outcome: c.outcome,
    durationDays: c.durationDays,
    // A derived id, stable for one wire body: the detail page keys its rhythm
    // rows on it, and the public wire deliberately carries none.
    activities: (c.activities ?? []).map((a, i) => ({
      ...a,
      stableActivityId: `${c.challengeId}:${a.day}:${i}`,
      evidencePolicy: a.evidencePolicy ?? '',
    })),
    ...(c.depthLevel ? { depthLevel: c.depthLevel } : {}),
  };
}

/** One challenge for the detail surface (ADR 0436 §5.4) — resolved from the same
 *  locale-negotiated catalog projection (no separate detail endpoint); the summary
 *  IS the commitment preview a participant must see before enrolling. */
export async function getChallengeForLocale(id: string, contentLocale: string): Promise<NegotiatedChallenge | null> {
  const list = await listChallengesForLocale(contentLocale);
  return list.find((n) => n.challenge.id === id) ?? null;
}

/**
 * The ANONYMOUS counterpart of `getChallengeForLocale` (ADR 0684 phase 4).
 *
 * Measured on production 2026-09-16 (`bc51bbc`): a signed-out visitor could reach
 * `/discover/:challengeId` (the cards and the route param were fixed in #3850)
 * and still saw "Challenge not found", because the detail page read through the
 * tenant-scoped catalog and a stranger's tenant is an empty `anon:<sid>`.
 *
 * There is no public DETAIL endpoint, and this deliberately does not ask for
 * one: the public LIST already publishes everything the detail surface renders
 * (`activities` with `day`/`title`/`instructions`/`estimatedMinutes`, `summary`,
 * `outcome`, `durationDays`, `depthLevel` — see publicCatalogService.ts). So the
 * preview a stranger sees here is exactly the projection ADR 0684 already
 * publishes one hop away; nothing new is exposed. If the operator ever wants
 * the anonymous detail to show LESS than the list, that is a change to the
 * list projection, and this read follows it for free.
 */
export async function publicChallengeForLocale(
  id: string, contentLocale: string, orgId: string = PUBLIC_CATALOG_ORG,
): Promise<NegotiatedChallenge | null> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/challenges`, {
    ...fetchOpts({}),
    headers: { 'Accept-Language': contentLocale },
  });
  const { challenges } = await json<{ challenges: PublicChallengeWire[] }>(res);
  const w = challenges.find((c) => c.challengeId === id);
  return w ? { challenge: publicChallengeToSummary(w), servedLocale: w.servedLocale, exactLocale: w.exactLocale } : null;
}

export async function listChallenges(): Promise<ChallengeSummary[]> {
  const res = await fetch(`${B()}/challenges`, { ...fetchOpts({}), headers: authedHeaders({}) });
  return (await json<{ challenges: ChallengeSummary[] }>(res)).challenges;
}

/** ADR 0455 P2 — the price a paid challenge sells for (or null for a free one).
 *  The Detail page surfaces this + a Buy CTA instead of dead-ending at the enroll
 *  wall. Any failure (feature off, no session) is treated as "free" — the price
 *  section is additive and must never break Discover. */
export interface ChallengePrice {
  productId: string;
  orgId: string;
  price: number;
  currency: string;
  active: boolean;
}
export async function getChallengePrice(challengeId: string, version: number): Promise<ChallengePrice | null> {
  try {
    const res = await fetch(`${B()}/entitlements/challenges/${encodeURIComponent(challengeId)}/${version}/price`, {
      ...fetchOpts({}),
      headers: authedHeaders({}),
    });
    if (!res.ok) return null;
    return (await json<{ price: ChallengePrice | null }>(res)).price;
  } catch {
    return null;
  }
}

/** ADR 0451 P2b — the CALLER's referral code for a paid challenge, to append as
 *  `?ref=` on their invite link so a referred purchase accrues them commission.
 *  Null for a free challenge (nothing to refer) or any failure — the invite link
 *  still works, just without referral attribution. */
export async function getReferralCode(challengeId: string, version: number): Promise<string | null> {
  try {
    const res = await fetch(`${B()}/entitlements/challenges/${encodeURIComponent(challengeId)}/${version}/referral-code`, {
      ...fetchOpts({}),
      headers: authedHeaders({}),
    });
    if (!res.ok) return null;
    return (await json<{ code: string | null }>(res)).code;
  } catch {
    return null;
  }
}

export async function listEnrollments(): Promise<Enrollment[]> {
  const res = await fetch(`${B()}/enrollments`, { ...fetchOpts({}), headers: authedHeaders({}) });
  return (await json<{ enrollments: Enrollment[] }>(res)).enrollments;
}

/** KTX-3 — one request for the whole Progress screen (no per-enrollment fan-out). */
export async function listEnrollmentsWithProgress(): Promise<{
  enrollments: Enrollment[];
  progress: Record<string, ProgressView>;
}> {
  const res = await fetch(`${B()}/enrollments?include=progress`, { ...fetchOpts({}), headers: authedHeaders({}) });
  const body = await json<{ enrollments: Enrollment[]; progress?: Record<string, ProgressView> }>(res);
  return { enrollments: body.enrollments, progress: body.progress ?? {} };
}

export async function enroll(
  challengeId: string,
  challengeVersion: number,
  timezone: string,
  /** ADR 0443 R2 — enroll-time-only allowed weekdays (0=Sun..6=Sat); omit = every day. */
  daysOfWeek?: number[],
  /** ADR 0444 I1 — attribution-only invite token (invalid ones are ignored). */
  inviteToken?: string,
): Promise<Enrollment> {
  const res = await fetch(`${B()}/enrollments`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      challengeId, challengeVersion, timezone,
      ...(daysOfWeek?.length ? { daysOfWeek } : {}),
      ...(inviteToken ? { inviteToken } : {}),
    }),
  });
  return json<Enrollment>(res);
}

/** ADR 0444 I1 — mint (or re-mint) the caller's invite-link token for a
 *  published challenge. Attribution-only: the link grants nothing. */
export async function mintInvite(challengeId: string): Promise<string> {
  const res = await fetch(`${B()}/invites`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ challengeId }),
  });
  return (await json<{ token: string }>(res)).token;
}

export async function getToday(): Promise<TodayView> {
  const res = await fetch(`${B()}/today`, { ...fetchOpts({}), headers: authedHeaders({}) });
  return json<TodayView>(res);
}

/** Evidence carried on a check-in (KTFULL-B6, enforced server-side per the
 *  occurrence's `evidencePolicy`): `note` satisfies note+photo policies (a photo
 *  rides the note field as a reference until a media binding exists), `measuredValue`
 *  satisfies `measurement`; `attestation` needs neither. */
export interface CheckInEvidence { note?: string; measuredValue?: number }

export async function checkIn(cardId: string, evidence?: CheckInEvidence): Promise<void> {
  const res = await fetch(`${B()}/check-ins`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      cardId,
      ...(evidence?.note && evidence.note.trim() ? { note: evidence.note } : {}),
      ...(typeof evidence?.measuredValue === 'number' ? { measuredValue: evidence.measuredValue } : {}),
    }),
  });
  await json(res);
}

export async function getProgress(enrollmentId: string): Promise<ProgressView> {
  const res = await fetch(`${B()}/enrollments/${encodeURIComponent(enrollmentId)}/progress`, {
    ...fetchOpts({}),
    headers: authedHeaders({}),
  });
  return json<ProgressView>(res);
}

export async function evaluateEnrollment(enrollmentId: string): Promise<{ satisfied: boolean; enrollment: Enrollment }> {
  const res = await fetch(`${B()}/enrollments/${encodeURIComponent(enrollmentId)}/evaluate`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
  });
  return json<{ satisfied: boolean; enrollment: Enrollment }>(res);
}

/** ADR 0443 R1 — set (or clear with null) the opt-in reminder daypart. */
export async function setSchedulePreference(
  enrollmentId: string,
  daypart: 'morning' | 'afternoon' | 'evening' | null,
): Promise<Enrollment> {
  const res = await fetch(`${B()}/enrollments/${encodeURIComponent(enrollmentId)}/schedule`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ daypart }),
  });
  if (!res.ok) throw new Error(`schedule failed: ${res.status}`);
  return (await res.json()) as Enrollment;
}

export async function setSnooze(enrollmentId: string, snoozed: boolean): Promise<Enrollment> {
  const res = await fetch(`${B()}/enrollments/${encodeURIComponent(enrollmentId)}/${snoozed ? 'snooze' : 'resume'}`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
  });
  return json<Enrollment>(res);
}

/** ADR 0443 R3 — one dated Plan item. `completed` is real-check-in truth for
 *  past/today; future rows are the DERIVED plan, never asserted as fact. */
export interface PlanItem {
  enrollmentId: string;
  challengeId: string;
  dateLocal: string;
  day: number;
  stableActivityId: string;
  title: string;
  completed: boolean;
}

/** ADR 0496 D2 — one previewed revision change (the §5.5 compare row). */
export interface PlanChange {
  lane: string;
  line: string;
  day?: number;
  fromDate?: string;
  toDate?: string;
}

/** A typed revision refusal — the server's message verbatim + failing index. */
export class RevisionRefusedError extends Error {
  constructor(message: string, public readonly failedIndex?: number) {
    super(message);
    this.name = 'RevisionRefusedError';
  }
}

async function revisionPost<T>(enrollmentId: string, path: string, commands: unknown[]): Promise<T> {
  const res = await fetch(`${B()}/enrollments/${encodeURIComponent(enrollmentId)}/${path}`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ commands }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; details?: { failedIndex?: number } };
    throw new RevisionRefusedError(body.message ?? body.error ?? `revision request failed: ${res.status}`, body.details?.failedIndex);
  }
  return (await res.json()) as T;
}

/** ADR 0496 D2 — the PURE dry-run preview: same validator + guards as apply,
 *  zero writes. Throws `RevisionRefusedError` with the server's verbatim
 *  refusal (preview refuses exactly what apply would). */
export async function previewRevision(enrollmentId: string, commands: unknown[]): Promise<PlanChange[]> {
  return (await revisionPost<{ changes: PlanChange[] }>(enrollmentId, 'revision-preview', commands)).changes;
}

/** ADR 0496 D2 — apply a closed-world revision command list (incl. the D1 move). */
export async function applyRevision(enrollmentId: string, commands: unknown[]): Promise<void> {
  await revisionPost(enrollmentId, 'revision-commands', commands);
}

/** ADR 0443 R3 — the cross-challenge plan for a bounded window (≤31 days). */
export async function getPlan(from: string, to: string): Promise<PlanItem[]> {
  const res = await fetch(`${B()}/plan?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
    ...fetchOpts({}),
    headers: authedHeaders({}),
  });
  return (await json<{ items: PlanItem[] }>(res)).items;
}

/** ADR 0443 R5 — one journal entry: an evidence-bearing check-in of the caller's own. */
export interface JournalEntry {
  cardId: string;
  enrollmentId: string;
  challengeId: string;
  note?: string;
  measuredValue?: number;
  createdAt: string;
}

/** ADR 0443 R5 — the caller's own journal, newest first (self-data only). */
export async function getJournal(): Promise<JournalEntry[]> {
  const res = await fetch(`${B()}/journal`, { ...fetchOpts({}), headers: authedHeaders({}) });
  return (await json<{ entries: JournalEntry[] }>(res)).entries;
}

/** ADR 0429 P1 — swap today's action for a PUBLISHER-DECLARED alternative. */
export async function substituteAction(cardId: string, alternativeId: string): Promise<void> {
  const res = await fetch(`${B()}/today/substitute`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ cardId, alternativeId }),
  });
  if (!res.ok) throw new Error(`substitute failed: ${res.status}`);
}

/** ADR 0429 P2 — accept the collapsed recovery action after an `ask` prompt. */
export async function acceptRecovery(enrollmentId: string): Promise<boolean> {
  const res = await fetch(`${B()}/today/recover`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ enrollmentId }),
  });
  if (!res.ok) throw new Error(`recover failed: ${res.status}`);
  return (await json<{ occurrence: unknown | null }>(res)).occurrence !== null;
}

// ── ADR 0692 — "what next", KickTodo-local ────────────────────────────────────

export type RecommendationReason = 'starter' | 'next-depth' | 'same-depth' | 'more';
export interface ChallengeRecommendation {
  id: string;
  version: number;
  title: string;
  depthLevel?: 'beginner' | 'intermediate' | 'advanced';
  reason: RecommendationReason;
}

/** The signed-in participant's "what next" (self-data only). Swallow-and-degrade
 *  like the price read: a failed read renders NO section, never an error over
 *  the catalog the participant came for. */
export async function recommendedChallenges(): Promise<ChallengeRecommendation[]> {
  try {
    const res = await fetch(`${B()}/challenges/recommended`, { ...fetchOpts({}), headers: authedHeaders({}) });
    if (!res.ok) return [];
    return ((await res.json()) as { recommendations: ChallengeRecommendation[] }).recommendations;
  } catch {
    return [];
  }
}
