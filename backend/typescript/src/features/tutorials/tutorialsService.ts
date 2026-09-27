/**
 * Tutorials service (ADR 0488 P1) — the ONE owner of tutorial narrative reads.
 *
 * ARCHITECTURE (ADR 0488 D1/D3): a tutorial is a NARRATIVE document bound to a
 * chain SPINE. This file owns the narrative half only; the spine stays an RFC
 * 0013 walkthrough chain, untouched. Narratives live in the entities content
 * kernel as `tutorials.lesson` rows — tenant-editable, ADR 0406-localizable.
 *
 * THE DEGRADED-MODE FLOOR (D3) is the load-bearing rule here. `/tutorials` is
 * deliberately ALWAYS-ON (ADR 0490's access-hub posture: "tutorials teach
 * features a workspace may not have enabled yet, so the reader itself is never
 * toggle-gated"), but the `entities` kernel it now reads from defaults **OFF**.
 * So every read is:
 *
 *      kernel row (authoritative, editable, localized)
 *        └─ falls back to ─▶ the in-repo SEED (read-only, honest about it)
 *
 * A kernel that is off, empty, or throwing therefore DEGRADES the surface to a
 * read-only reader instead of emptying it. That is why `source` rides every
 * response: the UI must be able to say "you are reading the shipped copy, edits
 * live elsewhere" rather than silently implying the tenant's row is what they
 * see. Reporting a failed read as an empty list is the single most common defect
 * class in this repo's UX audits — it is structurally impossible here.
 *
 * NOTE this is NOT the ADR 0072 anti-pattern returning. That anti-pattern is a
 * code-pinned artifact being the uneditable runtime source of truth FOR A
 * WORKFLOW. The workflow spine is a proper chain; the seed is a documented
 * fallback that a tenant's kernel row supersedes the moment `entities` is on.
 */

import { deleteSystemEntity, getSystemEntity, listSystemEntities, mintSystemType, putSystemEntity } from '../entities/entitiesService.js';
import { TUTORIAL_DOC_KIND, TUTORIAL_FIELD_KEYS, TUTORIAL_FIELDS, TUTORIAL_TYPE } from './tutorialType.js';
import { SEED_TUTORIALS, type SeededTutorial } from './seedTutorials.js';
import { registerFieldKindValidator, getFieldKindValidator } from '../../host/customFields/index.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.tutorials');

/**
 * ADR 0408 D2 — the `tutorial-doc` extension kind: tutorials' structured
 * (non-scalar) fields. Registered at MODULE SCOPE, mirroring the cms `blocks`
 * kind, so the kernel has it wherever this service loads — bare-harness tests
 * included — and NOT only when routes are mounted.
 *
 * The validator is deliberately a real STRUCTURAL check rather than a pass-through:
 * an extension kind that accepts anything would widen the kernel's closed-world
 * write validation, which is the invariant that keeps model-authored content
 * (ADR 0488 P6) from reaching durable state unchecked. It bounds what it cannot
 * type — depth, breadth, and serialized size — and rejects anything that is not
 * plain JSON data.
 */
const DOC_MAX_BYTES = 256 * 1024;
const DOC_MAX_DEPTH = 12;
const DOC_MAX_ITEMS = 2_000;

function assertPlainJson(value: unknown, depth: number, counter: { n: number }): void {
  if (depth > DOC_MAX_DEPTH) {
    throw new OpenwopError('validation_error', `tutorial content nests deeper than ${DOC_MAX_DEPTH} levels.`, 400, { field: 'type' });
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OpenwopError('validation_error', 'tutorial content contains a non-finite number.', 400, { field: 'type' });
    return;
  }
  if (Array.isArray(value) || (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)) {
    const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    if ((counter.n += entries.length) > DOC_MAX_ITEMS) {
      throw new OpenwopError('validation_error', `tutorial content exceeds ${DOC_MAX_ITEMS} nodes.`, 400, { field: 'type' });
    }
    for (const v of entries) assertPlainJson(v, depth + 1, counter);
    return;
  }
  // Dates, class instances, functions, symbols, undefined — none survive a
  // storage round-trip intact, so accepting them would be a silent data loss.
  throw new OpenwopError('validation_error', 'tutorial content must be plain JSON data (object, array, string, number, boolean or null).', 400, { field: 'type' });
}

