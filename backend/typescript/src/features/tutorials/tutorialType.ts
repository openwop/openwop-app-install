/**
 * ADR 0488 D1 — the `tutorials.lesson` SYSTEM TYPE in the entities content kernel.
 *
 * WHY THE KERNEL AND NOT THE CMS (the decision an `/architect` pass overturned):
 * ADR 0408 Phase C made the entities engine "the app's single content store"; the
 * CMS is a FAÇADE over it that owns **pages** specifically (slugs, redirects,
 * publish sweep, page experiments). A tutorial is not a page. So this mints its
 * own system type directly, exactly as `cms.page` (`cmsService.ts:213`), commerce
 * products (`commerceService.ts:305`) and CRM deals (`crm/entities/deals.ts:80`)
 * do. No CMS dependency, no second content path.
 *
 * The type name keeps the `.lesson` suffix ONLY because `mintSystemType` requires
 * a dotted feature-scoped slug and the `tutorials.` prefix disambiguates it from
 * `kicktodo-creator`'s unrelated "lessons". No product surface ever says "lesson"
 * — the user-facing noun is **Tutorial** (ADR 0488 §boundaries audit).
 *
 * The `localizable` flags below make these fields ELIGIBLE for ADR 0406 D1's
 * sparse per-locale overlays. `run` bindings are deliberately NOT localizable —
 * a chain id is an identifier, not copy.
 *
 * §Correction (grade-data `LOC-1`): an earlier version of this comment claimed
 * localization was "FREE here" and that it "closes ADR 0490's long-standing
 * content-localization follow-on". It does not, and that claim was retracted
 * rather than quietly edited. Eligibility is not delivery — BOTH ends are still
 * missing: nothing writes an overlay (tutorials ships no tenant write path at
 * all), and nothing reads one back (`listSystemEntities`/`getSystemEntity` take
 * no locale and return raw `values`; the kernel's `resolveLocalizedValues`
 * resolver has three callers and tutorials is not among them). Tutorial CONTENT
 * is English-only today — as `i18n/pt-BR.ts` already states honestly — and
 * ADR 0490's content-localization follow-on remains OPEN.
 */

/** The system type name. Dotted + feature-scoped, per `SYSTEM_NAME_RE`. */
export const TUTORIAL_TYPE = 'tutorials.lesson';

/**
 * ADR 0488 D1 §Correction (grade-data `TUT-1`) — THE FIELD TYPES MUST COME FROM
 * THE KERNEL'S CLOSED VOCABULARY.
 *
 * As first written, this table declared `select`, `text` and `json` field types
 * and `mintSystemType` was called with no `extensionKinds`. None of those three
 * is a built-in kind (`FieldType` = string|number|boolean|date|enum|reference|media,
 * `host/customFields/index.ts:18`), so `buildFieldSpec` threw on the FOURTH field
 * and the mint failed on every call — `tutorials.lesson` was never created in any
 * workspace, which made the whole kernel lane (tenant-editable + localizable +
 * AI-authorable content) dead code behind a seed floor that quietly served the
 * shipped copy instead. The unit suite mocked the kernel wholesale, so it stayed
 * green; a real-kernel test (`tutorials-kernel-mint.test.ts`) now pins the mint.
 *
 * The corrections, each forced by a specific validator rule:
 *  - `select` → **`enum`**, and `options` must be a flat `string[]`
 *    (`cleanEnumOptions`, `:104`) — the `{value,label}` objects were rejected.
 *    No copy is lost: the reader owns category/difficulty labels.
 *  - `text` → **`string`**. `localizable` is valid ONLY on a `string` field
 *    (`:145-147`), so `goal` was doubly invalid.
 *  - `json` → the registered **`tutorial-doc`** extension kind (ADR 0408 D2),
 *    declared by the mint via `extensionKinds` exactly as `cms.page` declares
 *    `blocks`. Extension kinds are opt-in PER CALLER, so this widens nothing for
 *    user-facing authoring paths.
 *  - `name:` → **`label:`** — `buildFieldSpec` reads `label` (`:140`); every
 *    display name here was being silently discarded and defaulted to the key.
 *  - `indexed`/`searchable`/`filterable` REMOVED: `buildFieldSpec` returns a
 *    `FieldSpec` that has no such properties, so they never did anything. They
 *    are dropped rather than left implying behaviour that does not exist.
 *
 * The nested `phases` array (phases → steps → content blocks → `run` bindings)
 * rides ONE structured field rather than a field-per-level: the kernel's field
 * model is flat, and the renderer already owns the shape via the shared
 * `TutorialData` contract. This mirrors how `cms.page` carries `sections`.
 */

