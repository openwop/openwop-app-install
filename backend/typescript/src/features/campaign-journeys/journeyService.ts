/**
 * Campaign journeys (ADR 0222 / campaign gap plan §5C C6) — the two primitives
 * that make contact-level lifecycle chains safe on the ONE engine. NOT a
 * journey engine: journeys ARE workflow chains (RFC 0013) triggered by host
 * events (ADR 0208 bindings); this service owns only what chains can't express:
 *
 *   - **Enrollment idempotency:** one run per (journey, contact) — the
 *     `journey:<id>:contact:<id>` key from the gap plan. A re-fired trigger
 *     (event redelivery, manual re-run) hits the guard and stops instead of
 *     double-sending. Enrollment state IS the ledger (re-enrollment is an
 *     explicit `reset`, never implicit).
 *   - **Eligibility:** the consent + suppression + has-email composite every
 *     send step must pass — the same gates the campaign email send enforces
 *     (ADR 0020/0217), composed once here so chains can't forget one.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';
// Cross-feature READS (the documented precedent — through the owning services).
import { getContact } from '../crm/contactsService.js';
import { isAllowed, type MarketingChannel } from '../consent/consentService.js';
import { suppressionBlocksSend } from '../crm/suppressionService.js';
import { resolveSegmentMembers } from '../crm/segmentsService.js';
import { listEngagement } from '../email/engagementService.js';
import { contactSendCount } from '../email/emailService.js';

export interface JourneyEnrollment {
  /** The fork-stable row key. Ungrouped: `${tenantId}::${journeyId}::${contactId}`.
   *  Exclusivity-group (ADR 0299): `${tenantId}::@grp::${group}::${contactId}` —
   *  ONE row per (group, contact) whose `journeyId` is the current group winner. */
  key: string;
  tenantId: string;
  /** For a grouped row this is the CURRENTLY-WINNING journey in the group. */
  journeyId: string;
  contactId: string;
  runId?: string;
  enrolledAt: string;
  /** ADR 0299: arbitration inputs, persisted so a concurrent challenger can
   *  compare against the incumbent INSIDE the CAS retry (higher priority wins). */
  priority?: number;
  exclusivityGroup?: string;
}

/** ADR 0299 — options carried alongside the (journey, contact) enroll. Absent /
 *  no `exclusivityGroup` ⇒ the exact ADR 0222 behavior (backward-compatible). */
export interface EnrollOptions {
  /** Integer; higher wins arbitration within an exclusivity group. Default 0. */
  priority?: number;
  /** A contact holds at most ONE active journey per group — the highest-priority. */
  exclusivityGroup?: string;
}

export interface EnrollResult {
  enrolled: boolean;
  enrolledAt?: string;
  /** Why `enrolled:false` in an exclusivity group: `already_enrolled` (idempotent
   *  re-fire of the incumbent) or `superseded` (a higher-priority journey holds
   *  the group — this challenger is skipped). Absent on the ungrouped path. */
  reason?: 'already_enrolled' | 'superseded';
  /** Set when this enroll WON the group and displaced a lower-priority incumbent. */
  displacedJourneyId?: string;
}

const enrollments = new DurableCollection<JourneyEnrollment>('campaign-journeys:enrollment', (e) => e.key);

const keyOf = (tenantId: string, journeyId: string, contactId: string): string => `${tenantId}::${journeyId}::${contactId}`;

// ADR 0299: the exclusivity-slot key. A distinct 4-segment `@grp` shape so it can
// never collide with a 3-segment ungrouped `${tenantId}::${journeyId}::${contactId}`
// key — even a journey literally named `@grp`.
const groupKeyOf = (tenantId: string, group: string, contactId: string): string => `${tenantId}::@grp::${group}::${contactId}`;

const priorityOf = (p: number | undefined): number => (typeof p === 'number' && Number.isFinite(p) ? Math.trunc(p) : 0);

/** Deterministic arbitration (ADR 0299): does challenger `(aId,aPrio)` outrank
 *  incumbent `(bId,bPrio)` for the group slot? Higher priority wins; on a tie the
 *  lexicographically-smaller journeyId wins — a total order independent of arrival
 *  order, so replay/fork picks the SAME winner every time. */
const outranks = (aId: string, aPrio: number, bId: string, bPrio: number): boolean =>
  aPrio !== bPrio ? aPrio > bPrio : aId < bId;

const MAX_ARB_ATTEMPTS = 8;

/** Idempotent enrollment guard (ADR 0222) + cross-journey priority arbitration
 *  (ADR 0299). `enrolled:false` ⇒ the chain must stop, not re-send.
 *
 *  With no `exclusivityGroup` this is the unchanged ADR 0222 per-(journey,contact)
 *  CAS. With one, the write serializes through a per-(group,contact) CAS on a
 *  single slot row — the SAME `compareAndSwap` chokepoint — so two challengers
 *  racing the same group serialize, and the priority compare happens INSIDE the
 *  CAS retry (TOCTOU-safe; see `enrollArbitrated`). */