// Idempotent: a module can be re-imported under a test harness, and
// `registerFieldKindValidator` throws on a duplicate kind.
if (!getFieldKindValidator(TUTORIAL_DOC_KIND)) {
  registerFieldKindValidator(TUTORIAL_DOC_KIND, {
    validate: (value) => {
      if (value === undefined) return value;
      assertPlainJson(value, 0, { n: 0 });
      const bytes = JSON.stringify(value)?.length ?? 0;
      if (bytes > DOC_MAX_BYTES) {
        throw new OpenwopError('validation_error', `tutorial content exceeds ${DOC_MAX_BYTES} bytes.`, 400, { field: 'type' });
      }
      return value;
    },
  });
}

/** Where a returned tutorial actually came from — surfaced to the client so the
 *  reader can be honest about editability. Never inferred client-side. */
export type TutorialSource = 'kernel' | 'seed';

export interface TutorialView extends SeededTutorial {
  source: TutorialSource;
  /** True when a tenant has edited this row (ADR 0488 D3 `customizedAt`). */
  customized?: boolean;
}

/**
 * Kernel reachability is a per-request question (the toggle is runtime), so it is
 * never cached. Failures are logged at a bounded rate rather than per read.
 *
 * Deliberately NOT log-once-per-process (`/grade-code` TUT-1): with a plain
 * latch, a real outage produces exactly one line for the lifetime of the
 * process and every subsequent failure is invisible — the operator cannot tell a
 * one-off blip from a kernel that has been down for hours. A time window keeps
 * the log quiet while still proving the failure is ONGOING, and the suppressed
 * count makes the volume honest instead of hidden.
 */
const WARN_WINDOW_MS = 60_000;
const warnState = new Map<string, { at: number; suppressed: number }>();
function warnThrottled(reason: string, err: unknown): void {
  const now = Date.now();
  const prev = warnState.get(reason);
  if (prev && now - prev.at < WARN_WINDOW_MS) { prev.suppressed += 1; return; }
  log.warn('tutorial_kernel_read_failed', {
    reason,
    error: String(err),
    ...(prev?.suppressed ? { suppressedSinceLastLog: prev.suppressed } : {}),
  });
  warnState.set(reason, { at: now, suppressed: 0 });
}

/**
 * Kernel row → the shared `TutorialData` shape.
 *
 * TWO BAGS, by kernel design (grade-data `TUT-1`, third layer): `values` holds
 * BUILT-IN SCALARS ONLY — `validateSystemScalars` filters the type's fields to
 * `FIELD_TYPES` before validating — while extension-kind fields are carried in
 * `ext`, where `buildSystemExt` finds their def and runs the registered
 * validator. `cms.page` splits the same way ("everything non-scalar rides
 * ext.page"). Writing `phases` into `values` therefore fails closed with
 * "Unknown custom field", which is the third distinct defect that had to be
 * cleared before a single tutorial row could exist.
 *
 * Reads go through `TUTORIAL_FIELD_KEYS` so a key rename cannot silently start
 * reading `undefined`.
 */
function rowToView(values: Record<string, unknown>, ext: Record<string, unknown> | undefined): TutorialView | null {
  const K = TUTORIAL_FIELD_KEYS;
  const doc = ext ?? {};
  const customizedAt = doc.customizedAt;
  const slug = typeof values[K.slug] === 'string' ? (values[K.slug] as string) : null;
  const phases = doc[K.phases];
  // Structural floor — a malformed row must fall back to the seed rather than
  // render a broken tutorial (the kernel is tenant-writable).
  if (!slug || !Array.isArray(phases)) return null;
  return {
    id: slug,
    category: (values[K.category] as SeededTutorial['category']) ?? 'getting-started',
    title: String(values[K.title] ?? slug),
    description: String(values[K.description] ?? ''),
    hero: { title: String(values[K.heroTitle] ?? values[K.title] ?? slug), subtitle: String(values[K.heroSubtitle] ?? '') },
    ...(typeof values[K.goal] === 'string' ? { goal: values[K.goal] as string } : {}),
    ...(Array.isArray(doc[K.learningObjectives]) ? { learningObjectives: doc[K.learningObjectives] as string[] } : {}),
    ...(Array.isArray(doc[K.prerequisites]) ? { prerequisites: doc[K.prerequisites] as string[] } : {}),
    ...(Array.isArray(doc[K.surfaces]) ? { surfaces: doc[K.surfaces] as string[] } : {}),
    ...(typeof values[K.requiresSeed] === 'string' ? { requiresSeed: values[K.requiresSeed] as string } : {}),
    ...(typeof values[K.estimatedMinutes] === 'number' ? { estimatedMinutes: values[K.estimatedMinutes] as number } : {}),
    ...(typeof values[K.difficulty] === 'string' ? { difficulty: values[K.difficulty] as SeededTutorial['difficulty'] } : {}),
    phases: phases as SeededTutorial['phases'],
    // A tenant-authored row may have no seedVersion; '' reads as "not from a seed".
    seedVersion: typeof values[K.seedVersion] === 'string' ? (values[K.seedVersion] as string) : '',
    source: 'kernel',
    ...(customizedAt ? { customized: true } : {}),
  };
}

