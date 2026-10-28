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
import type { MarketingChannel } from '../consent/consentService.js';
import { checkChannelEligibility, type EligibilityChannel } from '../crm/channelEligibility.js';
import { resolveSegmentMembers } from '../crm/segmentsService.js';
import { listContactEngagement } from '../email/engagementService.js';
import { contactSendCount } from '../email/emailService.js';
import { getClient, listClients } from '../campaign-ops/clientService.js';
import { isWorkspaceRootPair } from '../../host/accessControlService.js';

export interface JourneyEnrollment {
  /** The fork-stable row key. Ungrouped: `${tenantId}::${journeyId}::${contactId}`.
   *  Exclusivity-group (ADR 0299): `${tenantId}::@grp::${group}::${contactId}` —
   *  ONE row per (group, contact) whose `journeyId` is the current group winner. */
  key: string;
  tenantId: string;
  /** ADR 0955 D1 (J9) — the client org this enrollment is for. Absent on rows written
   *  before it (and on every row of a workspace with no clients), which read as `''`. */
  orgId?: string;
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
  /** ADR 0955 D1 (J9) — the client org. `''`/absent ⇒ the workspace itself, allowed only
   *  while the workspace has no client (`resolveEnrollmentOrg`). */
  orgId?: string;
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
/** ADR 0955 D1 (J9) — a client enrollment. The `@org` segment keeps it out of the legacy
 *  3-segment space, the same way ADR 0299's `@grp` does. */
const orgKeyOf = (tenantId: string, orgId: string, journeyId: string, contactId: string): string => `${tenantId}::@org::${orgId}::${journeyId}::${contactId}`;

// ADR 0299: the exclusivity-slot key. A distinct 4-segment `@grp` shape so it can
// never collide with a 3-segment ungrouped `${tenantId}::${journeyId}::${contactId}`
// key — even a journey literally named `@grp`.
const groupKeyOf = (tenantId: string, group: string, contactId: string): string => `${tenantId}::@grp::${group}::${contactId}`;
/** ADR 0955 D1 — a client's exclusivity slot. */
const orgGroupKeyOf = (tenantId: string, orgId: string, group: string, contactId: string): string => `${tenantId}::@org::${orgId}::@grp::${group}::${contactId}`;

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
  const orgId = await resolveEnrollmentOrg(tenantId, opts?.orgId);
  const group = opts?.exclusivityGroup ? cleanString(opts.exclusivityGroup, 160) : '';
  if (group) return enrollArbitrated(tenantId, j, c, group, priorityOf(opts?.priority), runId, orgId);
  // ── ADR 0222 non-exclusive path (unchanged, backward-compatible) ──
  const key = orgId ? orgKeyOf(tenantId, orgId, j, c) : keyOf(tenantId, j, c);
  const existing = await enrollments.get(key).catch(() => undefined);
  if (existing && existing.tenantId === tenantId) return { enrolled: false, enrolledAt: existing.enrolledAt };
  if (orgId) {
    // ADR 0955 (architect C2) — a contact enrolled BEFORE its workspace had clients holds a
    // legacy row. Re-enrolling it under the client key would send the journey twice.
    const legacy = await enrollments.get(keyOf(tenantId, j, c)).catch(() => undefined);
    if (legacy && legacy.tenantId === tenantId) return { enrolled: false, enrolledAt: legacy.enrolledAt };
  }
  // ATOMIC insert-if-absent (grade-code AUDIT-2): a plain get→put races —
  // two concurrent enrolls of the same (journey, contact) from event
  // redelivery or a manual re-fire would BOTH read absent and BOTH return
  // enrolled:true, producing the double-send this guard exists to prevent.
  // compareAndSwap(null, …) is correct across instances (hostExtPersistence A7).
  const row: JourneyEnrollment = { key, tenantId, ...(orgId ? { orgId } : {}), journeyId: j, contactId: c, ...(runId ? { runId } : {}), enrolledAt: new Date().toISOString() };
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
async function enrollArbitrated(tenantId: string, journeyId: string, contactId: string, group: string, priority: number, runId: string | undefined, orgId: string): Promise<EnrollResult> {
  const key = orgId ? orgGroupKeyOf(tenantId, orgId, group, contactId) : groupKeyOf(tenantId, group, contactId);
  // ADR 0955 (architect C2) — a pre-client legacy slot for this (group, contact) is the incumbent.
  const legacy = orgId ? await enrollments.get(groupKeyOf(tenantId, group, contactId)).catch(() => undefined) : undefined;
  for (let attempt = 0; attempt < MAX_ARB_ATTEMPTS; attempt++) {
    const read = (await enrollments.get(key).catch(() => undefined)) ?? null;
    const current = read ?? (legacy && legacy.tenantId === tenantId ? legacy : null);
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
      key, tenantId, ...(orgId ? { orgId } : {}), journeyId, contactId,
      ...(runId ? { runId } : {}),
      enrolledAt: new Date().toISOString(),
      priority, exclusivityGroup: group,
    };
    // `expected` is the exact row we read at THIS key (or null). A concurrent enroll that
    // won the slot since our read loses the byte-match → won:false → we retry. (A legacy
    // incumbent lives at another key; outranking it writes the client slot.)
    const won = await enrollments.compareAndSwap(read, row);
    if (won) return { enrolled: true, ...(displaced ? { displacedJourneyId: displaced } : {}) };
  }
  throw new OpenwopError('conflict', 'enrollment arbitration exceeded its retry budget under contention.', 409, { journeyId, contactId, exclusivityGroup: group });
}

/** ADR 0299 — the journey that currently holds an exclusivity group for a
 *  contact (the highest-priority active enrollment), or null. */
