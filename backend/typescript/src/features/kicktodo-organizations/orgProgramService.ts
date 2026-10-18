/**
 * kicktodo-organizations (ADR 0428) — org challenge libraries, org cohorts,
 * brand ref, and k-anonymous outcome reports.
 *
 * OWNERSHIP: orgs/members/roles → accessControl (rows here are KEYED BY its
 * orgId, never a second org model); cohorts → ADR 0419 (the link stores only
 * a circleId; joining still rides 0419's consent flow — org linkage NEVER
 * grants visibility); catalog → kicktodo-core (the library is a curation
 * overlay). PRIVACY FLOOR: reports are computed on read from the 0419
 * counts-only aggregate seam, k ≥ 5 per cell, buckets only — a cell below
 * floor is WITHHELD (never a smaller number).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { getChallenge, listPublished } from '../kicktodo-core/challengeService.js';
import { getCohortDetail, cohortOutcomeAggregate } from '../kicktodo-accountability/cohortService.js';
import { CircleDeniedError, resolveCircleByOpaqueId } from '../kicktodo-accountability/circleService.js';

const log = createLogger('kicktodo.orgPrograms');

export interface OrgChallengeLibrary {
  tenantId: string;
  orgId: string;
  entries: Array<{ challengeId: string; version: number; addedBy: string; addedAt: string }>;
  updatedAt: string;
}

const libraries = new DurableCollection<OrgChallengeLibrary>(
  'kicktodo-org-libraries',
  (l) => `${l.tenantId}::${l.orgId}`,
);

export interface OrgCohortLink {
  tenantId: string;
  orgId: string;
  circleId: string;
  linkedBy: string;
  linkedAt: string;
}

const cohortLinks = new DurableCollection<OrgCohortLink>(
  'kicktodo-org-cohorts',
  (c) => `${c.tenantId}::${c.orgId}::${c.circleId}`,
);

interface OrgBrandRef {
  tenantId: string;
  orgId: string;
  brandProfileId: string;
  updatedAt: string;
}

const brandRefs = new DurableCollection<OrgBrandRef>(
  'kicktodo-org-brand',
  (b) => `${b.tenantId}::${b.orgId}`,
);

const nowIso = (): string => new Date().toISOString();

export class OrgProgramError extends Error {}
export class OrgProgramNotFoundError extends Error {
  constructor() {
    super('Not found.');
  }
}

/** KTORG-2 — the library kept changing for every attempt (a bounded CAS loop
 *  lost each round). Never a silent last-writer-wins. */
export class OrgLibraryConflictError extends Error {
  constructor() {
    super('The library kept changing while it was being saved. Try again.');
  }
}

/** How long an EMPTYING row (below) may stand before another writer may retire
 *  it — the window in which its claimant is presumed crashed, not slow. */
const EMPTYING_STALE_MS = 30_000;
const LIBRARY_CAS_ATTEMPTS = 8;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Add/remove a published challenge in the org's library (idempotent).
 *
 * KTORG-2 (KTO-2) — this was get → filter → put with no CAS, so two concurrent
 * edits both read the same library and the later `put` dropped the other's entry.
 * Every write is now a CAS on the exact row read, re-derived on each attempt.
 *
 * THE EMPTY CASE is the hard half. KTORG-D1 requires an empty library to be NO
 * row, and `Storage` has no compare-and-delete, so a bare `delete` after a CAS
 * could erase an entry a concurrent adder had just written. The removal is two
 * steps instead: CAS the row to an EMPTYING row (`entries: []`), then delete it.
 * An empty row is never a base for anyone else's write — a writer that reads one
 * backs off and re-reads until it is gone — so between the claim and the delete
 * no other write can land on that key, and the delete cannot erase one. An
 * emptying row older than `EMPTYING_STALE_MS` belongs to a crashed claimant; a
 * writer retires it the same way (CAS to a fresh emptying row it owns, then
 * delete), so a crash never wedges the library or `deleteOrg`. Residual: a
 * claimant paused for longer than that window between its CAS and its delete
 * could erase a later write — the lease bound every TTL lock here shares.
 */
