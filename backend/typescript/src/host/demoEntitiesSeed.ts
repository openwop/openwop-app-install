/**
 * `demo-entities` seeder (ADR 0407 Phase 3 — the delivery-bridge proving
 * consumer): a `team-member` content type with a `departments` taxonomy and a
 * small live roster, publish + publicRead flipped so the seeded CMS "About"
 * page's `entityList` section (and the anonymous public-entities read) resolve
 * real rows out of the box.
 *
 * Mechanics (app-seeding-strategy.md §2):
 * - Real services only — types/terms/entities go through the entities feature
 *   services (closed-world validation, deterministic ADR 0162 ids), never raw
 *   storage writes.
 * - Toggle-gated, skips honestly (the CDP-seed rule): the `entities` toggle is
 *   default OFF; the seeder NEVER flips a toggle.
 * - Deterministic + idempotent: fixed entity ids (`demo-team-*`) make re-runs
 *   converge (idempotent re-create); `clear()` removes only rows whose
 *   `createdBy` is the `demo:entities` marker.
 * - One entry stays DRAFT deliberately so the entry-status lane (draft rows
 *   invisible to the public read) is demonstrable.
 */
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import {
  createEntity,
  createEntityType,
  deleteEntity,
  deleteEntityType,
  getEntityType,
  isTermInUse,
  listEntities,
  updateEntityType,
} from '../features/entities/entitiesService.js';
import {
  createTaxonomy,
  createTerm,
  deleteTaxonomy,
  deleteTerm,
  listTaxonomies,
  listTerms,
} from '../features/entities/taxonomyService.js';

const log = createLogger('seed.demoEntities');

export const DEMO_ENTITIES_ACTOR = 'demo:entities';
const TYPE_NAME = 'team-member';
const TAXONOMY = 'departments';

const TERMS = [
  { slug: 'leadership', label: 'Leadership' },
  { slug: 'roastery', label: 'Roastery' },
  { slug: 'cafe', label: 'Café' },
];

const TEAM: Array<{ id: string; name: string; role: string; bio: string; term: string; draft?: boolean }> = [
  { id: 'demo-team-maya', name: 'Maya Chen', role: 'Founder & CEO', bio: 'Started Solstice in a garage roaster in 2016.', term: 'leadership' },
  { id: 'demo-team-jonas', name: 'Jonas Petrov', role: 'Head Roaster', bio: 'Cups every lot twice before it ships.', term: 'roastery' },
  { id: 'demo-team-aisha', name: 'Aisha Okafor', role: 'Director of Sourcing', bio: 'Builds long-term farmgate relationships across three origins.', term: 'roastery' },
  { id: 'demo-team-leo', name: 'Leo Martínez', role: 'Café Lead', bio: 'Runs the flagship bar and the barista apprenticeship.', term: 'cafe' },
  { id: 'demo-team-nadia', name: 'Nadia Rossi', role: 'Wholesale Manager', bio: 'Keeps sixty partner cafés stocked and trained.', term: 'cafe' },
  // Deliberately DRAFT — demonstrates the entry-status lane (never public).
  { id: 'demo-team-newhire', name: 'New Hire', role: 'Roaster (starting soon)', bio: 'Bio pending.', term: 'roastery', draft: true },
];

async function entitiesEnabled(tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne('entities', { tenantId }))?.enabled);
}

/** Demo rows present for the tenant (the `demo:entities` createdBy marker). */
export async function countDemoEntities(tenantId: string): Promise<number> {
  if (!(await entitiesEnabled(tenantId))) return 0;
  const type = await getEntityType(tenantId, undefined, TYPE_NAME);
  if (!type) return 0;
  const page = await listEntities({ tenantId, typeName: TYPE_NAME, limit: 200 });
  return page.entities.filter((e) => e.createdBy === DEMO_ENTITIES_ACTOR).length;
}

