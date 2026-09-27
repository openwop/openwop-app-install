/**
 * `demo-kicktodo` seeder (app-seeding-strategy.md §4 Phase 11, §7.1).
 *
 * WHY THIS EXISTS. §7.1 names the drift it prevents: "the eight new packages
 * shipping with zero seeders". `kicktodo-core` was one of them, and the cost is
 * concrete rather than cosmetic — with no published challenges, Discover renders
 * "No challenges published yet", so Today renders "Nothing on your plate yet",
 * so Plan, Progress and Journal are all empty too. Five surfaces demo as blank
 * pages, and nobody can tell a working install from a broken one. MEASURED on a
 * real white-label deploy, where an operator reasonably read the empty state as
 * a bug.
 *
 * Mechanics (§2):
 * - Real services only: `createDraft` + `publishChallenge` + `enroll`, the same
 *   calls `routes.ts` makes. Validation, contentHash and the day↔date mapping all
 *   fire exactly as they do for an authored challenge.
 * - Deterministic ids: every challenge is `chal:demo-kicktodo-<slug>`. That is
 *   what makes `count()`, `clear()` and re-seed idempotence possible; a random
 *   UUID would orphan a row on every run.
 * - Toggle-gated: `kicktodo-core` is checked INSIDE `seed()` and reported as
 *   `{created: 0, details: {skipped}}`. A seeder never flips a toggle (§2).
 * - Surgical clear: only ids carrying `KICKTODO_DEMO_PREFIX` are retired, so an
 *   operator's own authored challenges are never touched — and only the demo
 *   actor's enrollments on them are abandoned, so a real participant who
 *   enrolled in a demo challenge keeps their pinned version (PRD §13).
 * - Round trip (§2 "clear is symmetric"): a published lineage is IMMUTABLE, so
 *   `clear()` retires rather than deletes, and the next `seed()` publishes a NEW
 *   VERSION at the same deterministic id (`createDraftVersion`) instead of
 *   handing the retired row to `publishChallenge` — which is what the first cut
 *   did, and it threw `ChallengeImmutableError` on every seed after the first
 *   clear (MEASURED 2026-09-07). `count()`/`isDemo` are prefix-based, so the
 *   version is invisible to them.
 * - Enrollment: only TYPED refusals (`EnrollDeniedError`, capacity/entitlement;
 *   `ChallengeNotEnrollableError`) are logged and reported as `enrolled: 0`.
 *   Anything else is rethrown — a storage or code error hidden behind "demo
 *   enrollment skipped" reproduces exactly the blank-Today symptom this seeder
 *   exists to remove.
 *
 * The three challenges are the ones the KickTodo product design canvas draws, so
 * a seeded tenant is comparable against the intended screens rather than against
 * an empty state.
 */
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import {
  createDraft, createDraftVersion, publishChallenge, retireChallenge, listPublished, getLatest,
} from '../features/kicktodo-core/challengeService.js';
import {
  enroll, listEnrollmentsInTenant, abandonEnrollment,
  EnrollDeniedError, ChallengeNotEnrollableError,
} from '../features/kicktodo-core/enrollmentService.js';
import {
  KICKTODO_DEMO_CHALLENGES, KICKTODO_DEMO_PREFIX, KICKTODO_DEMO_ACTOR,
} from './seed-data/kicktodoDemo.js';

const log = createLogger('seed.demoKicktodo');

function idFor(slug: string): string {
  return `${KICKTODO_DEMO_PREFIX}${slug}`;
}

function isDemo(challengeId: string): boolean {
  return challengeId.startsWith(KICKTODO_DEMO_PREFIX);
}

async function toggledOn(tenantId: string): Promise<boolean> {
  const a = await resolveOne('kicktodo-core', { tenantId });
  return Boolean(a && a.enabled);
}

/** Published demo challenges present for the tenant. */
export async function countDemoKicktodo(tenantId: string): Promise<number> {
  if (!(await toggledOn(tenantId))) return 0;
  const published = await listPublished(tenantId).catch(() => []);
  return published.filter((c) => isDemo(c.id)).length;
}