export async function setLibraryEntry(
  tenantId: string,
  orgId: string,
  actorSubject: string,
  input: { challengeId: string; version: number; present: boolean },
): Promise<OrgChallengeLibrary> {
  // Grade-data KTORG-D1 — only an ADD needs the challenge to exist; removing an
  // entry must work even for a version that is gone, or a dangling entry could
  // never be cleared.
  if (input.present && !(await getChallenge(tenantId, input.challengeId, input.version))) throw new OrgProgramNotFoundError();
  const key = `${tenantId}::${orgId}`;
  for (let attempt = 0; attempt < LIBRARY_CAS_ATTEMPTS; attempt++) {
    const stored = await libraries.get(key);
    if (stored && stored.entries.length === 0) {
      // Another writer's EMPTYING claim (or a crashed one's). Never build on it.
      if (Date.now() - Date.parse(stored.updatedAt) > EMPTYING_STALE_MS) {
        const retake: OrgChallengeLibrary = { tenantId, orgId, entries: [], updatedAt: nowIso() };
        if (await libraries.compareAndSwap(stored, retake)) await libraries.delete(key);
      } else {
        await sleep(5 * (attempt + 1));
      }
      continue;
    }
    const existing = stored ?? { tenantId, orgId, entries: [], updatedAt: nowIso() };
    const without = existing.entries.filter((e) => !(e.challengeId === input.challengeId && e.version === input.version));
    const entries = input.present
      ? [...without, { challengeId: input.challengeId, version: input.version, addedBy: actorSubject, addedAt: nowIso() }]
      : without;
    const next: OrgChallengeLibrary = { tenantId, orgId, entries, updatedAt: nowIso() };
    // Grade-data KTORG-D1 — an EMPTY library is no row at all. `deleteOrg` refuses
    // while any org-scoped business row exists (`countOrgHostExtRows`), so a kept
    // empty row blocked deleting the org forever once anyone had curated a library.
    if (entries.length === 0) {
      if (!stored) return next; // nothing stored, nothing to remove
      if (!(await libraries.compareAndSwap(stored, next))) continue; // claim EMPTYING
      await libraries.delete(key);
    } else if (!(await libraries.compareAndSwap(stored, next))) {
      continue;
    }
    log.info('kicktodo_org_library_updated', { orgId, entries: entries.length });
    return next;
  }
  throw new OrgLibraryConflictError();
}

export async function getLibrary(tenantId: string, orgId: string): Promise<OrgChallengeLibrary | null> {
  return await libraries.get(`${tenantId}::${orgId}`);
}

/** The Discover overlay: when the org HAS a library it is an ALLOWLIST —
 *  only curated entries show inside the org; no library ⇒ full catalog. */
export async function libraryCatalog(tenantId: string, orgId: string): Promise<{
  curated: boolean;
  challenges: Array<{ id: string; version: number; title: string }>;
}> {
  const lib = await libraries.get(`${tenantId}::${orgId}`);
  const published = await listPublished(tenantId);
  if (!lib || lib.entries.length === 0) {
    return { curated: false, challenges: published.map((c) => ({ id: c.id, version: c.version, title: c.title })) };
  }
  const allowed = new Set(lib.entries.map((e) => `${e.challengeId}::v${e.version}`));
  return {
    curated: true,
    challenges: published
      .filter((c) => allowed.has(`${c.id}::v${c.version}`))
      .map((c) => ({ id: c.id, version: c.version, title: c.title })),
  };
}

/** Bind an EXISTING 0419 cohort to the org. Joining stays 0419's consent
 *  flow — this link never grants anyone visibility into anything. */
export async function linkCohort(
  tenantId: string,
  orgId: string,
  actorSubject: string,
  circleId: string,
): Promise<OrgCohortLink> {
  const detail = await getCohortDetail(tenantId, circleId);
  if (!detail) throw new OrgProgramNotFoundError();
  // KTFULL-B16 — link validation previously checked only EXISTENCE, so an org
  // admin could bind any same-tenant PRIVATE cohort and then read its internal
  // aggregate without the cohort owner ever consenting. Require that the actor
  // OWNS the cohort (a coach linking their own) — an org cannot conscript a
  // participant's private group into its reporting.
  const circle = await resolveCircleByOpaqueId(circleId).catch(() => null);
  if (!circle || circle.ownerSubject !== actorSubject) throw new OrgProgramNotFoundError();
  const link: OrgCohortLink = { tenantId, orgId, circleId, linkedBy: actorSubject, linkedAt: nowIso() };
  await cohortLinks.put(link);
  log.info('kicktodo_org_cohort_linked', { tenantId, orgId, circleId });
  return link;
}

/**
 * ARCH-M6 — unlinking is symmetric with linking: the cohort's OWNER withdraws
 * their own cohort, or the org admin who is also the owner does. Previously
 * this took no actor at all, so any org admin could unlink a cohort a
 * DIFFERENT coach had linked — an asymmetry with `linkCohort`'s ownership
 * requirement that let one member undo another's decision.
 *
 * A link whose owner can no longer be resolved is removable by anyone: it is
 * already inert (`orgReport` skips it), and refusing to delete it would strand
 * a dead row forever.
 */
