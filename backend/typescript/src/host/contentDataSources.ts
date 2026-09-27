/**
 * Core content-section data-source registry (ADR 0407 D3 — the registry
 * inversion). A FEATURE registers a server-side resolver for a referenced CMS
 * section type (e.g. `entityList`/`entityDetail`); the PUBLISHING feature's
 * crawler prerenderer consumes it — features never import each other, the
 * registry mediates (the `registerFieldKindValidator` / `registerSubmissionSink`
 * / `registerConfigDomain` precedent).
 *
 * Why it exists: entity-backed sections reference live content that is NOT
 * embedded in the page (unlike every prior section type), so a crawler that
 * only saw the section's chrome would miss the SEO-valuable content (events,
 * job postings, team rosters). A resolver lets the prerenderer emit that
 * content server-side AND a JSON-LD `ItemList`.
 *
 * No-cloaking is an INVARIANT here, guaranteed by construction: a resolver MUST
 * return only what the section's own ANONYMOUS public read returns (published +
 * public-read + live rows) — the entities resolver calls the SAME
 * `readPublicEntities` gate the public route calls, so a crawler can never see
 * a draft or non-public row. The correct cloaking anchor for REFERENCED content
 * is the referenced store's public read, not the page projection.
 *
 * Core-pure: imports nothing under `features/` (guard-tested).
 */

/** One resolved item — render-agnostic (publishing turns it into HTML/JSON-LD). */
export interface ResolvedContentItem {
  title: string;
  body?: string;
  /** An optional followable canonical URL. **Nothing populates or reads this
   *  today** — see ADR 0407 ("`entityDetail` slug-binding is DEFERRED with
   *  cause"): entities have no public page routes to bind a slug against, and
   *  no emitter consumes the field either (`prerenderService`'s ListItem omits
   *  `url`). ADR 0653 plans both halves; they are useless apart — addressability
   *  with no emitted link is a page nothing points at, and an emitted link with
   *  no route is a 404. */
  href?: string;
}

export interface ResolvedContentSection {
  items: ResolvedContentItem[];
}

/** Context the prerenderer passes: the page's tenant + negotiated locale. */
export interface ContentResolveContext {
  /** The tenant of the page being prerendered (best-effort — a resolver MAY
   *  enforce same-tenant; the entities resolver relies on the public-read gate
   *  instead, so this is informational). */
  pageTenantId?: string;
  /** The page's negotiated locale, so referenced values resolve to it. */
  locale?: string;
}

export type ContentSectionResolver = (
  data: Record<string, unknown>,
  ctx: ContentResolveContext,
) => Promise<ResolvedContentSection | null>;

/**
 * ADR 0641 decision 8 — a section type MAY declare itself ESSENTIAL.
 *
 * The default (`essential: false`) is the long-standing behaviour and is right
 * for marketing: a resolver fault degrades to the section's chrome, and a page
 * with one hollow band is better than a 500.
 *
 * For an ACQUISITION page it is the wrong answer, and the severity is that
 * **every check we have passes**. The route 200s, the prerender emits a
 * well-formed document, the section chrome is intact, the hosting-rewrite gate
 * is satisfied, deploy verification is satisfied — and the indexed page lists
 * zero challenges. The only signal is a business metric nobody is watching yet.
 *
 * Stated as an invariant rather than a preference so it generalises past this
 * one section: **an essential section that resolves EMPTY must fail the
 * prerender for that page rather than degrade to chrome.** An absent page is a
 * 404 someone notices; a hollow indexed one is a slow leak with no detector.
 *
 * Same principle the deploy path already applies by shipping a provenance field
 * ABSENT rather than stale — this codebase prefers a loud gap to a quiet lie.
 */
export interface ContentSectionResolverOptions {
  /** Default false. When true, an error OR an empty result throws
   *  `EssentialSectionUnresolved` instead of returning null. */
  essential?: boolean;
}

