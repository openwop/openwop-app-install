/**
 * CMS API client (ADR 0009). Org-scoped under /host/openwop-app/cms/orgs/:orgId.
 * Section assets are Media-Library tokens (the editor offers the org's media
 * assets via `listMediaAssets`).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }

/**
 * The reserved system-site org id (ADR 0027). The public front page is a real
 * CMS page living here; a super admin edits it through the standard CMS routes
 * (the backend's `requireCmsScope` grants host authority for this one org). It's
 * a well-known, non-secret id — it appears in the public page URL
 * (`/public/host-site/pages/home`) — so the SPA may reference it directly.
 */
export { SYSTEM_SITE_ORG } from './siteOrg.js';
export type PageStatus = 'draft' | 'in_review' | 'published' | 'archived';
export const PAGE_STATUSES: readonly PageStatus[] = ['draft', 'in_review', 'published', 'archived'];
export type SectionType = 'hero' | 'richText' | 'image' | 'cta' | 'columns' | 'productGrid' | 'form' | 'pricing' | 'entityList' | 'entityDetail' | 'comparison' | 'faq' | 'quotes' | 'fields';
// The `comparison` matrix (ADR 0485) is HOST-AUTHORED (seeded via code), not built
// through the visual editor — so it is a member of the type union (the renderer
// handles it) but deliberately absent from the editor's add-section picker below.
// `fields` (ADR 0748) is the same: created through the RFC 0103 content API,
// editable here once it exists, not offered as a blank block.
export const SECTION_TYPES: readonly SectionType[] = ['hero', 'richText', 'image', 'cta', 'columns', 'productGrid', 'form', 'pricing', 'entityList', 'entityDetail', 'faq', 'quotes'];
export interface Section {
  sectionId: string;
  type: SectionType;
  data: Record<string, unknown>;
  /** Sparse per-locale overrides (RFC 0103 / ADR 0064); absent on non-localized sections. */
  localizations?: Record<string, Record<string, unknown>>;
  /** Shared-section reference (ADR 0204 C4) — the section inherits the shared
   *  content at delivery; its own data stays empty until detached. */
  ref?: { sharedSectionId: string };
  /** ADR 0592 §3 — AI-authorship provenance: locale → ISO instant the overlay
   *  was machine-drafted. Absent = human-authored (or a pre-fix row — no
   *  backfill). Cleared when a human edits the overlay. */
  aiDrafted?: Record<string, string>;
}

/** A reusable org-owned section pages inherit by reference (ADR 0204 C4). */
export interface SharedSection {
  sharedSectionId: string;
  name: string;
  type: SectionType;
  data: Record<string, unknown>;
  localizations?: Record<string, Record<string, unknown>>;
  version: number;
  updatedAt: string;
}

/** Per-org content-locale settings (ADR 0064). Invariant: baseLocale ∉ supportedLocales. */
export interface LanguageSettings {
  baseLocale: string;
  supportedLocales: string[];
  autoTranslateOnPublish: boolean;
}
export interface Page {
  pageId: string;
  title: string;
  slug: string;
  status: PageStatus;
  sections: Section[];
  /** Editor-facing labels for list filtering (ADR 0206 B3). */
  tags?: string[];
  /** One-shot scheduled publish time (ISO, ADR 0204 C2); absent when none. */
  scheduledPublishAt?: string;
  scheduledUnpublishAt?: string;
  /** Per-locale publish state (ADR 0205 D2) — absent key = published with the
   *  page; 'draft' = withheld from delivery (falls back per RFC 0103). */
  localePublishState?: Record<string, 'draft' | 'published'>;
  version: number;
  publishedVersion?: number;
  updatedAt: string;
}

/** A translator's locale grant (ADR 0205 D1) — narrows the member's CMS write
 *  to the granted locales' overlays. */
export interface CmsLocaleGrant { subject: string; locales: string[]; updatedAt: string }
/** A content capture (one per DISTINCT content version — ADR 0206 B1).
 *  `publishedAt/publishedBy` read as capturedAt/capturedBy (names kept for
 *  stored-row compatibility). */
export interface PageVersion {
  versionId: string;
  version: number;
  snapshot: { title: string; slug: string; sections: Section[] };
  publishedAt: string;
  publishedBy: string;
}
/** Per-locale counts of AI-drafted overlays a submit produced (ADR 0064
 *  amendment — autoTranslateOnPublish). Absent when nothing was drafted. */