export async function seedDemoEntities(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await entitiesEnabled(tenantId))) {
    log.info('demo_entities_skipped_toggle_off', { tenantId });
    return { created: 0, details: { skipped: 'entities toggle off' } };
  }
  let created = 0;

  // Taxonomy + ordered terms (idempotent by name/slug).
  const taxonomies = await listTaxonomies(tenantId, undefined);
  if (!taxonomies.some((tx) => tx.name === TAXONOMY)) {
    await createTaxonomy({ tenantId, name: TAXONOMY, displayName: 'Departments' });
    created += 1;
  }
  const existingTerms = await listTerms(tenantId, undefined, TAXONOMY);
  const termIdBySlug = new Map(existingTerms.map((tm) => [tm.slug, tm.termId]));
  for (const term of TERMS) {
    if (!termIdBySlug.has(term.slug)) {
      const rec = await createTerm({ tenantId, taxonomyName: TAXONOMY, slug: term.slug, label: term.label });
      termIdBySlug.set(term.slug, rec.termId);
      created += 1;
    }
  }

  // The content type — published + publicRead so the CMS entityList section
  // and the anonymous read resolve immediately.
  let type = await getEntityType(tenantId, undefined, TYPE_NAME);
  if (!type) {
    type = await createEntityType({
      tenantId,
      name: TYPE_NAME,
      displayName: 'Team member',
      description: 'Solstice staff roster (demo).',
      fields: [
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'role', label: 'Role', type: 'string', required: false },
        { key: 'bio', label: 'Bio', type: 'string', required: false },
      ],
      createdBy: DEMO_ENTITIES_ACTOR,
    });
    created += 1;
  }
  if (type.status !== 'published' || type.publicRead !== true) {
    await updateEntityType({
      tenantId,
      name: TYPE_NAME,
      patch: { status: 'published', publicRead: true },
      actor: DEMO_ENTITIES_ACTOR,
    });
  }

  // Roster rows — deterministic ids ⇒ idempotent re-create (ADR 0162).
  const existing = new Set((await listEntities({ tenantId, typeName: TYPE_NAME, limit: 200 })).entities.map((e) => e.entityId));
  for (const member of TEAM) {
    const termId = termIdBySlug.get(member.term);
    if (existing.has(member.id)) continue;
    await createEntity({
      tenantId,
      typeName: TYPE_NAME,
      entityId: member.id,
      values: { name: member.name, role: member.role, bio: member.bio },
      ...(termId ? { termIds: [termId] } : {}),
      ...(member.draft ? { status: 'draft' } : {}),
      createdBy: DEMO_ENTITIES_ACTOR,
    });
    created += 1;
  }
  log.info('demo_entities_seeded', { tenantId, created });
  return { created, details: { type: TYPE_NAME, taxonomy: TAXONOMY, members: TEAM.length } };
}

export async function clearDemoEntities(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  if (!(await entitiesEnabled(tenantId))) return { cleared: 0, details: { skipped: 'entities toggle off' } };
  let removed = 0;
  const type = await getEntityType(tenantId, undefined, TYPE_NAME);
  if (type) {
    const page = await listEntities({ tenantId, typeName: TYPE_NAME, limit: 200 });
    for (const row of page.entities) {
      if (row.createdBy !== DEMO_ENTITIES_ACTOR) continue;
      await deleteEntity({ tenantId, typeName: TYPE_NAME, entityId: row.entityId });
      removed += 1;
    }
    // Remove the type only when it was ours AND nothing user-authored remains.
    const rest = await listEntities({ tenantId, typeName: TYPE_NAME, limit: 1 });
    if (type.createdBy === DEMO_ENTITIES_ACTOR && rest.entities.length === 0) {
      await deleteEntityType({ tenantId, name: TYPE_NAME });
      removed += 1;
    }
  }
  const taxonomies = await listTaxonomies(tenantId, undefined);
  if (taxonomies.some((tx) => tx.name === TAXONOMY)) {
    const termRows = await listTerms(tenantId, undefined, TAXONOMY);
    let inUse = false;
    for (const term of termRows) {
      try {
        await deleteTerm({ tenantId, taxonomyName: TAXONOMY, slug: term.slug, isTermInUse });
        removed += 1;
      } catch {
        inUse = true; // a user-authored entity still references it — leave it
      }
    }
    if (!inUse) {
      try {
        await deleteTaxonomy({ tenantId, name: TAXONOMY });
        removed += 1;
      } catch {
        /* terms remain — leave the taxonomy */
      }
    }
  }
  return { cleared: removed };
}