/** Thrown by `resolveContentSection` when an ESSENTIAL section cannot be
 *  resolved, or resolves to zero items. Callers that prerender a page MUST let
 *  this fail the page — catching it and continuing rebuilds the exact
 *  degradation the essential flag exists to prevent. */
export class EssentialSectionUnresolved extends Error {
  readonly sectionType: string;
  readonly reason: 'threw' | 'declined' | 'empty';
  constructor(sectionType: string, reason: 'threw' | 'declined' | 'empty', cause?: unknown) {
    super(
      `essential content section '${sectionType}' ${reason === 'empty' ? 'resolved to zero items' : reason === 'declined' ? 'declined to resolve' : 'threw'} — ` +
        'refusing to prerender a page whose essential content is absent (ADR 0641 decision 8). ' +
        'A hollow indexed document passes every other check we have.',
    );
    this.name = 'EssentialSectionUnresolved';
    this.sectionType = sectionType;
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

const registry = new Map<string, ContentSectionResolver>();
const essentialTypes = new Set<string>();

/** Register a resolver for a section type (one per type; features register at init). */
export function registerContentSectionResolver(
  sectionType: string,
  resolver: ContentSectionResolver,
  options: ContentSectionResolverOptions = {},
): void {
  const existing = registry.get(sectionType);
  if (existing !== undefined) {
    // Features register on EVERY createApp (feature.ts activation), and a test
    // process creates the app more than once, so the SAME resolver arriving
    // again is idempotent — the sibling hostSurfaceRegistry treats it the same
    // way. A DIFFERENT resolver for the same type is the collision this guard
    // exists for and still throws (two features claiming one section type
    // would silently shadow each other otherwise). #3730 threw on both and
    // reddened 23 backend test files on main.
    if (existing === resolver) {
      if (options.essential === true) essentialTypes.add(sectionType);
      return;
    }
    throw new Error(`content-section resolver for '${sectionType}' is already registered by a different resolver`);
  }
  registry.set(sectionType, resolver);
  if (options.essential === true) essentialTypes.add(sectionType);
}

/** Whether a section type has declared itself essential (ADR 0641 d8). */
export function isEssentialSectionType(sectionType: string): boolean {
  return essentialTypes.has(sectionType);
}

/** Resolve a section, or null when no resolver is registered or it declines
 *  (the prerenderer then renders the section's chrome only — the honest
 *  degradation).
 *
 *  Throws ONLY for a type registered `essential: true`. Every existing caller
 *  and every existing section type keeps the never-throws contract unchanged —
 *  this is additive, and opt-in at REGISTRATION rather than at the call site, so
 *  a resolver's author decides rather than each consumer remembering. */
export async function resolveContentSection(
  sectionType: string,
  data: Record<string, unknown>,
  ctx: ContentResolveContext,
): Promise<ResolvedContentSection | null> {
  const essential = essentialTypes.has(sectionType);
  const resolver = registry.get(sectionType);
  if (!resolver) {
    // An essential type with NO resolver is a wiring fault, not a content fault
    // — and it is the likeliest way this invariant would be defeated in
    // practice (a feature excluded from a distribution, its registration never
    // running, the section still on the page).
    if (essential) throw new EssentialSectionUnresolved(sectionType, 'declined');
    return null;
  }
  let out: ResolvedContentSection | null;
  try {
    out = await resolver(data, ctx);
  } catch (e) {
    if (essential) throw new EssentialSectionUnresolved(sectionType, 'threw', e);
    return null; // degrade to chrome, never fail the whole prerender
  }
  if (essential && (out === null || out.items.length === 0)) {
    // EMPTY is the case the flag exists for. A resolver that returns `{items: []}`
    // has not failed by any ordinary measure — which is exactly why the hollow
    // page ships.
    throw new EssentialSectionUnresolved(sectionType, out === null ? 'declined' : 'empty');
  }
  return out;
}

export function hasContentSectionResolver(sectionType: string): boolean {
  return registry.has(sectionType);
}

/** Test-only: clear the registry (production never calls this). */
export function __clearContentSectionResolvers(): void {
  registry.clear();
}