export type AutoTranslated = Record<string, number>;
/** ADR 0592 §9 (CMSL-5) — how the submit-time sweep DEGRADED, when it did:
 *  call cap hit / provider failed mid-sweep / N unusable translations. Absent
 *  = the sweep completed (or never ran). */
export interface AutoTranslateDegraded { capped?: boolean; errored?: boolean; invalid?: number; conflict?: boolean }
export interface MediaAssetRef { assetId: string; name: string; serveUrl: string; serveToken?: string }
export type WorkflowAction = 'submit' | 'approve' | 'reject' | 'publish' | 'archive' | 'unpublish';

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/**
 * ADR 0592 §1/§6 — a typed API error carrying the backend envelope's stable
 * `error` CODE + `details`, not only the English `message`. Callers branch on
 * `code` (machine-stable, locale-independent) and keep `message` as the raw
 * detail — never the other way round (the `/not enabled/i` regex family this
 * replaces broke the moment the envelope localized).
 */
export class CmsApiError extends Error {
  constructor(
    message: string,
    /** The envelope's stable error code (`conflict`, `not_found`, …) or null when the body was not an envelope. */
    public readonly code: string | null,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CmsApiError';
  }
}

/**
 * ADR 0592 §6 (CMSLU-7) — map a KNOWN backend error CODE to a cms-namespace
 * i18n key (+ interpolation options), so the primary error surface speaks the
 * user's language and survives envelope localization. Conservative on
 * purpose: codes whose raw `message` carries load-bearing specificity a
 * generic string would DESTROY (validation details, the approval-gate 409
 * explanation) return null and keep the raw message. The one specificity this
 * RESTORES is the translator grant denial: `details.grantedLocales` rebuilds
 * the which-locales message that `localizeErrorEnvelope` flattens.
 */
export function cmsErrorInfo(e: unknown): { key: string; options?: Record<string, unknown> } | null {
  if (!(e instanceof CmsApiError) || !e.code) return null;
  switch (e.code) {
    case 'not_found':
      // The toggle-gate 404 (`requireFeatureEnabled` stamps details.feature) —
      // the case the old English `/not enabled/i` regex tried to catch and
      // lost the moment the envelope localized.
      return e.details?.feature === 'cms-localization' ? { key: 'langNotEnabled' } : null;
    case 'forbidden_scope': {
      const granted = e.details?.grantedLocales;
      return Array.isArray(granted) && granted.length > 0
        ? { key: 'errTranslatorScope', options: { locales: granted.join(', ') } }
        : { key: 'errForbidden' };
    }
    case 'host_capability_missing':
      return { key: 'translateUnavailable' };
    case 'translation_invalid':
      // ADR 0592 §7 — unusable model output after the bounded repair.
      return { key: 'translateInvalid' };
    default:
      return null;
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let code: string | null = null;
    let detail = '';
    let details: Record<string, unknown> | undefined;
    try {
      const body = (await res.json()) as { error?: unknown; message?: unknown; details?: unknown };
      if (typeof body?.error === 'string') code = body.error;
      if (typeof body?.message === 'string') detail = body.message;
      if (body?.details && typeof body.details === 'object') details = body.details as Record<string, unknown>;
    } catch { /* non-JSON */ }
    throw new CmsApiError(detail || `${ctx} returned ${res.status}`, code, res.status, details);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const base = (orgId: string): string => `${root}/cms/orgs/${encodeURIComponent(orgId)}`;

export interface PageListFilter { q?: string; tag?: string; status?: PageStatus }

export async function listPages(orgId: string, filter: PageListFilter = {}): Promise<Page[]> {
  const params = new URLSearchParams();
  if (filter.q) params.set('q', filter.q);
  if (filter.tag) params.set('tag', filter.tag);
  if (filter.status) params.set('status', filter.status);
  const qs = params.toString();
  const res = await fetch(`${base(orgId)}/pages${qs ? `?${qs}` : ''}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ pages: Page[] }>(res, 'listPages')).pages;
}
export async function getPage(orgId: string, pageId: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<Page>(res, 'getPage');
}
/**
 * CMS-R2-3 — the AUTHORIZED by-slug read, used by the public page's
 * "Edit this page" affordance as BOTH the permission probe and the pageId
 * lookup: the route is org-RBAC'd (`workspace:read`), so a 200 proves the
 * caller can reach this page in the CMS, and a 403/404 proves they cannot.
 *
 * Returns null on ANY non-200 — this is an enrichment probe, so absence
 * renders NO affordance and makes NO claim (never an error surface).
 */
export async function getAuthoredPageBySlug(orgId: string, slug: string): Promise<Page | null> {
  try {
    const res = await fetch(`${base(orgId)}/pages/by-slug/${encodeURIComponent(slug)}`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return null;
    const body = (await res.json()) as { page?: Page };
    return body.page ?? null;
  } catch {
    return null;
  }
}

export async function createPage(orgId: string, title: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ title }) }));
  return asJson<Page>(res, 'createPage');
}
/** ADR 0592 §1 — `expectedVersion` is the optimistic-concurrency pin (the
 *  loaded `Page.version`). The editor ALWAYS sends it; a stale pin 409s with
 *  code `conflict` + `{currentVersion, expectedVersion}` instead of silently
 *  clobbering a sibling writer's locale overlays. */
export async function savePage(orgId: string, pageId: string, patch: { title?: string; slug?: string; sections?: Section[]; tags?: string[]; expectedVersion?: number }): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Page>(res, 'savePage');
}
export async function deletePage(orgId: string, pageId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deletePage');
}
/** ADR 0593 (CMSA-9) — `note` is the reviewer's reason on a `reject`. The CMS
 *  header lane sent no body at all while the inbox lane persisted one, so the
 *  two decide surfaces recorded different things for the same decision. */
export async function transition(orgId: string, pageId: string, action: WorkflowAction, note?: string): Promise<Page & { autoTranslated?: AutoTranslated; autoTranslateDegraded?: AutoTranslateDegraded }> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/${action}`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(note ? { note } : {}) }));
  return asJson<Page & { autoTranslated?: AutoTranslated; autoTranslateDegraded?: AutoTranslateDegraded }>(res, action);
}
/**
 * ADR 0593 D4 (CMSAU-5) — the page's LATEST editorial review outcome.
 *
 * The submitter's half of the gate had no surface at all: a rejection notified
 * nobody, and the page silently read `draft` — indistinguishable from
 * never-submitted — while `note` / `decidedBy` / `resolvedAt` sat on the
 * resolved row with zero readers. Returns null when the page was never
 * submitted. Enrichment only: any failure yields null and renders nothing,
 * never an error surface over the editor.
 */
