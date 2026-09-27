/**
 * Team Profiles → KB auto-indexer (ADR 0172 Phase 4 — the deferred team-portfolio
 * half; ADR 0005 profiles are the source). Mirrors each team member's descriptive
 * capability profile into a managed 'Team Portfolio KB' collection so the
 * Production Planner (and Boards of Advisors) can RETRIEVE team-capability context
 * alongside the Vendor Directory KB. Thin composition over `kbService` — the
 * `productionKnowledgeService` (vendors) precedent — no new store, no vector surface.
 *
 * §Correction to ADR 0172 Phase 4 (2026-07-12): the plan put `profile:<id>` docs
 * ALONGSIDE `vendor:<id>` in the per-ORG `mgd-production-<org>` collection. That is
 * impossible cleanly — Profiles are **tenant-scoped with no org** (ADR 0005), and
 * profile CRUD has no orgId. So team profiles land in a distinct **tenant-level**
 * collection (`mgd-team-<tenant>`) under a reserved sentinel org (`_team`;
 * `createCollection` does not validate org existence). Reuses `managed:'production'`
 * (same consumer — the planner) so no managed-union / board-enumerator change.
 *
 * Invariants (the vendor-KB pattern):
 *  - BEST-EFFORT / FAIL-OPEN: swallows + logs; a KB failure never breaks profile
 *    CRUD; self-heals on the next mutation (upsert keyed by the stable userId).
 *  - GATED on the `production` toggle (the consumer). KB is always-on.
 *  - CONTENT = DESCRIPTIVE CAPABILITY TEXT the member self-authored + team-visible
 *    (ADR 0005: any tenant member may read any profile — indexing leaks nothing).
 *    Excludes contact/location PII (declared PII, zero retrieval value) and the
 *    opaque `portfolioAssetTokens` (portfolio-MEDIA byte extraction rides the
 *    ADR 0108 follow-on, same deferral the vendor path takes).
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 */

import { createLogger } from '../../observability/logger.js';
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { type ShareableKbProvider } from '../../host/shareableKb.js';
import { createCollection, deleteDocument, getCollection, upsertDocument } from '../kb/kbService.js';
import { kbMutated, type KbEmitOptions } from '../kb/emit.js'; // ADR 0643 D3 — silent per-row sweeps + ONE batch event
import { PREAUTHORIZED_CALLER } from '../../host/subjectAccess.js'; // ADR 0643 R4 NIT 2 — the DSAR remover is an eraser lane
import { listProfiles, type Profile } from './profilesService.js';

const log = createLogger('profiles-kb');

const MANAGED = 'production' as const; // same consumer (the planner) as the vendor KB
const COLLECTION_NAME = 'Team Portfolio KB';
/** Reserved sentinel org for the tenant-level collection — no real principal
 *  holds it, and `createCollection` never validates org existence. */
const TEAM_ORG = '_team';
const collectionIdFor = (tenantId: string): string => `mgd-team-${tenantId}`;
const docIdFor = (userId: string): string => `profile:${userId}`;

async function gateOpen(tenantId: string): Promise<boolean> {
  const production = await resolveOne('production', { tenantId });
  return Boolean(production?.enabled);
}

/** The searchable capability description indexed for a team member. Descriptive
 *  fields only — no contact/location PII, no opaque portfolio tokens. */