export async function unlinkCohort(
  tenantId: string,
  orgId: string,
  circleId: string,
  actorSubject: string,
): Promise<void> {
  const link = await cohortLinks.get(`${tenantId}::${orgId}::${circleId}`);
  if (!link) return;
  // Code-grade KTO-1 — only a GONE circle (`CircleDeniedError`) makes the link
  // ownerless. Any other failure (a storage outage) used to be swallowed into the
  // same null, so a transient error let any org admin remove another member's link.
  const circle = await resolveCircleByOpaqueId(circleId).catch((err: unknown) => {
    if (err instanceof CircleDeniedError) return null;
    throw err;
  });
  if (circle && circle.ownerSubject !== actorSubject) throw new OrgProgramNotFoundError();
  await cohortLinks.delete(`${tenantId}::${orgId}::${circleId}`);
  log.info('kicktodo_org_cohort_unlinked', { tenantId, orgId, circleId });
}

export async function listCohortLinks(tenantId: string, orgId: string): Promise<OrgCohortLink[]> {
  return await cohortLinks.listByPrefix(`${tenantId}::${orgId}::`);
}

export async function setBrandRef(tenantId: string, orgId: string, brandProfileId: string): Promise<void> {
  if (!brandProfileId.trim() || brandProfileId.length > 200) throw new OrgProgramError('A brand profile id is required.');
  await brandRefs.put({ tenantId, orgId, brandProfileId: brandProfileId.trim(), updatedAt: nowIso() });
  log.info('kicktodo_org_brand_ref_set', { tenantId, orgId, brandProfileId: brandProfileId.trim() });
}

/** Grade-data KTORG-D1 — remove the org's brand reference. Without it a brand ref,
 *  once set, could never be removed, and `deleteOrg`'s refuse-while-populated guard
 *  blocked deleting the org forever. Idempotent. */
export async function clearBrandRef(tenantId: string, orgId: string): Promise<boolean> {
  const removed = await brandRefs.delete(`${tenantId}::${orgId}`);
  if (removed) log.info('kicktodo_org_brand_ref_cleared', { tenantId, orgId });
  return removed;
}

export async function getBrandRef(tenantId: string, orgId: string): Promise<string | null> {
  return (await brandRefs.get(`${tenantId}::${orgId}`))?.brandProfileId ?? null;
}

export const REPORT_K_FLOOR = 5;

export interface OrgCohortReportCell {
  circleId: string;
  challengeId: string;
  challengeVersion: number;
  /** Null when the cohort is below the k-floor — WITHHELD, never a smaller number. */
  outcome: { members: number; activeMembers: number; completedMembers: number; completionRate: number } | null;
  withheldReason?: 'below-k-floor';
}

/** k-anonymous, computed-on-read org report: one cell per linked cohort,
 *  buckets only, each cell independently floored at k ≥ 5 ACTIVE members. */
export async function orgReport(tenantId: string, orgId: string): Promise<OrgCohortReportCell[]> {
  const links = await cohortLinks.listByPrefix(`${tenantId}::${orgId}::`);
  const cells: OrgCohortReportCell[] = [];
  for (const link of links) {
    const detail = await getCohortDetail(tenantId, link.circleId);
    if (!detail) continue;
    // ARCH-M5 — RE-VERIFY consent on every read. B16 made ownership the
    // consent signal but checked it only when the link was WRITTEN, so a
    // cohort that changed hands (or a coach who left the org) kept feeding
    // this report indefinitely: consent granted once became consent forever.
    // A link is a standing permission only while the person who gave it still
    // owns the cohort.
    const circle = await resolveCircleByOpaqueId(link.circleId).catch(() => null);
    if (!circle || circle.ownerSubject !== link.linkedBy) continue;
    const agg = await cohortOutcomeAggregate(tenantId, link.circleId);
    const base = { circleId: link.circleId, challengeId: detail.challengeId, challengeVersion: detail.challengeVersion };
    if (!agg || agg.activeMembers < REPORT_K_FLOOR) {
      cells.push({ ...base, outcome: null, withheldReason: 'below-k-floor' });
      continue;
    }
    cells.push({
      ...base,
      outcome: {
        members: agg.members,
        activeMembers: agg.activeMembers,
        completedMembers: agg.completedMembers,
        completionRate: Math.round((agg.completedMembers / agg.activeMembers) * 100) / 100,
      },
    });
  }
  return cells;
}

// ADR 0458 P0 — NO registerSubjectEraser and NO registerRetentionPurger (deliberate, with
// reason). Every store here is keyed by `orgId` / `circleId`, never by a person's subject
// key: libraries and brand refs are org-owned configuration, cohort links bind an org to a
// 0419 circle (the personal cohort membership + its consent live in kicktodo-accountability,
// not here), and outcome reports are computed on read from a k≥5 aggregate — no per-person
// row is ever stored. The `addedBy` / `linkedBy` fields are audit ATTRIBUTION on an
// org-owned row, not the subject's personal data (a governance record of who curated the
// org's library survives that person's DSAR, like an approval's actor). These rows are
// operational (`internal`) and hold no aged PII, so this package is not on either seam.

/** Test-only: the module-private collections, for erasure/seed assertions. */
export const __test = { libraries, cohortLinks, brandRefs };