export interface PageReview {
  approvalId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
  decidedBy?: string;
  note?: string;
  pageVersion?: number;
  aiDraftedLocales?: string[];
}
export async function getPageReview(orgId: string, pageId: string): Promise<PageReview | null> {
  try {
    const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/review`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return null;
    return ((await res.json()) as { review: PageReview | null }).review;
  } catch {
    return null;
  }
}

export async function listVersions(orgId: string, pageId: string): Promise<PageVersion[]> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/versions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ versions: PageVersion[] }>(res, 'listVersions')).versions;
}
export async function restoreVersion(orgId: string, pageId: string, versionId: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/restore/${encodeURIComponent(versionId)}`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<Page>(res, 'restoreVersion');
}

// ── Scheduled publishing (ADR 0204 C2) ──────────────────────────────────────
export async function schedulePublish(orgId: string, pageId: string, at: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/schedule`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ at }) }));
  return asJson<Page>(res, 'schedulePublish');
}
export async function cancelSchedule(orgId: string, pageId: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/schedule`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return asJson<Page>(res, 'cancelSchedule');
}
export async function scheduleUnpublish(orgId: string, pageId: string, at: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/schedule-unpublish`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ at }) }));
  return asJson<Page>(res, 'scheduleUnpublish');
}
export async function cancelScheduleUnpublish(orgId: string, pageId: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/schedule-unpublish`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return asJson<Page>(res, 'cancelScheduleUnpublish');
}

// ── Translator locale grants (ADR 0205 D1) ──────────────────────────────────
/**
 * Admin-tier list. Returns **`null` for exactly one condition** — a 403, meaning
 * the caller may not manage locale grants — and **throws** on everything else.
 *
 * The panel's comment already claimed this distinction ("a 403 (non-admin) keeps
 * `grants` null and the panel hidden"), but `asJson` throws a plain Error with no
 * status, so the caller could not tell 403 from 500 and hid the panel for both.
 * An admin whose read merely failed was shown the same thing as a non-admin:
 * nothing, which reads as "you don't have permission". Same `null`-means-one-
 * thing contract as `memoryExtractionClient.getExtractionGrant`.
 */
export async function listLocaleGrants(orgId: string): Promise<CmsLocaleGrant[] | null> {
  const res = await fetch(`${base(orgId)}/locale-grants`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 403) return null;
  return (await asJson<{ grants: CmsLocaleGrant[] }>(res, 'listLocaleGrants')).grants;
}
/** ADR 0592 §2 — the CALLER's own translator grant (workspace:read, self-
 *  scoped, NOT toggle-gated). `null` = no grant. The translator surface's
 *  visibility probe. */
export async function getMyLocaleGrant(orgId: string): Promise<CmsLocaleGrant | null> {
  const res = await fetch(`${base(orgId)}/locale-grants/mine`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ grant: CmsLocaleGrant | null }>(res, 'getMyLocaleGrant')).grant;
}
/** Empty `locales` removes the grant. */
export async function putLocaleGrant(orgId: string, subject: string, locales: string[]): Promise<CmsLocaleGrant | null> {
  const res = await fetch(`${base(orgId)}/locale-grants`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ subject, locales }) }));
  return (await asJson<{ grant: CmsLocaleGrant | null }>(res, 'putLocaleGrant')).grant;
}