function profileToText(p: Profile): string {
  const skills = p.skills.map((s) => `${s.name}${s.proficiency ? ` (${s.proficiency})` : ''}`).join('; ');
  const name = p.preferredName || p.jobTitle || p.userId;
  const growth = p.growthInterests?.length ? p.growthInterests : undefined;
  return [
    `Team member: ${name}${p.jobTitle ? ` — ${p.jobTitle}` : ''}${p.department ? `, ${p.department}` : ''}`,
    skills ? `Skills: ${skills}` : '',
    p.equipment.length ? `Equipment: ${p.equipment.join('; ')}` : '',
    p.interests.length ? `Interests: ${p.interests.join('; ')}` : '',
    growth ? `Growth interests: ${growth.join('; ')}` : '',
    p.availability?.status ? `Availability: ${p.availability.status}` : '',
    p.bio ? `Bio: ${p.bio}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Whether a profile carries any indexable capability signal (skip empty shells).
 *  Mirrors EVERY field `profileToText` emits (TPK-3: growthInterests/availability/
 *  department were missing, so a profile with only those was wrongly unindexed). */
function hasSignal(p: Profile): boolean {
  return p.skills.length > 0 || p.equipment.length > 0 || p.interests.length > 0
    || Boolean(p.jobTitle) || Boolean(p.bio) || Boolean(p.department)
    || Boolean(p.growthInterests?.length) || Boolean(p.availability?.status);
}

async function getOrCreateCollection(tenantId: string, actor: string) {
  const id = collectionIdFor(tenantId);
  const existing = await getCollection(tenantId, TEAM_ORG, id);
  if (existing) return existing;
  return createCollection(tenantId, TEAM_ORG, actor, { name: COLLECTION_NAME }, { collectionId: id, managed: MANAGED });
}

/** Index (or re-index) one team member's profile. Best-effort. An empty profile
 *  (no capability signal) is REMOVED rather than indexed as noise. */
export async function indexProfile(tenantId: string, userId: string, profile: Profile, emit: KbEmitOptions = {}): Promise<void> {
  try {
    if (!(await gateOpen(tenantId))) return;
    if (!hasSignal(profile)) { await removeProfile(tenantId, userId); return; }
    await getOrCreateCollection(tenantId, userId);
    await upsertDocument(tenantId, TEAM_ORG, collectionIdFor(tenantId), docIdFor(userId), userId, {
      title: profile.preferredName || profile.jobTitle || userId,
      text: profileToText(profile),
      ...emit, // ADR 0643 D3 — the backfill sweep passes `{ silent: true }`
    });
  } catch (err) {
    log.warn('profiles_kb_index_failed', { tenantId, userId, err: String(err) });
  }
}

/** Remove a member's KB doc — STRICT variant (review F3): a failed delete
 *  THROWS so callers on a compliance/lifecycle lane (admin user-delete, the
 *  DSAR fan-out — which catches + counts per-eraser) can refuse to proceed
 *  instead of silently leaving searchable PII behind. Already-gone (no
 *  collection / no doc — most users are never indexed) is SUCCESS, not failure. */
export async function removeProfileStrict(tenantId: string, userId: string): Promise<void> {
  if (!(await getCollection(tenantId, TEAM_ORG, collectionIdFor(tenantId)))) return;
  try {
    // ADR 0643 D3 (review #5) — `{ silent: true }` UNCONDITIONALLY, a correctness rule:
    // this is the admin user-delete + DSAR fan-out lane and `docIdFor(userId)` IS the
    // subject's key. A `document.deleted { documentId }` here would publish the
    // just-erased person's identifier to every webhook subscriber and bound run.
    // …and `PREAUTHORIZED_CALLER` (R4 NIT 2): an eraser has no membership to resolve; a
    // Team-Portfolio collection is never subject-bound today, but the rule is the lane's.
    await deleteDocument(tenantId, TEAM_ORG, collectionIdFor(tenantId), docIdFor(userId), PREAUTHORIZED_CALLER, { silent: true });
  } catch (err) {
    // `deleteDocument` 404s an absent doc — for a REMOVAL, absent IS the goal.
    if (err instanceof OpenwopError && err.code === 'not_found') return;
    throw err;
  }
}

/** Remove a member's KB doc (on delete/erasure/empty). Best-effort — the
 *  indexing lanes must never break profile CRUD; lifecycle lanes that need the
 *  failure to COUNT use `removeProfileStrict` above. */
export async function removeProfile(tenantId: string, userId: string): Promise<void> {
  try {
    await removeProfileStrict(tenantId, userId);
  } catch (err) {
    log.warn('profiles_kb_remove_failed', { tenantId, userId, err: String(err) });
  }
}

/** Backfill the tenant's existing profiles into the managed collection (best-effort). */
export async function backfillTeamPortfolioKb(tenantId: string): Promise<void> {
  try {
    if (!(await gateOpen(tenantId))) return;
    // ADR 0643 D3 — a BULK lane: silent per row, ONE `document.ingested { count }` for
    // the batch (a 10 000-profile backfill must not ignite 10 000 bound runs).
    let count = 0;
    for (const p of await listProfiles(tenantId)) {
      await indexProfile(tenantId, p.userId, p, { silent: true });
      if (hasSignal(p)) count += 1;
    }
    if (count > 0) await kbMutated({ entity: 'document', verb: 'ingested', tenantId, orgId: TEAM_ORG, collectionId: collectionIdFor(tenantId), count });
  } catch (err) {
    log.warn('profiles_kb_backfill_failed', { tenantId, err: String(err) });
  }
}

// GDPR subject erasure: when a profile's owner is erased (ADR 0020/0077, the same
// seam `deleteSubjectProfile` rides), drop its Team Portfolio KB doc too. Registered
// HERE (not in profilesService) to avoid a service↔kb-service import cycle.
// STRICT (review F3): `eraseSubject` catches + COUNTS per-eraser failures, so a
// swallowed KB error would make the fan-out report a complete erasure over an
// incomplete one — the CONS-G1 class.
registerSubjectEraser(async function eraseProfileKnowledge(tenantId, subjectKey) { await removeProfileStrict(tenantId, subjectKey); });

/**
 * ADR 0100 D2 — the Team Portfolio KB as a bindable Board-of-Advisors knowledge
 * source (GRADE DATA-4 / TPK-1: the store was write-only; nothing could retrieve
 * it). Mirrors the strategy/vendor providers. The collection is TENANT-level (under
 * the `_team` sentinel org), so it is offered to every org in the tenant; retrieval
 * is tenant-vector-namespaced by collectionId, so the org the binding lives in does
 * not affect what an advisor can search. `ensureCollectionIds` pre-creates AND
 * backfills the tenant's existing profiles — the wiring that finally CALLS
 * `backfillTeamPortfolioKb` (previously dead), so binding an empty KB populates it.
 */
export const teamPortfolioShareableKbProvider: ShareableKbProvider = {
  kind: 'team-portfolio',
  resolveCollectionIds: async (tenantId) =>
    (await getCollection(tenantId, TEAM_ORG, collectionIdFor(tenantId))) ? [collectionIdFor(tenantId)] : [],
  ensureCollectionIds: async (tenantId, _orgId, actor) => {
    if (!(await gateOpen(tenantId))) return []; // only when the production consumer is enabled
    await getOrCreateCollection(tenantId, actor);
    await backfillTeamPortfolioKb(tenantId);
    return [collectionIdFor(tenantId)];
  },
};