export async function activeInGroup(tenantId: string, exclusivityGroup: string, contactId: string, orgId = ''): Promise<JourneyEnrollment | null> {
  const g = cleanString(exclusivityGroup, 160);
  const c = cleanString(contactId, 160);
  if (!g || !c) return null;
  const row = await enrollments.get(orgId ? orgGroupKeyOf(tenantId, orgId, g, c) : groupKeyOf(tenantId, g, c)).catch(() => undefined);
  if (row && row.tenantId === tenantId) return row;
  if (!orgId) return null;
  const legacy = await enrollments.get(groupKeyOf(tenantId, g, c)).catch(() => undefined);
  return legacy && legacy.tenantId === tenantId ? legacy : null;
}

/** Explicit re-enrollment (operator intent — never implicit). `orgId` names the client
 *  (ADR 0955 D1); `''` resets a workspace-level (legacy) row. */
export async function resetEnrollment(tenantId: string, journeyId: string, contactId: string, orgId = ''): Promise<boolean> {
  const row = await enrollments.get(orgId ? orgKeyOf(tenantId, orgId, journeyId, contactId) : keyOf(tenantId, journeyId, contactId)).catch(() => undefined);
  if (!row || row.tenantId !== tenantId || (row.orgId ?? '') !== orgId) return false;
  return enrollments.delete(row.key);
}

/** The tenant's enrollments, newest first. `orgId` (ADR 0955 D1) narrows to one client's
 *  rows; `''` to the workspace-level (legacy) rows; `undefined` returns all of them. */
export async function listEnrollments(tenantId: string, journeyId?: string, orgId?: string): Promise<JourneyEnrollment[]> {
  const all = await enrollments.listByPrefix(orgId ? `${tenantId}::@org::${orgId}::` : `${tenantId}::`);
  return all
    .filter((e) => e.tenantId === tenantId && (!journeyId || e.journeyId === journeyId) && (orgId === undefined || (e.orgId ?? '') === orgId))
    .sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt));
}

/**
 * ADR 0955 D1 (J9) — the client an enrollment is for, or `''` for the workspace itself.
 *
 * - A client of this workspace (a `ClientAccount`) ⇒ that client.
 * - The workspace root org (the agency's own house account, ADR 0921 D1) ⇒ `''`.
 * - A workspace with NO client ⇒ `''` whatever org is named. Before ADR 0955, chains passed
 *   `orgId` to say where follow-up work lands (`re-engage-contact`), not whose client this
 *   is; those workspaces keep the exact ADR 0222 keys.
 * - Otherwise: an org that is not a client is 404, and naming none is `client_required`
 *   (once an agency has clients, every journey act names one).
 */
export async function resolveEnrollmentOrg(tenantId: string, orgId: string | undefined): Promise<string> {
  const o = cleanString(orgId, 160);
  if (o && (await getClient(tenantId, o))) return o;
  if (o && isWorkspaceRootPair(o, tenantId)) return '';
  if ((await listClients(tenantId)).length === 0) return '';
  if (o) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId: o });
  throw new OpenwopError('validation_error', 'This workspace has clients: name the client (`orgId`) the journey is for.', 400, { field: 'orgId', reason: 'client_required' });
}

/**
 * The legacy (ADR 0222) eligibility shape: email only, the workspace's own sender. Kept for
 * the shipped `eligibility`/`enroll` nodes; it is now a view of the ONE check
 * (`crm/channelEligibility.ts`, ADR 0955 D2), so it cannot drift from what SMS and the
 * client-scoped verb enforce. `suppression_unreadable` stays its own reason (fold-in B5).
 */
export type IneligibleReason = 'contact_not_found' | 'no_email' | 'consent' | 'suppressed' | 'suppression_unreadable'
  /** ADR 0657 D5 — the consent store could not be READ: the recipient is skipped with its own reason, never included and never aborting the batch. */
  | 'consent_unreadable';

/** The composite gate every legacy journey send step passes first. Returns the contact's
 *  email on success so send steps never re-resolve it. `channel` is the CONSENT ask
 *  (ADR 0227); the address and suppression are email's, as they always were here. */
export async function checkEligibility(tenantId: string, contactId: string, channel: MarketingChannel = 'email'): Promise<
  { eligible: true; email: string; name: string } | { eligible: false; reason: IneligibleReason }
> {
  const r = await checkChannelEligibility(tenantId, '', contactId, 'email', channel === 'email' ? {} : { legacyConsentChannel: channel });
  if (!r.eligible) {
    const reason: IneligibleReason = r.reason === 'no_address' ? 'no_email'
      : r.reason === 'contact_not_found' || r.reason === 'consent' || r.reason === 'consent_unreadable' || r.reason === 'suppressed' || r.reason === 'suppression_unreadable' ? r.reason
        : 'consent'; // unreachable today (no topic, no send policy on this path); never a silent pass
    return { eligible: false, reason };
  }
  return { eligible: true, email: r.address, name: r.name };
}

/** ADR 0955 D2 — the journey's view of the ONE check: client-scoped, any channel. */
export async function checkJourneyChannelEligibility(
  tenantId: string,
  orgId: string,
  contactId: string,
  channel: EligibilityChannel,
  opts: { purpose?: 'marketing' | 'transactional'; topicId?: string } = {},
) {
  const o = await resolveEnrollmentOrg(tenantId, orgId);
  // The SENDER scope is the resolved client (`''` = the workspace); the TOPIC belongs to the
  // org the chain named, which is still meaningful when the workspace has no clients.
  return checkChannelEligibility(tenantId, o, contactId, channel, { ...opts, ...(orgId ? { topicOrgId: orgId } : {}) });
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
  // ADR 0955 P0 (J8) — one prefix read on the per-contact index, never the tenant scan.
  const rows = await listContactEngagement(tenantId, contactId, campaignId ? { campaignId } : {});
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