export async function enroll(tenantId: string, journeyId: string, contactId: string, runId?: string, opts?: EnrollOptions): Promise<EnrollResult> {
  const j = cleanString(journeyId, 160);
  const c = cleanString(contactId, 160);
  if (!j || !c) throw new OpenwopError('validation_error', 'journeyId and contactId are required.', 400, {});
  const group = opts?.exclusivityGroup ? cleanString(opts.exclusivityGroup, 160) : '';
  if (group) return enrollArbitrated(tenantId, j, c, group, priorityOf(opts?.priority), runId);
  // ── ADR 0222 non-exclusive path (unchanged, backward-compatible) ──
  const key = keyOf(tenantId, j, c);
  const existing = await enrollments.get(key).catch(() => undefined);
  if (existing && existing.tenantId === tenantId) return { enrolled: false, enrolledAt: existing.enrolledAt };
  // ATOMIC insert-if-absent (grade-code AUDIT-2): a plain get→put races —
  // two concurrent enrolls of the same (journey, contact) from event
  // redelivery or a manual re-fire would BOTH read absent and BOTH return
  // enrolled:true, producing the double-send this guard exists to prevent.
  // compareAndSwap(null, …) is correct across instances (hostExtPersistence A7).
  const row: JourneyEnrollment = { key, tenantId, journeyId: j, contactId: c, ...(runId ? { runId } : {}), enrolledAt: new Date().toISOString() };
  const won = await enrollments.compareAndSwap(null, row);
  if (!won) {
    const now = await enrollments.get(key).catch(() => undefined);
    return { enrolled: false, ...(now?.enrolledAt ? { enrolledAt: now.enrolledAt } : {}) };
  }
  return { enrolled: true };
}

/**
 * ADR 0299 — cross-journey arbitration AT the enrollment CAS. A single slot row
 * per (tenant, group, contact) is the ledger of who holds the group; the write
 * that changes it is the SAME `enrollments.compareAndSwap` used by the ADR 0222
 * guard — never a separate arbiter that could race it.
 *
 * The CAS is the atomicity guard. On every attempt we read the current slot,
 * arbitrate against it, then CAS with `expected = the exact row we read` (or
 * `null` for the first enroll). If a concurrent enroll moved the slot between our
 * read and our write, the byte-compare fails and we LOOP — re-reading and
 * re-arbitrating against the new incumbent (the TOCTOU re-check). So two
 * challengers for the same group serialize through one CAS: exactly one slot row
 * exists, and its journeyId is deterministically the highest-priority challenger,
 * regardless of arrival order (no double-enroll).
 */
async function enrollArbitrated(tenantId: string, journeyId: string, contactId: string, group: string, priority: number, runId?: string): Promise<EnrollResult> {
  const key = groupKeyOf(tenantId, group, contactId);
  for (let attempt = 0; attempt < MAX_ARB_ATTEMPTS; attempt++) {
    const current = (await enrollments.get(key).catch(() => undefined)) ?? null;
    if (current && current.tenantId === tenantId) {
      // Same journey already holds the slot → idempotent re-fire; stop the chain.
      if (current.journeyId === journeyId) return { enrolled: false, enrolledAt: current.enrolledAt, reason: 'already_enrolled' };
      // Incumbent outranks (or ties above) the challenger → challenger is skipped.
      if (!outranks(journeyId, priority, current.journeyId, priorityOf(current.priority))) {
        return { enrolled: false, reason: 'superseded' };
      }
      // else: challenger outranks the incumbent → take over the slot via CAS below.
    }
    const displaced = current && current.tenantId === tenantId && current.journeyId !== journeyId ? current.journeyId : undefined;
    const row: JourneyEnrollment = {
      key, tenantId, journeyId, contactId,
      ...(runId ? { runId } : {}),
      enrolledAt: new Date().toISOString(),
      priority, exclusivityGroup: group,
    };
    // `expected` is the exact row we read (or null). A concurrent enroll that
    // won the slot since our read loses the byte-match → won:false → we retry.
    const won = await enrollments.compareAndSwap(current, row);
    if (won) return { enrolled: true, ...(displaced ? { displacedJourneyId: displaced } : {}) };
  }
  throw new OpenwopError('conflict', 'enrollment arbitration exceeded its retry budget under contention.', 409, { journeyId, contactId, exclusivityGroup: group });
}

/** ADR 0299 — the journey that currently holds an exclusivity group for a
 *  contact (the highest-priority active enrollment), or null. */
export async function activeInGroup(tenantId: string, exclusivityGroup: string, contactId: string): Promise<JourneyEnrollment | null> {
  const g = cleanString(exclusivityGroup, 160);
  const c = cleanString(contactId, 160);
  if (!g || !c) return null;
  const row = await enrollments.get(groupKeyOf(tenantId, g, c)).catch(() => undefined);
  return row && row.tenantId === tenantId ? row : null;
}