/**
 * Every tutorial visible to this tenant. Kernel rows win by slug; seeds fill the
 * gaps, so a tenant that has never seeded still sees the full shipped library.
 */
export async function listTutorials(tenantId: string): Promise<{ tutorials: TutorialView[]; degraded: boolean }> {
  const bySlug = new Map<string, TutorialView>();
  for (const seed of SEED_TUTORIALS) bySlug.set(seed.id, { ...seed, source: 'seed' });

  let degraded = false;
  try {
    for (const rec of await listSystemEntities(tenantId, TUTORIAL_TYPE)) {
      const view = rowToView(rec.values ?? {}, rec.ext as Record<string, unknown> | undefined);
      if (view) bySlug.set(view.id, view);
    }
  } catch (err) {
    // The kernel is off/unreachable — serve the shipped copy, flagged.
    degraded = true;
    warnThrottled('list', err);
  }
  return { tutorials: [...bySlug.values()], degraded };
}

/** One tutorial by slug, kernel-first with the seed floor. */
export async function getTutorial(tenantId: string, slug: string): Promise<TutorialView | null> {
  try {
    const rec = await getSystemEntity(tenantId, TUTORIAL_TYPE, slug);
    if (rec) {
      const view = rowToView(rec.values ?? {}, rec.ext as Record<string, unknown> | undefined);
      if (view) return view;
    }
  } catch (err) {
    warnThrottled('get', err);
  }
  const seed = SEED_TUTORIALS.find((s) => s.id === slug);
  return seed ? { ...seed, source: 'seed' } : null;
}

/**
 * Seed/refresh this tenant's tutorial rows (ADR 0488 D3 lifecycle).
 *
 * Idempotent and NON-DESTRUCTIVE, matching the app's seeding contract:
 *  - a row that does not exist is created;
 *  - a row whose `seedVersion` is behind the code's is REFRESHED — but only if
 *    the tenant has not customized it (`ext.customizedAt` unset). A tenant edit
 *    is never overwritten by a redeploy; that is the whole point of the pair.
 *  - `force` exists for the operator path and is never wired to a tenant route.
 *
 * Best-effort by contract: with `entities` OFF this throws, the caller swallows,
 * and the reader keeps serving seeds. Seeding is an ENHANCEMENT, never a
 * precondition for the surface to work.
 */
