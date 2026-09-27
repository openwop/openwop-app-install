/**
 * Profiles lifecycle side-channel (ADR 0624 D3 / ADR 0208 §1) — four ids-only
 * host events, each emitted from the WRITER that made the transition (never
 * from inside `casMutateProfile`, which can throw `not_found` from its loop, and
 * never from a `finally`), the `features/users/emit.ts` shape: sync `void`
 * verbs wrapping `void emitHostEvent(...)`, never throwing on the caller's path.
 *
 *   host.profiles.endorsement.given / .removed
 *       `setEndorsement` on the CAS-WON transition only (the `'unchanged'`
 *       idempotent re-endorse never emits); it does NOT also emit `updated`.
 *   host.profiles.profile.updated
 *       `updateOwnProfile`, `setOwnSkills`, `setOwnWorkflows`, and the four media
 *       writers (`setAvatarToken`, `clearAvatar`, `addPortfolioToken`,
 *       `removePortfolioToken`) — the two PROMOTING writers emit only AFTER
 *       `promoteToDurable` succeeds; the unwind CAS on a dead asset is silent, so
 *       a dead-asset promotion produces ZERO events. `fields` = the top-level
 *       keys whose JSON differs between `before` (the WINNING CAS attempt's
 *       `current`, linearised so two concurrent writers cannot double-emit) and
 *       the landed row, excluding `updatedAt`/`updatedBy`; emitted iff
 *       non-empty (an identical PATCH emits nothing). Names, never values.
 *   host.profiles.completeness.crossed
 *       the same writers, from `computeCompleteness(before)` vs `(landed)`;
 *       crossed T ⇔ `before < T ≤ after` (up) or `after < T ≤ before` (down),
 *       T ∈ COMPLETENESS_THRESHOLDS — ONE event per write carrying EVERY
 *       threshold crossed (`thresholds[]`), with `direction`.
 *
 * DELIBERATELY SILENT (by call graph): `setAgentPinned` + `unpinAgentsForTenant`
 * (ADR 0023 UI preference + roster cascade), `setProfileKnowledge` (ADR 0042 —
 * no `knowledge.bound`), `backfillProfileMediaDurability` (migration), the two
 * unwind lambdas, `getOrCreateProfile` (lazy materialisation on a READ),
 * `deleteSubjectProfile` (the users `erased` event already names the person),
 * the retention purger, and the demo seed (`{ silent: true }` on
 * `updateOwnProfile` / `setOwnSkills` — the seed walks 0→35→50 per person).
 *
 * PAYLOAD DISCIPLINE — the emitter's rule: opaque `userId`s, the `tenantId`,
 * field NAMES, threshold numbers, and (endorsements) the skill NAME — which is
 * self-authored, team-visible, capped free text, stated. Never a bio, a
 * location, a display name or an email. `test/profiles-lifecycle-host-events.
 * test.ts` pins the literal key set per event.
 *
 * No `origin`: profiles has no surface WRITE verb, so no run can cause an emit
 * and no self-trigger exists. Emits fire inside the service, BEFORE the route's
 * `void indexProfile` continuation — a bound chain must read the store
 * (`feature.profiles.nodes.get`), never the Team Portfolio KB mirror.
 */
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import type { Profile } from './profilesService.js';
import { computeCompleteness } from './completeness.js';

export const ENDORSEMENT_GIVEN_EVENT = 'host.profiles.endorsement.given';
export const ENDORSEMENT_REMOVED_EVENT = 'host.profiles.endorsement.removed';
export const PROFILE_UPDATED_EVENT = 'host.profiles.profile.updated';
export const COMPLETENESS_CROSSED_EVENT = 'host.profiles.completeness.crossed';

/** The ONLY completeness band table (the SPA has none). */
const COMPLETENESS_THRESHOLDS: readonly number[] = [25, 50, 75, 100];

/** Bookkeeping columns every write touches — never a "field" a chain cares about. */
const DIFF_EXCLUDED = new Set<string>(['updatedAt', 'updatedBy']);

/** Top-level keys whose JSON differs between the two rows (sorted, stable). */
export function changedFields(before: Profile, landed: Profile): string[] {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(landed)]);
  const out: string[] = [];
  for (const k of keys) {
    if (DIFF_EXCLUDED.has(k)) continue;
    const a = (before as unknown as Record<string, unknown>)[k];
    const b = (landed as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push(k);
  }
  return out.sort();
}

/** Every threshold crossed by `from → to`, in band order, with the direction. */
export function crossedThresholds(from: number, to: number): { thresholds: number[]; direction: 'up' | 'down' } | null {
  if (from === to) return null;
  const up = to > from;
  const thresholds = COMPLETENESS_THRESHOLDS.filter((t) => (up ? from < t && t <= to : to < t && t <= from));
  return thresholds.length > 0 ? { thresholds, direction: up ? 'up' : 'down' } : null;
}

export function endorsementGiven(input: { tenantId: string; userId: string; endorserUserId: string; skill: string }): void {
  void emitHostEvent({
    type: ENDORSEMENT_GIVEN_EVENT,
    tenantId: input.tenantId,
    payload: { tenantId: input.tenantId, userId: input.userId, endorserUserId: input.endorserUserId, skill: input.skill },
  });
}

export function endorsementRemoved(input: { tenantId: string; userId: string; endorserUserId: string; skill: string }): void {
  void emitHostEvent({
    type: ENDORSEMENT_REMOVED_EVENT,
    tenantId: input.tenantId,
    payload: { tenantId: input.tenantId, userId: input.userId, endorserUserId: input.endorserUserId, skill: input.skill },
  });
}

function profileUpdated(input: { tenantId: string; userId: string; fields: string[] }): void {
  void emitHostEvent({
    type: PROFILE_UPDATED_EVENT,
    tenantId: input.tenantId,
    payload: { tenantId: input.tenantId, userId: input.userId, fields: input.fields },
  });
}

function completenessCrossed(input: { tenantId: string; userId: string; from: number; to: number; direction: 'up' | 'down'; thresholds: number[] }): void {
  void emitHostEvent({
    type: COMPLETENESS_CROSSED_EVENT,
    tenantId: input.tenantId,
    payload: { tenantId: input.tenantId, userId: input.userId, from: input.from, to: input.to, direction: input.direction, thresholds: input.thresholds },
  });
}

/**
 * The ONE post-write emit for an owner edit: `updated` iff a non-bookkeeping
 * field differs, then `crossed` iff the completeness band moved. Called by a
 * writer AFTER its own success (after `promoteToDurable` for the promoting
 * writers). `before` is the winning CAS attempt's `current`.
 */
export function emitProfileWrite(tenantId: string, userId: string, before: Profile, landed: Profile): void {
  const fields = changedFields(before, landed);
  if (fields.length === 0) return;
  profileUpdated({ tenantId, userId, fields });
  const from = computeCompleteness(before);
  const to = computeCompleteness(landed);
  const crossed = crossedThresholds(from, to);
  if (crossed) completenessCrossed({ tenantId, userId, from, to, direction: crossed.direction, thresholds: crossed.thresholds });
}