export async function seedDemoKicktodo(
  tenantId: string,
): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await toggledOn(tenantId))) {
    return { created: 0, details: { skipped: 'kicktodo-core toggle off' } };
  }

  let created = 0;
  const publishedIds: string[] = [];

  for (const c of KICKTODO_DEMO_CHALLENGES) {
    const id = idFor(c.slug);
    // Idempotent: a published row at this id means a previous run got there.
    const existing = await getLatest(tenantId, id).catch(() => null);
    if (existing && existing.status === 'published') {
      publishedIds.push(id);
      continue;
    }
    const content = {
      tenantId,
      authorSubject: KICKTODO_DEMO_ACTOR,
      id,
      title: c.title,
      summary: c.summary,
      outcome: c.outcome,
      durationDays: c.durationDays,
      depthLevel: c.depthLevel,
      activities: [...c.activities],
    };
    let draft;
    if (existing && existing.status === 'retired') {
      // The lineage was cleared: a published version is immutable, so the way
      // back is a NEW version, never the retired row (see the header).
      draft = await createDraftVersion(content);
      if (!draft) {
        // A concurrent seed claimed the version number; if it published, we are done.
        const now = await getLatest(tenantId, id).catch(() => null);
        if (now && now.status === 'published') { publishedIds.push(id); continue; }
        throw new Error(`demo-kicktodo: could not create a new version of ${id} (concurrent revision)`);
      }
    } else {
      draft = await createDraft(content);
    }
    const pub = await publishChallenge(tenantId, draft.id, draft.version);
    if (pub) {
      created += 1;
      publishedIds.push(id);
    }
  }

  // One enrollment so Today/Plan/Progress/Journal have something to render.
  // Without it the catalog exists but every participant surface is still blank,
  // which is most of what makes the empty state read as broken.
  let enrolled = 0;
  const first = publishedIds[0];
  if (first) {
    // Only a LIVE enrollment counts: after clear() the demo actor's old one is
    // abandoned, and a re-seed must enroll again or Today is blank once more.
    const already = (await listEnrollmentsInTenant(tenantId).catch(() => []))
      .some((e) => isDemo(e.challengeId) && e.ownerSubject === KICKTODO_DEMO_ACTOR
        && (e.state === 'active' || e.state === 'snoozed'));
    if (!already) {
      const c = await getLatest(tenantId, first).catch(() => null);
      if (c) {
        await enroll({
          tenantId,
          ownerSubject: KICKTODO_DEMO_ACTOR,
          challengeId: c.id,
          challengeVersion: c.version,
          timezone: 'UTC',
        }).then(() => { enrolled = 1; created += 1; })
          .catch((e: unknown) => {
            // A TYPED refusal is a legitimate posture (capacity, commerce
            // entitlement, not-enrollable): the catalog is the load-bearing half,
            // so report enrolled:0 and carry on. Anything else is a real failure
            // and must surface — swallowing it hides the exact symptom this
            // seeder exists to remove.
            if (e instanceof EnrollDeniedError || e instanceof ChallengeNotEnrollableError) {
              log.warn('demo enrollment refused', { reason: e.message });
              return;
            }
            throw e;
          });
      }
    }
  }

  log.info('demo_kicktodo_seeded', { tenantId, challenges: publishedIds.length, enrolled });
  return { created, details: { challenges: publishedIds.length, enrolled } };
}

export async function clearDemoKicktodo(
  tenantId: string,
): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const published = await listPublished(tenantId).catch(() => []);
  let retired = 0;
  for (const c of published) {
    if (!isDemo(c.id)) continue; // never touch operator-authored challenges
    const r = await retireChallenge(tenantId, c.id, c.version).catch(() => null);
    if (r) retired += 1;
  }
  // Symmetric with seed(): the demo ACTOR's live enrollments on demo challenges
  // are abandoned. Nobody else's — a real participant who enrolled in a demo
  // challenge keeps their pinned version, exactly as retire promises (PRD §13).
  let abandoned = 0;
  for (const e of await listEnrollmentsInTenant(tenantId).catch(() => [])) {
    if (!isDemo(e.challengeId) || e.ownerSubject !== KICKTODO_DEMO_ACTOR) continue;
    if (e.state !== 'active' && e.state !== 'snoozed') continue;
    const r = await abandonEnrollment(tenantId, e.id, KICKTODO_DEMO_ACTOR).catch(() => null);
    if (r && r.state === 'abandoned') abandoned += 1;
  }
  return { cleared: retired + abandoned, details: { retired, abandoned } };
}