/** The ADR 0408 D2 extension kind carrying tutorials' structured (non-scalar)
 *  fields. Registered with a bounded structural validator in `tutorialsService`
 *  and declared by the mint — never added to the built-in vocabulary. */
export const TUTORIAL_DOC_KIND = 'tutorial-doc';

export const TUTORIAL_FIELDS = [
  { key: 'slug', label: 'Slug', type: 'string', required: true },
  { key: 'title', label: 'Title', type: 'string', required: true, localizable: true },
  { key: 'description', label: 'Description', type: 'string', required: true, localizable: true },
  { key: 'category', label: 'Category', type: 'enum', required: true,
    options: ['getting-started', 'build', 'marketing', 'commerce'] },
  { key: 'difficulty', label: 'Difficulty', type: 'enum',
    options: ['beginner', 'intermediate', 'advanced'] },
  { key: 'estimated_minutes', label: 'Estimated Minutes', type: 'number' },
  { key: 'hero_title', label: 'Hero Title', type: 'string', localizable: true },
  { key: 'hero_subtitle', label: 'Hero Subtitle', type: 'string', localizable: true },
  { key: 'goal', label: 'Goal', type: 'string', localizable: true },
  { key: 'learning_objectives', label: 'Learning Objectives', type: TUTORIAL_DOC_KIND },
  { key: 'prerequisites', label: 'Prerequisites', type: TUTORIAL_DOC_KIND },
  /** ADR 0488 D7 — routes this tutorial teaches, for the contextual
   *  "Teach me this" affordance. Identifiers, never copy ⇒ not localizable. */
  { key: 'surfaces', label: 'Surfaces', type: TUTORIAL_DOC_KIND },
  /** ADR 0488 §4.3 — an example-data seed id to offer before driving, so a
   *  tutorial never teaches against an empty workspace. */
  { key: 'requires_seed', label: 'Requires Seed', type: 'string' },
  /** The phases → steps → content blocks → `run:{chainId,nodeId}` bindings. */
  { key: 'phases', label: 'Phases', type: TUTORIAL_DOC_KIND, required: true },
  /** Code-owned (ADR 0488 D3). NEVER edited through a tenant surface: the
   *  seeder compares it to decide whether to refresh an un-customized row. */
  { key: 'seed_version', label: 'Seed Version', type: 'string' },
] as const;

/**
 * §Correction (grade-data `TUT-1`, second layer) — FIELD KEYS ARE SNAKE_CASE
 * because the kernel NORMALIZES them: `buildFieldSpec` lowercases and replaces
 * every non-`[a-z0-9_]` character (`host/customFields/index.ts:130`). A
 * camelCase key silently becomes `estimatedminutes` at mint time while the
 * writer keeps sending `estimatedMinutes`, so the write fails closed with
 * "Unknown custom field" — a defect that only appears once the mint itself
 * works, and so was hidden behind the type failure above. `cms.page` already
 * uses snake_case (`org_id`, `workflow_status`) for exactly this reason.
 *
 * The keys are therefore part of the STORAGE contract, not free-form, and the
 * service maps them explicitly in both directions rather than relying on the
 * in-memory shape happening to match.
 */
export const TUTORIAL_FIELD_KEYS = {
  slug: 'slug',
  title: 'title',
  description: 'description',
  category: 'category',
  difficulty: 'difficulty',
  estimatedMinutes: 'estimated_minutes',
  heroTitle: 'hero_title',
  heroSubtitle: 'hero_subtitle',
  goal: 'goal',
  learningObjectives: 'learning_objectives',
  prerequisites: 'prerequisites',
  surfaces: 'surfaces',
  requiresSeed: 'requires_seed',
  phases: 'phases',
  seedVersion: 'seed_version',
} as const;

/** Localizable field keys — the ONLY keys an ADR 0406 overlay may carry. */
export const TUTORIAL_LOCALIZABLE_KEYS: readonly string[] = TUTORIAL_FIELDS
  .filter((f): f is typeof f & { localizable: true } => 'localizable' in f && f.localizable === true)
  .map((f) => f.key);