// ── Per-locale publish state (ADR 0205 D2) ──────────────────────────────────
export async function setLocalePublish(orgId: string, pageId: string, locale: string, state: 'published' | 'draft'): Promise<Page> {
  const verb = state === 'published' ? 'publish' : 'unpublish';
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/locales/${encodeURIComponent(locale)}/${verb}`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<Page>(res, 'setLocalePublish');
}

// ── Shared sections (ADR 0204 C4) ───────────────────────────────────────────
export async function listSharedSections(orgId: string): Promise<SharedSection[]> {
  const res = await fetch(`${base(orgId)}/shared-sections`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ sharedSections: SharedSection[] }>(res, 'listSharedSections')).sharedSections;
}
export async function createSharedSection(orgId: string, input: { name: string; type: SectionType; data: Record<string, unknown>; localizations?: Record<string, Record<string, unknown>> }): Promise<SharedSection> {
  const res = await fetch(`${base(orgId)}/shared-sections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<SharedSection>(res, 'createSharedSection');
}
export async function updateSharedSection(orgId: string, sharedSectionId: string, patch: { name?: string; data?: Record<string, unknown>; localizations?: Record<string, Record<string, unknown>> }): Promise<SharedSection> {
  const res = await fetch(`${base(orgId)}/shared-sections/${encodeURIComponent(sharedSectionId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<SharedSection>(res, 'updateSharedSection');
}
export async function deleteSharedSection(orgId: string, sharedSectionId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/shared-sections/${encodeURIComponent(sharedSectionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson<unknown>(res, 'deleteSharedSection');
}
/** Pages referencing a shared section — the "impacted pages" list an editor
 *  sees BEFORE changing shared content. */
export async function listSharedSectionPages(orgId: string, sharedSectionId: string): Promise<Array<{ pageId: string; title: string; slug: string; status: PageStatus }>> {
  const res = await fetch(`${base(orgId)}/shared-sections/${encodeURIComponent(sharedSectionId)}/pages`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ pages: Array<{ pageId: string; title: string; slug: string; status: PageStatus }> }>(res, 'listSharedSectionPages')).pages;
}

/** Translate a section's base data into a target locale (ADR 0064 Phase 3) via
 *  the managed provider. Returns the sanitized draft overlay to review before
 *  saving. Throws if translation is unavailable (managed provider not
 *  configured / capped) — the caller degrades to manual editing. */
export async function translateSection(
  orgId: string,
  input: { sectionType: SectionType; data: Record<string, unknown>; targetLocale: string },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(orgId)}/translate-section`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ overlay: Record<string, unknown> }>(res, 'translateSection')).overlay;
}

/** Content-locale settings for the org (ADR 0064). GET is always available
 *  (returns a default skeleton); PUT requires the `cms-localization` toggle +
 *  the admin tier. */