export async function seedTutorials(tenantId: string, opts: { force?: boolean } = {}): Promise<{ created: number; updated: number; skipped: number }> {
  await mintSystemType({
    tenantId,
    name: TUTORIAL_TYPE,
    displayName: 'Tutorial',
    description: 'Guided product tutorials — narrative bound to a walkthrough chain (ADR 0488).',
    fields: TUTORIAL_FIELDS,
    // ADR 0408 D2 — extension kinds are opt-in PER CALLER. Without this the
    // structured fields are rejected and the whole mint throws (grade-data TUT-1).
    extensionKinds: [TUTORIAL_DOC_KIND],
    actor: 'system:tutorials',
  });

  let created = 0, updated = 0, skipped = 0;
  for (const seed of SEED_TUTORIALS) {
    const existing = await getSystemEntity(tenantId, TUTORIAL_TYPE, seed.id);
    const existingCustomizedAt = (existing?.ext as Record<string, unknown> | undefined)?.customizedAt;
    if (existing) {
      const customized = Boolean(existingCustomizedAt);
      const sameVersion = (existing.values as Record<string, unknown> | undefined)?.[TUTORIAL_FIELD_KEYS.seedVersion] === seed.seedVersion;
      if ((customized && !opts.force) || sameVersion) { skipped += 1; continue; }
      updated += 1;
    } else {
      created += 1;
    }
    await putSystemEntity({
      tenantId,
      typeName: TUTORIAL_TYPE,
      entityId: seed.id,
      status: 'live',
      actor: 'system:tutorials',
      // Built-in scalars only — see `rowToView`'s two-bag note.
      values: {
        [TUTORIAL_FIELD_KEYS.slug]: seed.id,
        [TUTORIAL_FIELD_KEYS.title]: seed.title,
        [TUTORIAL_FIELD_KEYS.description]: seed.description,
        [TUTORIAL_FIELD_KEYS.category]: seed.category,
        ...(seed.difficulty ? { [TUTORIAL_FIELD_KEYS.difficulty]: seed.difficulty } : {}),
        ...(seed.estimatedMinutes ? { [TUTORIAL_FIELD_KEYS.estimatedMinutes]: seed.estimatedMinutes } : {}),
        [TUTORIAL_FIELD_KEYS.heroTitle]: seed.hero.title,
        [TUTORIAL_FIELD_KEYS.heroSubtitle]: seed.hero.subtitle,
        ...(seed.goal ? { [TUTORIAL_FIELD_KEYS.goal]: seed.goal } : {}),
        ...(seed.requiresSeed ? { [TUTORIAL_FIELD_KEYS.requiresSeed]: seed.requiresSeed } : {}),
        [TUTORIAL_FIELD_KEYS.seedVersion]: seed.seedVersion,
      },
      // Extension-kind (`tutorial-doc`) fields. `customizedAt` is carried
      // forward explicitly: an omitted `ext` is CLOBBERED by the kernel, not
      // merged, so a force-refresh would otherwise erase the very marker that
      // guards the next non-forced refresh (grade-data `TUT-3`).
      ext: {
        ...(seed.learningObjectives ? { [TUTORIAL_FIELD_KEYS.learningObjectives]: seed.learningObjectives } : {}),
        ...(seed.prerequisites ? { [TUTORIAL_FIELD_KEYS.prerequisites]: seed.prerequisites } : {}),
        ...(seed.surfaces ? { [TUTORIAL_FIELD_KEYS.surfaces]: seed.surfaces } : {}),
        [TUTORIAL_FIELD_KEYS.phases]: seed.phases,
        ...(existingCustomizedAt ? { customizedAt: existingCustomizedAt } : {}),
      },
    });
  }
  return { created, updated, skipped };
}

/**
 * How many tutorials this workspace has made EDITABLE (i.e. kernel rows).
 *
 * Zero is the normal, healthy state: the reader serves the shipped library from
 * the seed floor. A non-zero count means the workspace has taken ownership of
 * that many tutorials and can edit/localize them.
 *
 * Returns 0 rather than throwing when the kernel is off — the count is a
 * display value on `/example-data`, and an unavailable kernel is "none here",
 * not an error page.
 */
export async function countTutorialRows(tenantId: string): Promise<number> {
  try {
    return (await listSystemEntities(tenantId, TUTORIAL_TYPE)).length;
  } catch {
    return 0;
  }
}

/**
 * Drop this workspace's tutorial rows — i.e. REVERT TO SHIPPED.
 *
 * This is not destructive in the way "clear" usually implies: the tutorials
 * themselves never disappear, because the reader floors to the in-repo seeds.
 * What is discarded is the workspace's own edits and locale overlays. The
 * `/example-data` copy says exactly that, so nobody clears expecting a tidy-up
 * and loses authored content silently.
 */
export async function clearTutorialRows(tenantId: string): Promise<{ cleared: number }> {
  let cleared = 0;
  try {
    for (const rec of await listSystemEntities(tenantId, TUTORIAL_TYPE)) {
      const slug = typeof rec.values?.slug === 'string' ? rec.values.slug : null;
      if (slug && (await deleteSystemEntity({ tenantId, typeName: TUTORIAL_TYPE, entityId: slug }))) cleared += 1;
    }
  } catch (err) {
    warnThrottled('clear', err);
  }
  return { cleared };
}