/** Explicit re-enrollment (operator intent — never implicit). */
export async function resetEnrollment(tenantId: string, journeyId: string, contactId: string): Promise<boolean> {
  const row = await enrollments.get(keyOf(tenantId, journeyId, contactId)).catch(() => undefined);
  if (!row || row.tenantId !== tenantId) return false;
  return enrollments.delete(row.key);
}

export async function listEnrollments(tenantId: string, journeyId?: string): Promise<JourneyEnrollment[]> {
  const all = await enrollments.listByPrefix(`${tenantId}::`);
  return all.filter((e) => e.tenantId === tenantId && (!journeyId || e.journeyId === journeyId)).sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt));
}

/**
 * `suppression_unreadable` (fold-in B5) is deliberately its own reason and NOT
 * folded into `suppressed`. They are different facts — "this person asked us to
 * stop" versus "we could not check" — and only the first is a decision about the
 * recipient. A journey step that reports the second as the first attributes an
 * outage to a human's consent choice, in whatever the caller does with the reason.
 */
export type IneligibleReason = 'contact_not_found' | 'no_email' | 'consent' | 'suppressed' | 'suppression_unreadable'
  /** ADR 0657 D5 — the consent store could not be READ: the recipient is skipped with its own reason, never included and never aborting the batch. */
  | 'consent_unreadable';

/** The composite gate every journey send step passes first. Returns the
 *  contact's email on success so send steps never re-resolve it.
 *
 *  `channel` (ADR 0227): the consent ask is per-channel — `marketing.<channel>`
 *  (specific governs when recorded, else the `marketing` umbrella). Defaults to
 *  `'email'` — today's journey send steps are email sends. The no-email and
 *  suppression gates stay channel-independent for now: email is the contact
 *  handle every shipped send step targets, and the suppression overlay is
 *  address-keyed. */
export async function checkEligibility(tenantId: string, contactId: string, channel: MarketingChannel = 'email'): Promise<
  { eligible: true; email: string; name: string } | { eligible: false; reason: IneligibleReason }
> {
  const contact = await getContact(contactId);
  if (!contact || contact.tenantId !== tenantId) return { eligible: false, reason: 'contact_not_found' };
  if (!contact.email) return { eligible: false, reason: 'no_email' };
  let consented: boolean;
  try { consented = await isAllowed(tenantId, contactId, `marketing.${channel}`); }
  catch { return { eligible: false, reason: 'consent_unreadable' }; } // D5
  if (!consented) return { eligible: false, reason: 'consent' };
  const suppression = await suppressionBlocksSend(tenantId, contact.email);
  if (suppression === 'suppressed') return { eligible: false, reason: 'suppressed' };
  if (suppression === 'unreadable') return { eligible: false, reason: 'suppression_unreadable' };
  return { eligible: true, email: contact.email, name: contact.name };
}

// ── ADR 0243 — journey-depth read verbs (segment fan-out, engagement branching,
//    frequency caps). All are LIVE reads by design: a journey fork/replay
//    re-evaluates against the recipient's CURRENT state (a journey is a live
//    marketing flow, not a deterministic-replay artifact) — the enroll-CAS is the
//    idempotency guard. Results are NEVER stamped into run.metadata as durable.

/** Behavioral branching input: did the contact open/click a campaign's email?
 *  Scoped to one campaign (omit for any-campaign). Feeds an EdgeCondition on the
 *  chain (`{path:'opened', op:'truthy'}`). */
export async function checkEngagement(tenantId: string, contactId: string, campaignId?: string): Promise<{ opened: boolean; clicked: boolean; openCount: number; clickCount: number }> {
  const rows = (await listEngagement(tenantId, campaignId)).filter((e) => e.contactId === contactId);
  const openCount = rows.filter((e) => e.kind === 'opened').length;
  const clickCount = rows.filter((e) => e.kind === 'clicked').length;
  return { opened: openCount > 0, clicked: clickCount > 0, openCount, clickCount };
}

/** Frequency-cap input: the contact's `sent` count across ALL campaigns in the
 *  trailing window; `withinCap` gates the next send via an EdgeCondition. */
export async function checkFrequency(tenantId: string, contactId: string, windowDays: number, maxSends: number): Promise<{ sentCount: number; withinCap: boolean }> {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
  const max = Number.isFinite(maxSends) && maxSends > 0 ? maxSends : 1;
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const sentCount = await contactSendCount(tenantId, contactId, sinceIso);
  return { sentCount, withinCap: sentCount < max };
}

/** Segment fan-out input: the member contactIds a `core.dispatch` node fans out
 *  over (each → a per-member journey child run). CAPPED (never a silent 50k
 *  fan-out) — `truncated` surfaces the drop. */
export async function resolveSegment(tenantId: string, segmentId: string, cap = 5000): Promise<{ contactIds: string[]; total: number; truncated: boolean }> {
  const members = await resolveSegmentMembers(tenantId, segmentId);
  const ids = members.map((c) => c.contactId);
  return { contactIds: ids.slice(0, cap), total: ids.length, truncated: ids.length > cap };
}

/** Test-only. */
export async function __clearEnrollments(): Promise<void> {
  await enrollments.__clear();
}