export async function getLanguageSettings(orgId: string): Promise<LanguageSettings> {
  const res = await fetch(`${base(orgId)}/language-settings`, fetchOpts({ headers: authedHeaders() }));
  return asJson<LanguageSettings>(res, 'getLanguageSettings');
}
export async function putLanguageSettings(
  orgId: string,
  patch: { baseLocale?: string; supportedLocales?: string[]; autoTranslateOnPublish?: boolean },
): Promise<LanguageSettings> {
  const res = await fetch(`${base(orgId)}/language-settings`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<LanguageSettings>(res, 'putLanguageSettings');
}

// ── Page experiments (ADR 0236 — campaign gap D1) ───────────────────────────
export type ExperimentStatus = 'draft' | 'running' | 'stopped' | 'promoted';
export interface ExperimentVariant {
  key: string;
  /** A PageVersion id, or null = the holdout (live published content). */
  versionId: string | null;
  weight: number;
}
export interface PageExperiment {
  experimentId: string;
  pageId: string;
  name: string;
  status: ExperimentStatus;
  variants: ExperimentVariant[];
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
}
export interface ExperimentVariantResult {
  key: string;
  versionId: string | null;
  weight: number;
  sessions: number;
  conversions: number;
  conversionRate: number;
  zScore: number | null;
  significant: boolean | null;
  insufficientSample: boolean;
}
export interface ExperimentResults {
  experimentId: string;
  status: ExperimentStatus;
  baselineKey: string;
  minSessionsPerVariant: number;
  variants: ExperimentVariantResult[];
  /** ANL-UX-29 / ANL-18 — stamps this projection did NOT count: `legacy` = rows
   *  stamped before stamps were server-derived (ADR 0651 D3), `dropped` = rows whose
   *  stamp was refused at ingest (stopped/unknown experiment, no session). */
  unattributed?: { legacy: number; dropped: number };
}
export interface PromoteResult { experiment: PageExperiment; pendingApproval: boolean; page: Page | null }

const expBase = (orgId: string, pageId: string): string => `${base(orgId)}/pages/${encodeURIComponent(pageId)}/experiments`;

export async function listExperiments(orgId: string, pageId: string): Promise<PageExperiment[]> {
  const res = await fetch(expBase(orgId, pageId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ experiments: PageExperiment[] }>(res, 'listExperiments')).experiments;
}
export async function createExperiment(orgId: string, pageId: string, input: { name: string; variants: ExperimentVariant[] }): Promise<PageExperiment> {
  const res = await fetch(expBase(orgId, pageId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<PageExperiment>(res, 'createExperiment');
}
export async function deleteExperiment(orgId: string, pageId: string, experimentId: string): Promise<void> {
  const res = await fetch(`${expBase(orgId, pageId)}/${encodeURIComponent(experimentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson<unknown>(res, 'deleteExperiment');
}
export async function startExperiment(orgId: string, pageId: string, experimentId: string): Promise<PageExperiment> {
  const res = await fetch(`${expBase(orgId, pageId)}/${encodeURIComponent(experimentId)}/start`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<PageExperiment>(res, 'startExperiment');
}
export async function stopExperiment(orgId: string, pageId: string, experimentId: string): Promise<PageExperiment> {
  const res = await fetch(`${expBase(orgId, pageId)}/${encodeURIComponent(experimentId)}/stop`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<PageExperiment>(res, 'stopExperiment');
}
export async function promoteExperiment(orgId: string, pageId: string, experimentId: string, variantKey: string): Promise<PromoteResult> {
  const res = await fetch(`${expBase(orgId, pageId)}/${encodeURIComponent(experimentId)}/promote`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ variantKey }) }));
  return asJson<PromoteResult>(res, 'promoteExperiment');
}
export async function experimentResults(orgId: string, pageId: string, experimentId: string): Promise<ExperimentResults> {
  const res = await fetch(`${expBase(orgId, pageId)}/${encodeURIComponent(experimentId)}/results`, fetchOpts({ headers: authedHeaders() }));
  return asJson<ExperimentResults>(res, 'experimentResults');
}

// NOTE: the org-asset list for the token picker now comes from the media
// feature's OWN client (`features/media/mediaClient.ts` `listAssets`) — the
// thin duplicate fetch that used to live here was helper-duplication drift
// (ADR 0206 B4 architecture ruling: media owns media browsing/upload).

/** Absolute serve URL for an asset's token (for section image previews). */
export function assetUrl(token: string): string {
  return `${config.baseUrl}/host/openwop-app/assets/${encodeURIComponent(token)}`;
}
