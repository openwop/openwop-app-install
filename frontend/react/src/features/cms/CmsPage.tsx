/**
 * CMS + Page Builder (host-extension product feature — ADR 0009).
 *
 * ALWAYS-ON (ADR 0027 — the `cms` toggle is retired, so it must NOT gate on
 * useFeatureAccess: an absent id resolves to the OFF fallback and bricked every
 * fresh install; /browser 2026-07-03 finding). RBAC stays server-side. An org picker drives a page list + a
 * section-based editor (the core section set), the editorial workflow buttons
 * (the backend enforces who may approve/publish — a wrong-authority click
 * surfaces a 403 toast), and a live preview. Section images are Media-Library
 * tokens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { formatDateTime } from '../../i18n/format.js';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';

import { confirm } from '../../ui/confirm.js';import { Notice } from '../../ui/Notice.js';
import { useCmsOrgAccess } from './useCmsOrgAccess.js';
import { Tabs, TabPanel } from '../../ui/Tabs.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { IconButton } from '../../ui/IconButton.js';
import { Modal } from '../../ui/Modal.js';
import { toast } from '../../ui/toast.js';
import { ArrowLeftIcon, ClockIcon, CopyIcon, FileTextIcon, GlobeIcon, LinkIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, RedoIcon, RotateCwIcon, SaveIcon, SearchIcon, ShieldIcon, SparklesIcon, TrashIcon, UndoIcon, XIcon, ListIcon } from '../../ui/icons/index.js';
import { Menu } from '../../ui/Menu.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { PublicPreviewFrame } from './PublicPreviewFrame.js';
import { useConfirmDiscardUnsaved, useUnsavedChangesWarning } from '../../ui/useUnsavedChangesWarning.js';
import { RenderSections } from './SectionRenderer.js';
import { PageExperimentsPanel } from './PageExperimentsPanel.js';
import { SectionFields, SectionsEditor, localeLabel } from './SectionsEditor.js';
import { CmsCanvas } from './CmsCanvas.js';
import { SectionPicker } from './SectionPicker.js';
import { SectionAiBar } from './SectionAiBar.js';
import { sectionLabel } from './sectionLabel.js';
import { PublishChecklist } from './PublishChecklist.js';
import { publishChecks } from './publishChecks.js';
import { CmsLanguageSettings } from './CmsLanguageSettings.js';
import { A11yIssuesPanel } from '../../a11y/A11yIssuesPanel.js';
import { cmsPageToA11yModel } from './cmsA11y.js';
import { checkContentA11y, type A11yIssue } from '../../a11y/contentA11y.js';
import { diffSections, type SectionDiffEntry } from './sectionDiff.js';
import { resolveSharedRefs } from './resolveSharedRefs.js';
import { resolvePreviewSections } from './resolvePreviewLocale.js';
import { stageComposerDraft } from '../../chat/composerSeed.js';
import { MediaPickerDialog } from '../media/MediaPickerDialog.js';
import { listAssets } from '../media/mediaClient.js';
import { createLink, listLinks, revokeLink, sharedPageUrl, type ShareLink } from '../sharing/sharingClient.js';
import {
  assetUrl,
  cancelSchedule,
  cancelScheduleUnpublish,
  createPage,
  createSharedSection,
  deletePage,
  deleteSharedSection,
  getLanguageSettings,
  getMyLocaleGrant,
  getPage,
  getPageReview,
  type PageReview,
  listOrgs,
  listPages,
  listSharedSectionPages,
  listSharedSections,
  listVersions,
  restoreVersion,
  savePage,
  schedulePublish,
  scheduleUnpublish,
  setLocalePublish,
  getTranslationStatus,
  confirmTranslationSource,
  type PageTranslationStatus,
  transition,
  translateSection,
  updateSharedSection,
  PAGE_STATUSES,
  SYSTEM_SITE_ORG,
  type CmsLocaleGrant,
  type LanguageSettings,
  type MediaAssetRef,
  type Org,
  type Page,
  type PageStatus,
  type PageVersion,
  type Section,
  type SharedSection,
  type WorkflowAction,
  CmsApiError,
  cmsErrorInfo,
} from './cmsClient.js';
import { getSiteConfig, putSiteConfig, invalidateFrontPage, type SiteConfig } from '../site/siteConfigClient.js';
import { getSeo, putSeo, type PageSeo } from '../publishing/publishingClient.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';

/** The CMS localizer agent (vendor.openwop-app.cms.agents) — the ADR 0058/0073 chat
 *  deep-link target ("no second chat system"). */
const CMS_LOCALIZER_AGENT = 'vendor.openwop-app.cms.agents.localizer';

/** The CMS content-editor agent (vendor.openwop-app.cms.agents C6) — reads a page, patches
 *  DRAFT sections, and can submit for review; publishing stays a human action.
 *  Same ADR 0058/0073 chat deep-link target. */
const CMS_CONTENT_EDITOR_AGENT = 'vendor.openwop-app.cms.agents.content-editor';


/** Status → the workflow actions to OFFER (authority is enforced server-side). */
const ACTIONS_FOR: Record<string, WorkflowAction[]> = {
  draft: ['submit', 'publish'],
  // ADR 0593 D3 (CMSAU-3) — `submit` is offered ON `in_review`, because that is
  // the stale-review 409's OWN remedy. The backend deliberately allows a
  // resubmit from `in_review` so an edited in-review page can RE-PIN its
  // approval (`TRANSITIONS.submit` + its CMS2-M1 note); the UI offered only
  // approve/reject, so once a page was edited under review, Approve 409'd
  // forever and the only exit was Reject — a real rejection event and lifecycle
  // webhook nobody intended. A gate whose remedy is unreachable is a gate with
  // no exit; the backend fixed the trap and the UI still set it.
  in_review: ['submit', 'approve', 'reject'],
  published: ['unpublish', 'archive'],
  archived: ['unpublish'],
};

/** The one action that moves a page forward, shown as the primary button. */
const PRIMARY_ACTION: Record<string, WorkflowAction | undefined> = { draft: 'publish', in_review: 'approve' };
/** Workflow actions with the primary one last (rightmost, nearest the eye's end). */
function orderedActions(status: string): WorkflowAction[] {
  const all = ACTIONS_FOR[status] ?? [];
  const primary = PRIMARY_ACTION[status];
  return [...all.filter((a) => a !== primary), ...all.filter((a) => a === primary)];
}

/** Public-preview viewport widths — check a page's responsive breakpoints
 *  without leaving the editor. `desktop` = the stage's full width. */
type PreviewDevice = 'desktop' | 'tablet' | 'mobile';
const DEVICE_MAXW: Record<PreviewDevice, string | undefined> = { desktop: undefined, tablet: '834px', mobile: '390px' };

/** Actions that pass through the review checklist before they run. */
const CHECKED_ACTIONS: ReadonlySet<WorkflowAction> = new Set<WorkflowAction>(['publish', 'approve', 'submit']);

/** How long a draft waits after the last edit before it saves itself. */
const AUTOSAVE_MS = 1500;

/** Page status → a §5.3 chip variant (color is never the sole signal — the
 *  status word rides alongside). */
function statusChipClass(status: string): string {
  switch (status) {
    case 'published': return 'chip chip--success';
    case 'in_review': return 'chip chip--warning';
    case 'archived': return 'chip chip--muted';
    default: return 'chip chip--muted'; // draft
  }
}

/**
 * `translatorSurface` (ADR 0592 §2 / CMSLU-1) — the workspace-tier translator
 * mode: the SAME editor, narrowed to what an ADR 0205 D1 grant actually
 * permits (granted-locale overlays; base content read-only; no structure,
 * workflow, settings, or history affordances). Presentation only — the
 * server's grant narrowing stays the authority, so this mode can never widen
 * access; it only stops rendering controls that could only 403.
 */
/** ADR 0813 — the post facets (kind, category, byline) that differ from the
 *  loaded page. Sent only when changed, so a plain page save never stamps them. */
/** The editor's title/sections/tags/post facets diverge from the saved page.
 *  One predicate for the dirty guard and the save-before-transition step. */
function hasUnsavedEdits(cur: Page | null, base: Page | null): boolean {
  return cur !== null && base !== null &&
    (cur.title !== base.title ||
      cur.slug !== base.slug ||
      JSON.stringify(cur.sections) !== JSON.stringify(base.sections) ||
      JSON.stringify(cur.tags ?? []) !== JSON.stringify(base.tags ?? []) ||
      Object.keys(postFacetPatch(cur, base)).length > 0);
}

/** The parts of a page the editor changes: what undo and redo restore. */
type EditableContent = Pick<Page, 'title' | 'slug' | 'sections' | 'tags' | 'kind' | 'category' | 'authorId'>;
interface EditSnapshot { content: EditableContent; seo: PageSeo | null }
function editableContent(p: Page): EditableContent {
  // Optional fields are copied only when present (exactOptionalPropertyTypes).
  return {
    title: p.title, slug: p.slug, sections: p.sections,
    ...(p.tags !== undefined ? { tags: p.tags } : {}),
    ...(p.kind !== undefined ? { kind: p.kind } : {}),
    ...(p.category !== undefined ? { category: p.category } : {}),
    ...(p.authorId !== undefined ? { authorId: p.authorId } : {}),
  };
}
/** Content compared for undo, normalized the way the server returns it (absent
 *  tags are [], absent facets null) and without section ids, which the server
 *  mints on save; so a save is never mistaken for an edit. */
const contentKey = (p: Page): string => JSON.stringify({
  title: p.title, slug: p.slug, tags: p.tags ?? [], kind: p.kind ?? 'page', category: p.category ?? null, authorId: p.authorId ?? null,
  sections: p.sections.map(({ sectionId: _id, ...rest }) => rest),
});
/** Edits closer together than this undo as one step (a burst of typing). */
const UNDO_COALESCE_MS = 800;
const UNDO_LIMIT = 100;

/** The address as it is typed: the server's slug rules (lowercase letters,
 *  digits and single hyphens), minus its trim of a trailing hyphen, so the
 *  next word can still be typed. The server trims and de-duplicates on save. */
function typedSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-/, '').slice(0, 64);
}

function postFacetPatch(cur: Page, base: Page | null): { kind?: 'page' | 'post'; authorId?: string | null; category?: string | null } {
  const out: { kind?: 'page' | 'post'; authorId?: string | null; category?: string | null } = {};
  if ((cur.kind ?? 'page') !== (base?.kind ?? 'page')) out.kind = cur.kind ?? 'page';
  const curCat = (cur.category ?? '').trim();
  if (curCat !== (base?.category ?? '')) out.category = curCat === '' ? null : curCat;
  if ((cur.authorId ?? null) !== (base?.authorId ?? null)) out.authorId = cur.authorId ?? null;
  return out;
}

export function CmsPage({ translatorSurface = false }: { translatorSurface?: boolean } = {}): JSX.Element {
  const { t } = useTranslation('cms');
  const navigate = useNavigate();
  const { routeOrgId, routePageId } = useParams();
  const [orgId, setOrgId] = useState('');
  const [pages, setPages] = useState<Page[] | null>(null);
  const [selected, setSelected] = useState<Page | null>(null);
  // The loaded/last-saved page baseline — `selected` is edited in place, so it
  // diverges from this on edit and matches again on open / save / workflow
  // transition. UX CONT-6.
  const [savedPage, setSavedPage] = useState<Page | null>(null);
  const [assets, setAssets] = useState<MediaAssetRef[]>([]);
  const [settings, setSettings] = useState<LanguageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // Page-list filters (ADR 0206 B3) — server-side narrowing.
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | PageStatus>('');
  const [tagFilter, setTagFilter] = useState('');
  // Preview fidelity (ADR 0206 B2): rough editor blocks vs the real public markup.
  // Collection landing view (grid default) + the detail view mode. Public is
  // the default detail view — you open a page and see the real rendered page;
  // switch to Editor to change it, Outline for the rough section blocks.
  const [view, setView] = useViewMode('cms', 'grid');
  // The page workspace: Edit shows the section list, the live page and the
  // settings panel; Preview shows the page alone. The selected section is the
  // one the settings panel edits, outlined on the page and marked in the list.
  const [workspaceMode, setWorkspaceMode] = useState<'edit' | 'preview' | 'page'>('edit');
  // The one section open for editing in place on the Edit tab (null = none).
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  // Where the section picker will insert (an index into the sections), or null.
  const [insertAt, setInsertAt] = useState<number | null>(null);
  // The preview frame's document, so shortcuts and focus work inside the page.
  const [frameDoc, setFrameDoc] = useState<Document | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  // Autosave in flight (drafts only; see the autosave effect).
  const [saving, setSaving] = useState(false);
  // The workflow action waiting on the review checklist (ADR 0828 phase 3).
  const [pendingAction, setPendingAction] = useState<WorkflowAction | null>(null);
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  // ADR 0592 §5 (CMSLU-5) — preview-in-locale: which locale the Public preview
  // resolves. '' = the base locale. Only locales from the org's configured set
  // are offered (fail-closed by construction).
  const [previewLocale, setPreviewLocale] = useState('');
  const [a11yIssues, setA11yIssues] = useState<A11yIssue[] | null>(null); // ADR 0363 P2
  // Version history (ADR 0206 B1) — lazily loaded per open of the panel.
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const [versionsFailed, setVersionsFailed] = useState(false);
  const [diffVersion, setDiffVersion] = useState<PageVersion | null>(null);
  // Tag draft input for the selected page.
  const [newTag, setNewTag] = useState('');
  // ADR 0592 §1 (CMSLU-3) — a stale save 409'd: the page changed under this
  // editor. Non-null renders the designed conflict state (reload vs explicit
  // overwrite); local edits are NEVER auto-discarded.
  const [saveConflict, setSaveConflict] = useState<{ currentVersion: number } | null>(null);
  // Search and social (the publishing feature's per-page SEO record), edited
  // on the Page tab and saved with the page. `seoFailed`: the read failed, so
  // the fields stay hidden rather than offering blanks that would overwrite it.
  const [seo, setSeo] = useState<PageSeo | null>(null);
  const [savedSeo, setSavedSeo] = useState<PageSeo | null>(null);
  const [seoFailed, setSeoFailed] = useState(false);
  const seoDirty = seo !== null && savedSeo !== null && JSON.stringify(seo) !== JSON.stringify(savedSeo);
  // Media picker (ADR 0206 B4): resolver for the in-flight pick, if any.
  const [pickerResolve, setPickerResolve] = useState<((token: string | null) => void) | null>(null);
  // Shared sections (ADR 0204 C4): the org's list, and the one open in the edit modal.
  const [sharedSections, setSharedSections] = useState<SharedSection[]>([]);
  /** UX_UPGRADE-content R2 (CMS2-B5) — `listSharedSections` swallowed into `[]`
   *  told the editor FOUR lies at once, all of them "this section was deleted":
   *  the block read "Shared section no longer exists — remove or replace this
   *  block", Detach vanished (it needs the shared body to copy in), the ref
   *  block was DROPPED from both previews so the page rendered as if the header
   *  were already gone, and the shared-sections list disappeared. The obvious
   *  next action is Remove — which destroys a `ref` used on every page in the
   *  org, recoverable only through version history. The neighbouring
   *  `sharedImpactFailed` flag in this same file is the pattern. */
  const [sharedFailed, setSharedFailed] = useState(false);
  const [editShared, setEditShared] = useState<SharedSection | null>(null);
  const [sharedImpact, setSharedImpact] = useState<Array<{ pageId: string; title: string; status?: string; scheduledPublishAt?: string }> | null>(null);
  const [sharedImpactFailed, setSharedImpactFailed] = useState(false);
  // Preview links (ADR 0204 C3 — sharing composes the token lifecycle): links
  // for the selected page, lazily loaded per panel open.
  const [previewLinks, setPreviewLinks] = useState<ShareLink[] | null>(null);
  // A failed share-link read must not read as "No active preview links" —
  // an author could conclude a live link was revoked.
  const [previewLinksFailed, setPreviewLinksFailed] = useState(false);
  // Scheduled publish (ADR 0204 C2) — the datetime-local draft value.
  const [scheduleAt, setScheduleAt] = useState('');
  const [unpublishAt, setUnpublishAt] = useState('');
  // Front-page collapse (ADR 0027): the public homepage is a real CMS page in
  // the reserved system-site org, editable here by a super admin. `siteConfig`
  // resolves only for a super admin (the probe 403s otherwise), so its presence
  // gates the "Front page" scope + its on/off switch. Null ⇒ not a site admin
  // (or still probing) ⇒ the scope stays hidden.
  const [siteConfig, setSiteConfig] = useState<SiteConfig | null>(null);
  const [siteBusy, setSiteBusy] = useState(false);
  const isSiteAdmin = siteConfig !== null;
  const isSystemScope = orgId === SYSTEM_SITE_ORG;
  // ADR 0836 (grade-ux H1) — the admin tier in THIS org, tri-state: hide a
  // control only when the answer is KNOWN to be no (see the hook).
  const { canAdmin } = useCmsOrgAccess(orgId, isSystemScope ? isSiteAdmin : null);
  const knownNotAdmin = canAdmin === false;
  // Translator surface (ADR 0592 §2): the caller's OWN grant. undefined =
  // probing; null = no grant (honest empty state). A FAILED probe is its own
  // state — a failed read must never render as "you have no access"
  // (absence-is-a-claim).
  const [myGrant, setMyGrant] = useState<CmsLocaleGrant | null | undefined>(undefined);
  const [myGrantFailed, setMyGrantFailed] = useState(false);
  // ADR 0592 §6 (CMSLU-6) — a failed language-settings read is ITS OWN state:
  // without it the editor silently rendered monolingual (tabs gone, translate
  // gone) — a failed read presenting the positive claim "this org has no
  // translations".
  const [settingsFailed, setSettingsFailed] = useState(false);
  // The surface's index path — every internal navigation stays on-surface.
  const indexPath = translatorSurface ? '/cms/translate' : '/cms';

  // `.catch(() => setOrgs([]))` USED TO DEFEAT THE GUARD THIS PAGE ALREADY HAD.
  // The default-selection effect below bails on `orgs === null` precisely so it
  // waits for the probe to settle — and the catch made a FAILURE look settled.
  // For a site admin the consequence was invisible rather than loud: `pickerOrgs`
  // prepends the synthetic Front-page scope, so the picker was non-empty, an org
  // was auto-selected, the page rendered completely, and EVERY REAL WORKSPACE WAS
  // SILENTLY MISSING. No spinner, no empty state, no error — a healthy-looking
  // page showing a subset. The hook keeps `orgs` null on failure, which restores
  // the guard for free.
  const { orgs, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs);

  useEffect(() => {
    // Probe the superadmin-gated site config; success ⇒ this caller may edit the
    // public front page, so surface it as a scope. A 403/failure hides it.
    // The translator surface never offers the Front-page scope — skip the probe.
    if (translatorSurface) return;
    void getSiteConfig().then(setSiteConfig).catch(() => setSiteConfig(null));
  }, [translatorSurface]);

  // ADR 0592 §2 — the translator surface's grant probe (self-scoped read).
  useEffect(() => {
    if (!translatorSurface || !orgId) return;
    let cancelled = false;
    setMyGrant(undefined); setMyGrantFailed(false);
    void getMyLocaleGrant(orgId)
      .then((g) => { if (!cancelled) setMyGrant(g); })
      .catch(() => { if (!cancelled) { setMyGrant(null); setMyGrantFailed(true); } });
    return () => { cancelled = true; };
  }, [translatorSurface, orgId]);

  // The scopes the picker offers: real workspaces + (for a site admin) the
  // reserved Front-page system scope, prepended.
  const frontPageScope: Org = { orgId: SYSTEM_SITE_ORG, name: t('frontPageScope') };
  const pickerOrgs: readonly Org[] = isSiteAdmin ? [frontPageScope, ...(orgs ?? [])] : (orgs ?? []);

  // Default the selection once both probes settle: prefer a real workspace, else
  // fall back to the Front-page scope (a superadmin with no orgs of their own).
  useEffect(() => {
    if (orgId || orgs === null) return;
    const firstOrg = orgs[0];
    if (firstOrg) setOrgId(firstOrg.orgId);
    else if (isSiteAdmin) setOrgId(SYSTEM_SITE_ORG);
  }, [orgId, orgs, isSiteAdmin]);

  const toggleSiteEnabled = useCallback(async (enabled: boolean) => {
    setSiteBusy(true);
    try {
      const next = await putSiteConfig({ enabled });
      setSiteConfig(next);
      invalidateFrontPage();
      toast.success(enabled ? t('frontPageEnabledOn') : t('frontPageEnabledOff'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('frontPageToggleFailed'));
    } finally {
      setSiteBusy(false);
    }
  }, [t]);

  // ADR 0592 §6 (CMSLU-7) — the error surface prefers a LOCALIZED message for
  // known backend codes (grant denials rebuilt from details.grantedLocales;
  // the toggle-off 404 by code, not an English regex) and demotes to the raw
  // server message only when no mapping exists.
  const apiErrMsg = useCallback((e: unknown, fallback: string): string => {
    const info = cmsErrorInfo(e);
    if (info) return t(info.key, { ...(info.options ?? {}), defaultValue: fallback });
    return e instanceof Error && e.message ? e.message : fallback;
  }, [t]);

  const filterRef = useRef({ q, statusFilter, tagFilter });
  filterRef.current = { q, statusFilter, tagFilter };
  const loadPages = useCallback((org: string) => {
    const f = filterRef.current;
    void listPages(org, { ...(f.q ? { q: f.q } : {}), ...(f.tagFilter ? { tag: f.tagFilter } : {}), ...(f.statusFilter ? { status: f.statusFilter } : {}) })
      .then(setPages)
      .catch((e) => setError(e instanceof Error ? e.message : t('loadPagesFailed')));
  }, [t]);

  useEffect(() => {
    if (!orgId) return;
    // FP-1: guard against a stale org's responses landing after a fast org
    // switch and stomping the newer org's data. The cleanup flips `cancelled`,
    // so in-flight resolutions for the previous org are dropped.
    let cancelled = false;
    setPages(null); setSelected(null); setSavedPage(null); setError(null); setSettings(null); setVersions(null); setPreviewLocale('');
    setSharedSections([]); setPreviewLinks(null);
    void listPages(orgId).then((p) => { if (!cancelled) setPages(p); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('loadPagesFailed')); });
    // The reserved system-site org has its own Media library too (ADR 0817: the
    // media routes admit a super admin there, as the CMS routes do), so the
    // public site's pages pick and upload images like any org's.
    void listAssets(orgId).then((a) => { if (!cancelled) setAssets(a); }).catch(() => { if (!cancelled) setAssets([]); });
    setSettingsFailed(false);
    void getLanguageSettings(orgId)
      .then((s) => { if (!cancelled) setSettings(s); })
      .catch(() => { if (!cancelled) { setSettings(null); setSettingsFailed(true); } });
    void listSharedSections(orgId)
      .then((s) => { if (!cancelled) { setSharedSections(s); setSharedFailed(false); } })
      .catch(() => { if (!cancelled) { setSharedSections([]); setSharedFailed(true); } });
    return () => { cancelled = true; };
  }, [orgId, t]);

  // Re-query the list when a filter changes (debounced for the text input —
  // one request per pause, not per keystroke; rate-limit fan-out discipline).
  useEffect(() => {
    if (!orgId) return;
    const handle = setTimeout(() => loadPages(orgId), q || tagFilter ? 250 : 0);
    return () => clearTimeout(handle);
  }, [orgId, q, statusFilter, tagFilter, loadPages]);

  // Editor locale tabs (ADR 0064): [base, ...supported]. Empty/1-entry ⇒ no tabs.
  // Translator surface: tabs narrow to base (read-only) + the GRANTED locales
  // that are actually configured — a grant for an unconfigured locale renders
  // nothing (no lane delivers it; CMSL-7 rejects new ones at write).
  const locales = settings
    ? [settings.baseLocale, ...settings.supportedLocales.filter((l) => !translatorSurface || (myGrant?.locales ?? []).includes(l))]
    : [];
  const baseLocale = settings?.baseLocale ?? 'en';

  // ADR 0861 D6 — translation status of the SAVED page (missing / current /
  // OUTDATED / unknown per section × locale). Refetched whenever the saved
  // version moves, so it always describes what is stored, never unsaved edits.
  const [trStatus, setTrStatus] = useState<PageTranslationStatus | null>(null);
  // CMSL2UX-5 — a failed read is said, not hidden: no status is not "all current".
  const [trFailed, setTrFailed] = useState(false);
  const trPageId = savedPage?.pageId;
  const trVersion = savedPage?.version;
  const hasLocales = locales.length > 1;
  useEffect(() => {
    if (!trPageId || !hasLocales) { setTrStatus(null); setTrFailed(false); return; }
    let live = true;
    getTranslationStatus(orgId, trPageId)
      .then((st) => { if (live) { setTrStatus(st); setTrFailed(false); } })
      .catch(() => { if (live) { setTrStatus(null); setTrFailed(true); } }); // advisory — never blocks editing
    return () => { live = false; };
  }, [orgId, trPageId, trVersion, hasLocales]);
  // CMSL2UX-4 — language names, a counted noun, and only the locales this editor
  // works in (a translator's grant-filtered `locales`).
  const outdatedSummary = trStatus
    ? trStatus.locales
      .filter((l) => locales.includes(l) && (trStatus.counts[l]?.outdated ?? 0) > 0)
      .map((l) => t('translationOutdatedSummaryItem', { language: localeLabel(l), count: trStatus.counts[l]?.outdated ?? 0 }))
    : [];
  const confirmSource = useCallback(async (sectionId: string, locale: string): Promise<boolean> => {
    if (!selected || !savedPage) return false;
    // CMSL2UX-2 — the status describes the SAVED page; with unsaved edits a confirm
    // would race the autosave (or vouch for text the editor is still changing).
    if (hasUnsavedEdits(selected, savedPage)) {
      toast.info(t('confirmSourceSaveFirst'));
      return false;
    }
    try {
      // CMSL2UX-1 — pinned to the version this editor holds; a 409 means someone
      // else saved first, and the page is NOT adopted over their save.
      const p = await confirmTranslationSource(orgId, savedPage.pageId, sectionId, locale, savedPage.version);
      setSelected(p); setSavedPage(p); // no unsaved edits ⇒ the server page IS the editor's page
      toast.success(t('confirmSourceToast', { language: localeLabel(locale) }));
      return true;
    } catch (e) {
      toast.error(apiErrMsg(e, t('confirmSourceFailed')));
      return false;
    }
  }, [orgId, t, apiErrMsg, selected, savedPage]);

  const open = useCallback((pageId: string) => {
    // A page opens on the Section tab in Edit mode. Set here, when the open
    // starts, not in an effect keyed on the loaded page: that effect ran after
    // the page rendered and could undo a tab the person had already chosen.
    setWorkspaceMode('edit'); setEditingSectionId(null);
    setVersions(null); // history reloads lazily for the newly opened page
    setSaveConflict(null); // a fresh load IS the reload-and-reapply baseline
    setReview(null); setReviewLoaded(false); setRejectNote(null);
    void getPage(orgId, pageId).then((p) => { setSelected(p); setSavedPage(p); }).catch((e) => toast.error(apiErrMsg(e, t('openFailed'))));
    setSeo(null); setSavedSeo(null); setSeoFailed(false);
    if (!translatorSurface) {
      void getSeo(orgId, pageId)
        .then((v) => { const loaded = v ?? { noindex: false }; setSeo(loaded); setSavedSeo(loaded); })
        .catch(() => setSeoFailed(true));
    }
    // ADR 0593 D4 (CMSAU-5) — enrichment; a failure renders nothing.
    void getPageReview(orgId, pageId).then((r) => { setReview(r); setReviewLoaded(true); });
  }, [orgId, translatorSurface, t, apiErrMsg]);

  // The URL is the source of truth for WHICH page is open — deep-linkable +
  // back-button-addressable (/cms/p/:routeOrgId/:routePageId). Opening is a
  // navigation; in-place edits stay `setSelected`.
  const openPage = useCallback((pageId: string) => navigate(`${translatorSurface ? '/cms/translate' : '/cms/p'}/${encodeURIComponent(orgId)}/${encodeURIComponent(pageId)}`), [navigate, orgId, translatorSurface]);
  // Route → scope: adopt the URL's org.
  useEffect(() => { if (routeOrgId && routeOrgId !== orgId) setOrgId(routeOrgId); }, [routeOrgId, orgId]);
  // Route → open/close: open the URL's page once its scope is active; a bare
  // /cms (no page param) closes the detail.
  useEffect(() => {
    if (routePageId) {
      if (orgId === routeOrgId && selected?.pageId !== routePageId) open(routePageId);
    } else if (selected) {
      setSelected(null); setSavedPage(null);
    }
  }, [routePageId, routeOrgId, orgId, selected, open]);

  const loadVersions = useCallback((pageId: string) => {
    // "No published versions yet" is a claim about this page's history. A failed
    // read may not make it — an author seeing it could reasonably conclude their
    // publish history was lost.
    setVersionsFailed(false);
    void listVersions(orgId, pageId)
      .then(setVersions)
      .catch(() => { setVersions([]); setVersionsFailed(true); });
  }, [orgId]);

  const restore = useCallback(async (versionId: string, versionNo: number) => {
    if (!selected) return;
    // ADR 0836 D8 — restoring a LIVE page takes it offline (it lands in draft);
    // say so before, not after.
    // (An archived page is already off the public site, so only `published` is
    // "live" here.) Taking a page down is the danger tier (DESIGN.md).
    const live = selected.status === 'published';
    if (!(await confirm({ title: t('restoreConfirmTitle', { version: versionNo }), body: t(live ? 'restoreConfirmBodyLive' : 'restoreConfirmBody'), confirmLabel: t('historyRestore'), ...(live ? { danger: true } : {}) }))) return;
    try {
      const p = await restoreVersion(orgId, selected.pageId, versionId, selected.version);
      setSelected(p); setSavedPage(p); loadPages(orgId); loadVersions(p.pageId);
      toast.success(t(live ? 'historyRestoredLive' : 'historyRestored', { version: versionNo }));
    } catch (e) {
      // ADR 0836 D8 — the restore is pinned to the version on screen.
      if (e instanceof CmsApiError && e.code === 'conflict' && !e.details?.gate) toast.error(t('restoreConflict'));
      else toast.error(apiErrMsg(e, t('actionFailed', { action: 'restore' })));
    }
  }, [orgId, selected, loadPages, loadVersions, t, apiErrMsg]);

  const create = useCallback(async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    try { const p = await createPage(orgId, newTitle.trim()); setNewTitle(''); loadPages(orgId); setSelected(p); setSavedPage(p); openPage(p.pageId); toast.success(t('pageCreated')); }
    catch (e) { toast.error(apiErrMsg(e, t('createFailed'))); } finally { setBusy(false); }
  }, [orgId, newTitle, loadPages, openPage, t, apiErrMsg]);

  // Clone (ADR 0206) — a new draft page seeded with the source's sections + tags
  // (create is title-only, so copy the content in a follow-up save), then open it.
  const clone = useCallback(async (src: Page) => {
    setBusy(true);
    try {
      const created = await createPage(orgId, t('cloneTitle', { title: src.title }));
      const copied = await savePage(orgId, created.pageId, { sections: src.sections, tags: src.tags ?? [], expectedVersion: created.version });
      loadPages(orgId); setSelected(copied); setSavedPage(copied); openPage(copied.pageId); toast.success(t('pageCloned'));
    } catch (e) { toast.error(apiErrMsg(e, t('createFailed'))); } finally { setBusy(false); }
  }, [orgId, loadPages, openPage, t, apiErrMsg]);

  const save = useCallback(async (opts?: { silent?: boolean }): Promise<boolean> => {
    if (!selected) return false;
    // ADR 0836 D3 — a save by anyone but an admin cancels a pending scheduled
    // publish. Ask first (autosave is off on such a page, so this is the only
    // way in); an admin's save keeps (re-pins) it.
    if (selected.scheduledPublishAt && canAdmin !== true && !translatorSurface && hasUnsavedEdits(selected, savedPage)) {
      if (!(await confirm({
        title: t('scheduleCancelConfirmTitle'),
        body: t('scheduledEditWarning', { at: formatDateTime(selected.scheduledPublishAt) }),
        confirmLabel: t('scheduleCancelConfirmAction'),
      }))) return false;
    }
    setBusy(true); setSaving(true);
    let pageWritten = false;
    try {
      // ADR 0592 §1 — ALWAYS pinned on the editor lane. `selected.version` is
      // only ever written by server merges (save/open/transition/schedule/
      // locale-state), so it is the loaded baseline, not a local edit.
      // Review F1 (ADR 0592 §Corrections) — the D1 guard refuses a grant-
      // holder on the PRESENCE of title/tags (not on change), so the
      // translator surface sends sections + the pin ONLY. The full-editor
      // payload is unchanged.
      // The page record saves when it changed, or on an explicit Save with
      // nothing else to save (the version check doubles as a refresh).
      if (hasUnsavedEdits(selected, savedPage) || !seoDirty) {
      const saved = await savePage(orgId, selected.pageId, translatorSurface
        ? { sections: selected.sections, expectedVersion: selected.version }
        : { title: selected.title, sections: selected.sections, tags: selected.tags ?? [], ...postFacetPatch(selected, savedPage), ...(selected.slug !== savedPage?.slug ? { slug: selected.slug } : {}), expectedVersion: selected.version });
      // Keep edits typed while the save was in flight: adopt the server's
      // version and timestamps, and the saved content only if nothing changed.
      // A new section is sent with a `new:` id and the server mints its
      // permanent `sec:` id. Map the sent ids to the saved ones (same order and
      // count) so the selection, and edits typed while this save was in flight,
      // follow the section instead of losing it.
      const idMap = new Map<string, string>();
      if (saved.sections.length === selected.sections.length) {
        selected.sections.forEach((x, i) => { const y = saved.sections[i]; if (y && y.sectionId !== x.sectionId) idMap.set(x.sectionId, y.sectionId); });
      }
      const remap = (list: Section[]): Section[] => (idMap.size === 0 ? list : list.map((x) => { const id = idMap.get(x.sectionId); return id ? { ...x, sectionId: id } : x; }));
      // ADR 0836 D3 — the server owns the schedule fields: a save by someone
      // without publish authority cancels a pending scheduled publish, and an
      // admin's save re-pins it. Adopt them even when local edits are kept.
      const adoptSchedule = (p: Page): Page => {
        const out: Page = { ...p };
        if (saved.scheduledPublishAt) out.scheduledPublishAt = saved.scheduledPublishAt; else delete out.scheduledPublishAt;
        if (saved.scheduledPublishVersion !== undefined) out.scheduledPublishVersion = saved.scheduledPublishVersion; else delete out.scheduledPublishVersion;
        if (saved.scheduledUnpublishAt) out.scheduledUnpublishAt = saved.scheduledUnpublishAt; else delete out.scheduledUnpublishAt;
        return out;
      };
      setSelected((cur) => (cur && hasUnsavedEdits(cur, selected) ? adoptSchedule({ ...cur, sections: remap(cur.sections), version: saved.version, updatedAt: saved.updatedAt }) : saved));
      if (savedPage?.scheduledPublishAt && !saved.scheduledPublishAt) toast.warning(t('scheduleCancelledByEdit'), 0);
      if (idMap.size > 0) {
        setSelectedSectionId((id) => (id ? idMap.get(id) ?? id : id));
        setEditingSectionId((id) => (id ? idMap.get(id) ?? id : id));
      }
      setSavedPage(saved); setSaveConflict(null); loadPages(orgId);
      pageWritten = true;
      if (!opts?.silent && savedPage?.scheduledPublishAt && saved.scheduledPublishAt && saved.scheduledPublishVersion !== savedPage.scheduledPublishVersion) {
        toast.info(t('scheduleKeptOnEdit', { at: formatDateTime(saved.scheduledPublishAt) }));
      }
      }
      if (!translatorSurface && seoDirty && seo) {
        const sent = seo;
        let stored: PageSeo;
        try {
          stored = await putSeo(orgId, selected.pageId, sent);
        } catch (e) {
          // The page content above DID save; say exactly what did not.
          if (pageWritten) { toast.error(t('seoNotSaved', { reason: apiErrMsg(e, t('saveFailed')) })); return false; }
          throw e;
        }
        setSavedSeo(stored);
        setSeo((cur) => (cur && JSON.stringify(cur) !== JSON.stringify(sent) ? cur : stored));
      }
      if (!opts?.silent) toast.success(t('pageSaved'));
      return true;
    } catch (e) {
      // ADR 0836 — only a VERSION conflict opens the reload/overwrite banner. A
      // gate 409 (`details.gate`, e.g. an SEO save on a gated live page) is a
      // refusal: overwriting would hit the same gate, so it is a toast.
      if (e instanceof CmsApiError && e.code === 'conflict' && typeof e.details?.currentVersion === 'number' && !e.details?.gate) {
        setSaveConflict({ currentVersion: e.details.currentVersion });
      } else {
        toast.error(apiErrMsg(e, t('saveFailed')));
      }
      return false;
    } finally { setBusy(false); setSaving(false); }
  }, [orgId, selected, savedPage, seo, seoDirty, translatorSurface, canAdmin, loadPages, t, apiErrMsg]);

  // Conflict recovery (ADR 0592 §1): reload THEIR version (discarding local
  // edits, confirmed), or explicitly OVERWRITE with mine — which refetches the
  // fresh version and resends with a fresh pin (the lane stays preconditioned;
  // a pinless resend would reopen the silent-clobber hole this closes).
  const conflictReload = useCallback(async () => {
    if (!selected) return;
    if (!(await confirm({ title: t('ui:unsavedLeaveTitle'), body: t('ui:unsavedLeaveBody'), danger: true, confirmLabel: t('ui:unsavedLeaveConfirm') }))) return;
    open(selected.pageId);
  }, [selected, open, t]);
  const conflictOverwrite = useCallback(async () => {
    if (!selected) return;
    if (!(await confirm({ title: t('saveConflictOverwriteConfirmTitle'), body: t('saveConflictOverwriteConfirmBody'), danger: true, confirmLabel: t('saveConflictOverwrite') }))) return;
    setBusy(true);
    try {
      const fresh = await getPage(orgId, selected.pageId);
      const saved = await savePage(orgId, selected.pageId, translatorSurface
        ? { sections: selected.sections, expectedVersion: fresh.version }
        : { title: selected.title, sections: selected.sections, tags: selected.tags ?? [], ...postFacetPatch(selected, fresh), ...(selected.slug !== fresh.slug ? { slug: selected.slug } : {}), expectedVersion: fresh.version });
      setSelected(saved); setSavedPage(saved); setSaveConflict(null); loadPages(orgId); toast.success(t('pageSaved'));
    } catch (e) { toast.error(apiErrMsg(e, t('saveFailed'))); } finally { setBusy(false); }
  }, [orgId, selected, translatorSurface, loadPages, t, apiErrMsg]);

  // ADR 0593 D4 (CMSAU-5) — the SUBMITTER's feedback loop. A rejected page read
  // `draft`, indistinguishable from never-submitted, with the reviewer's reason
  // rendered nowhere. `review` is enrichment: absent ⇒ no claim is made.
  const [review, setReview] = useState<PageReview | null>(null);
  // ADR 0859 D4 (UX grade CMSA2UX-6) — until the review has loaded we cannot tell a
  // submitter from another approver, so Approve is held back rather than flashed.
  const [reviewLoaded, setReviewLoaded] = useState(false);
  const [rejectNote, setRejectNote] = useState<string | null>(null);
  /** F7(4) — where focus returns when the reason step closes. */
  const rejectBtnRef = useRef<HTMLButtonElement | null>(null);

  const runAction = useCallback(async (action: WorkflowAction, note?: string): Promise<boolean> => {
    if (!selected) return false;
    // A transition acts on the SAVED page and its reply replaced the editor
    // state, so Publish/Submit with unsaved edits published the old content
    // and silently dropped the edits. Save first; a failed save (conflict,
    // validation) stops the transition with the save's own message.
    if ((hasUnsavedEdits(selected, savedPage) || seoDirty) && !(await save())) return false;
    // ADR 0592 §9 (CMSLU-14) — submit can run up to 20 synchronous provider
    // calls; the workflow buttons disable while in flight (no double-submit).
    setBusy(true);
    try {
      const p = await transition(orgId, selected.pageId, action, note);
      setSelected(p); setSavedPage(p); loadPages(orgId);
      void getPageReview(orgId, p.pageId).then(setReview);
      // A transition can capture a snapshot — refresh an already-open History
      // panel in place (setting null would strand it on a skeleton).
      if (versions !== null) loadVersions(p.pageId);
      // ADR 0593 (CMSAU-8) — the LOCALIZED status word. This interpolated the
      // raw enum ("Página in_review.") in every non-English locale, two lines
      // below the `status_*` keys that already existed and went unused.
      toast.success(t('pageStatusChanged', { status: t(`status_${p.status}`) }));
      // ADR 0064 amendment — surface the AI-drafted overlay counts a submit produced.
      if (p.autoTranslated) {
        const total = Object.values(p.autoTranslated).reduce((a, b) => a + b, 0);
        toast.success(t('autoTranslatedToast', { count: total, locales: Object.keys(p.autoTranslated).join(', ') }));
      }
      // ADR 0592 §9 (CMSL-5) — a capped/errored/invalid sweep is DISCLOSED:
      // "8 drafts added" must not silently mean "…and the rest were skipped".
      if (p.autoTranslateDegraded) {
        const d = p.autoTranslateDegraded;
        const parts: string[] = [];
        if (d.capped) parts.push(t('autoTranslateCapped'));
        if (d.errored) parts.push(t('autoTranslateErrored'));
        if (d.invalid) parts.push(t('autoTranslateInvalid', { count: d.invalid }));
        if (d.conflict) parts.push(t('autoTranslateConflict'));
        if (parts.length > 0) toast.error(t('autoTranslateDegradedToast', { reasons: parts.join(' · ') }));
      }
      return true;
    }
    catch (e) {
      toast.error(apiErrMsg(e, t('actionFailed', { action })));
      // ADR 0859 D4 — a refused decide (e.g. separation of duties decided elsewhere)
      // re-reads the review, so a control the server refuses does not stay offered.
      if (action === 'approve' || action === 'reject') void getPageReview(orgId, selected.pageId).then(setReview);
      return false;
    }
    finally { setBusy(false); }
  }, [orgId, selected, savedPage, seoDirty, save, versions, loadPages, loadVersions, apiErrMsg, t]);

  // ADR 0206 B4 — one in-flight pick at a time; the dialog resolves a token or null.
  const pickMedia = useCallback((): Promise<string | null> => {
    return new Promise<string | null>((resolve) => { setPickerResolve(() => resolve); });
  }, []);

  // ── Shared sections (ADR 0204 C4) ──
  const reloadShared = useCallback(() => {
    void listSharedSections(orgId)
      .then((s) => { setSharedSections(s); setSharedFailed(false); })
      .catch(() => { setSharedSections([]); setSharedFailed(true); });
  }, [orgId]);

  const saveAsShared = useCallback(async (section: Section) => {
    if (!selected) return;
    try {
      const name = `${selected.title} · ${section.type}`;
      await createSharedSection(orgId, { name, type: section.type, data: section.data, ...(section.localizations ? { localizations: section.localizations } : {}) });
      reloadShared();
      toast.success(t('sharedCreated', { name }));
    } catch (e) { toast.error(apiErrMsg(e, t('sharedCreateFailed'))); }
  }, [orgId, selected, reloadShared, t, apiErrMsg]);

  const openSharedEditor = useCallback((shared: SharedSection) => {
    setEditShared(shared);
    setSharedImpact(null);
    setSharedImpactFailed(false);
    // `[]` on failure did TWO harmful things: it told the author this shared
    // section is used on no pages, and — because the save confirmation is gated
    // on `impact.length > 0` — it silently REMOVED the "this will change N
    // pages" guardrail from a fan-out edit.
    void listSharedSectionPages(orgId, shared.sharedSectionId)
      .then(setSharedImpact)
      .catch(() => { setSharedImpact([]); setSharedImpactFailed(true); });
  }, [orgId]);

  const saveShared = useCallback(async () => {
    if (!editShared) return;
    const impact = sharedImpact ?? [];
    // Confirm when we KNOW it fans out, and also when we could not find out —
    // an unknown blast radius is a reason to ask, not a reason to skip asking.
    if (sharedImpactFailed) {
      if (!(await confirm({
        title: t('sharedSaveUnknownImpactTitle'),
        body: t('sharedSaveUnknownImpactBody'),
        confirmLabel: t('common:save'),
        danger: true,
      }))) return;
    } else if (impact.length > 0 && !(await confirm({
      title: t('sharedSaveConfirmTitle', { count: impact.length }),
      body: impact.map((p) => p.title).join(' · '),
      confirmLabel: t('common:save'),
    }))) return;
    try {
      await updateSharedSection(orgId, editShared.sharedSectionId, { name: editShared.name, data: editShared.data, ...(editShared.localizations ? { localizations: editShared.localizations } : {}) });
      setEditShared(null);
      reloadShared();
      toast.success(t('sharedSaved'));
    } catch (e) { toast.error(apiErrMsg(e, t('sharedSaveFailed'))); }
  }, [orgId, editShared, sharedImpact, sharedImpactFailed, reloadShared, t, apiErrMsg]);

  const removeShared = useCallback(async (shared: SharedSection) => {
    if (!(await confirm({ title: t('sharedDeleteConfirm', { name: shared.name }), body: t('common:cannotBeUndone'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteSharedSection(orgId, shared.sharedSectionId);
      reloadShared();
    } catch (e) { toast.error(apiErrMsg(e, t('sharedDeleteFailed'))); }
  }, [orgId, reloadShared, t, apiErrMsg]);

  // ── Preview links (ADR 0204 C3 — sharing owns the token lifecycle) ──
  const loadPreviewLinks = useCallback((pageId: string) => {
    setPreviewLinksFailed(false);
    void listLinks(orgId)
      .then((links) => setPreviewLinks(links.filter((l) => l.resourceType === 'cms_page' && l.resourceId === pageId && !l.revoked)))
      .catch(() => { setPreviewLinksFailed(true); setPreviewLinks([]); });
  }, [orgId]);

  const createPreviewLink = useCallback(async () => {
    if (!selected) return;
    try {
      const link = await createLink(orgId, { resourceType: 'cms_page', resourceId: selected.pageId, label: t('previewLinkLabel', { title: selected.title }), expiresInDays: 7 });
      loadPreviewLinks(selected.pageId);
      await copyToClipboard(sharedPageUrl(link.token), null);
      toast.success(t('previewLinkCreated'));
    } catch (e) {
      // The sharing toggle OFF surfaces as a 404 — explain instead of a bare error.
      toast.error(e instanceof Error && /404/.test(e.message) ? t('previewNeedsSharing') : e instanceof Error ? e.message : t('previewLinkFailed'));
    }
  }, [orgId, selected, loadPreviewLinks, t]);

  // ── Scheduled publish (ADR 0204 C2) ──
  // Schedule writes only touch the schedule fields — MERGE the server result
  // into local state so unsaved title/section/tag edits survive (review
  // finding: replacing `selected` wholesale discarded dirty edits).
  const applyScheduleResult = useCallback((server: Page) => {
    const merge = (prev: Page | null): Page => {
      if (!prev) return server;
      const next: Page = { ...prev, version: server.version, updatedAt: server.updatedAt };
      if (server.scheduledPublishAt) next.scheduledPublishAt = server.scheduledPublishAt;
      else delete next.scheduledPublishAt;
      if (server.scheduledUnpublishAt) next.scheduledUnpublishAt = server.scheduledUnpublishAt;
      else delete next.scheduledUnpublishAt;
      return next;
    };
    setSavedPage(merge);
    setSelected(merge);
  }, []);

  const schedule = useCallback(async () => {
    if (!selected || !scheduleAt) return;
    try {
      const p = await schedulePublish(orgId, selected.pageId, new Date(scheduleAt).toISOString());
      applyScheduleResult(p); setScheduleAt('');
      toast.success(t('scheduleSet', { at: formatDateTime(p.scheduledPublishAt ?? '') }));
    } catch (e) { toast.error(apiErrMsg(e, t('scheduleFailed'))); }
  }, [orgId, selected, scheduleAt, applyScheduleResult, t, apiErrMsg]);

  const unschedule = useCallback(async () => {
    if (!selected) return;
    try {
      const p = await cancelSchedule(orgId, selected.pageId);
      applyScheduleResult(p);
      toast.success(t('scheduleCleared'));
    } catch (e) { toast.error(apiErrMsg(e, t('scheduleFailed'))); }
  }, [orgId, selected, applyScheduleResult, t, apiErrMsg]);

  // ── Scheduled unpublish (ADR 0204 C2b — embargo end) ──
  const doScheduleUnpublish = useCallback(async () => {
    if (!selected || !unpublishAt) return;
    try {
      const p = await scheduleUnpublish(orgId, selected.pageId, new Date(unpublishAt).toISOString());
      applyScheduleResult(p); setUnpublishAt('');
      toast.success(t('scheduleUnpublishSet', { at: formatDateTime(p.scheduledUnpublishAt ?? '') }));
    } catch (e) { toast.error(apiErrMsg(e, t('scheduleFailed'))); }
  }, [orgId, selected, unpublishAt, applyScheduleResult, t, apiErrMsg]);

  const doCancelScheduleUnpublish = useCallback(async () => {
    if (!selected) return;
    try {
      const p = await cancelScheduleUnpublish(orgId, selected.pageId);
      applyScheduleResult(p);
      toast.success(t('scheduleUnpublishCleared'));
    } catch (e) { toast.error(apiErrMsg(e, t('scheduleFailed'))); }
  }, [orgId, selected, applyScheduleResult, t, apiErrMsg]);

  // ADR 0748 correction (2026-09-27) — deleting a page that is not a draft takes
  // live content down, which the server reserves for admins (like unpublish).
  // The UI offers the action to everyone, as it does publish/unpublish (authority
  // is enforced server-side), but it SAYS so before and after: the confirm names
  // the consequence for a live page, and an editor's 403 explains the remedy
  // instead of a generic "no permission".
  const remove = useCallback(async (p: Pick<Page, 'pageId' | 'title' | 'status'>) => {
    const live = p.status !== 'draft';
    if (!(await confirm({ title: t('deletePageConfirm', { name: p.title }), body: live ? t('deleteLivePageBody') : t('common:cannotBeUndone'), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await deletePage(orgId, p.pageId); if (selected?.pageId === p.pageId) { setSelected(null); setSavedPage(null); navigate(indexPath); } loadPages(orgId); }
    catch (e) {
      toast.error(live && (e as { code?: unknown } | null)?.code === 'forbidden_scope' ? t('deleteLivePageForbidden') : apiErrMsg(e, t('deleteFailed')));
    }
  }, [orgId, selected, loadPages, navigate, t, apiErrMsg, indexPath]);

  // Dirty while the editor's title/sections diverge from the loaded/saved page.
  // Workflow transitions replace both `selected` and `savedPage`, so a status
  // change is never "unsaved". UX CONT-6.
  const dirty = hasUnsavedEdits(selected, savedPage) || seoDirty;
  useUnsavedChangesWarning(dirty);
  // ADR 0592 §6 (CMSLU-2) — the IN-APP half of the dirty guard: the exits THIS
  // page renders ("Back to pages", the org picker) confirm before discarding.
  // The sidebar/browser-back path stays uncovered by design (no data router →
  // no useBlocker; the hook's docblock owns that disclosure), and tab-close
  // keeps the beforeunload prompt above.
  const confirmDiscard = useConfirmDiscardUnsaved(dirty);

  // ── Page workspace: section selection and structure ──
  // Keep a valid selection: the first section when the page opens, the
  // neighbour when the selected one is removed, none on an empty page. An
  // editor whose section is gone closes.
  useEffect(() => {
    if (!selected) { if (selectedSectionId !== null) setSelectedSectionId(null); return; }
    if (editingSectionId && !selected.sections.some((x) => x.sectionId === editingSectionId)) setEditingSectionId(null);
    if (selectedSectionId && selected.sections.some((x) => x.sectionId === selectedSectionId)) return;
    setSelectedSectionId(selected.sections[0]?.sectionId ?? null);
  }, [selected, selectedSectionId, editingSectionId]);

  /** A section's element inside the preview frame (attribute comparison, no
   *  selector escaping). */
  const sectionNode = useCallback((sectionId: string): HTMLElement | null => (
    Array.from(frameDoc?.querySelectorAll<HTMLElement>('[data-section-id]') ?? []).find((n) => n.getAttribute('data-section-id') === sectionId) ?? null
  ), [frameDoc]);
  /** Open a section for editing in place, on the Edit tab. */
  const selectSection = useCallback((sectionId: string) => {
    setSelectedSectionId(sectionId); setEditingSectionId(sectionId); setWorkspaceMode('edit');
  }, []);
  /** Close the open editor and return focus to that section's Edit button. */
  const closeEditor = useCallback(() => {
    const id = editingSectionId;
    setEditingSectionId(null);
    if (id) setTimeout(() => sectionNode(id)?.querySelector<HTMLElement>('[data-edit-for]')?.focus(), 0);
  }, [editingSectionId, sectionNode]);
  /** The Sections menu: scroll to a section and select it, without opening it. */
  const jumpToSection = useCallback((sectionId: string) => {
    setSelectedSectionId(sectionId); setWorkspaceMode('edit');
    setTimeout(() => {
      const node = sectionNode(sectionId);
      const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      node?.querySelector<HTMLElement>('[data-edit-for]')?.focus({ preventScroll: true });
    }, 0);
  }, [sectionNode]);
  const moveSection = useCallback((sectionId: string, dir: -1 | 1) => {
    setSelected((p) => {
      if (!p) return p;
      const i = p.sections.findIndex((x) => x.sectionId === sectionId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.sections.length) return p;
      const next = [...p.sections];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...p, sections: next };
    });
    setSelectedSectionId(sectionId);
  }, []);
  const reorderSection = useCallback((sectionId: string, overId: string) => {
    setSelected((p) => {
      if (!p) return p;
      const from = p.sections.findIndex((x) => x.sectionId === sectionId);
      const to = p.sections.findIndex((x) => x.sectionId === overId);
      if (from < 0 || to < 0 || from === to) return p;
      const next = [...p.sections];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return { ...p, sections: next };
    });
    setSelectedSectionId(sectionId);
  }, []);
  const duplicateSection = useCallback((sectionId: string) => {
    const id = `new:${Math.random().toString(36).slice(2)}`;
    setSelected((p) => {
      if (!p) return p;
      const i = p.sections.findIndex((x) => x.sectionId === sectionId);
      if (i < 0) return p;
      const copy: Section = JSON.parse(JSON.stringify(p.sections[i])) as Section;
      return { ...p, sections: [...p.sections.slice(0, i + 1), { ...copy, sectionId: id }, ...p.sections.slice(i + 1)] };
    });
    setSelectedSectionId(id);
  }, []);
  const removeSection = useCallback(async (sectionId: string) => {
    if (!selected) return;
    const i = selected.sections.findIndex((x) => x.sectionId === sectionId);
    if (i < 0) return;
    if (!(await confirm({ title: t('removeSectionConfirmTitle'), body: t('removeSectionConfirmBody'), danger: true, confirmLabel: t('removeSection') }))) return;
    const neighbour = selected.sections[i + 1] ?? selected.sections[i - 1];
    setSelected((p) => (p ? { ...p, sections: p.sections.filter((x) => x.sectionId !== sectionId) } : p));
    setSelectedSectionId(neighbour?.sectionId ?? null);
    if (editingSectionId === sectionId) setEditingSectionId(null);
  }, [selected, editingSectionId, t]);
  /** Insert a new section at `index` and open it for editing. */
  const insertSection = useCallback((index: number, section: Section) => {
    setSelected((p) => {
      if (!p) return p;
      const at = Math.max(0, Math.min(index, p.sections.length));
      return { ...p, sections: [...p.sections.slice(0, at), section, ...p.sections.slice(at)] };
    });
    setSelectedSectionId(section.sectionId); setEditingSectionId(section.sectionId); setWorkspaceMode('edit');
  }, []);

  // Compare and take (ADR 0828 phase 3): copy one section from a past version,
  // or a seeded update, into the draft. The draft autosaves as usual, and Undo
  // takes it back.
  const takeFromVersion = useCallback((version: PageVersion, entry: SectionDiffEntry) => {
    const src = version.snapshot.sections.find((x) => x.sectionId === entry.sectionId);
    if (!src) return;
    if (entry.kind === 'removed') {
      const at = version.snapshot.sections.indexOf(src);
      const id = `new:${Math.random().toString(36).slice(2)}`;
      setSelected((p) => (p ? { ...p, sections: [...p.sections.slice(0, at), { ...src, sectionId: id }, ...p.sections.slice(at)] } : p));
      setSelectedSectionId(id);
    } else {
      const target = entry.toSectionId ?? entry.sectionId;
      setSelected((p) => (p ? { ...p, sections: p.sections.map((x) => (x.sectionId === target ? { ...src, sectionId: target } : x)) } : p));
      setSelectedSectionId(target);
    }
    toast.success(t('diffTaken'));
  }, [t]);

  // ── Undo and redo ──
  // Records the editor's content (page fields and the search record) as it
  // changes. A server reply that only bumps the version, and the search
  // record's first load, update the baseline without adding a step. Opening
  // another page starts a fresh history.
  const history = useRef<{ pageId: string | null; past: EditSnapshot[]; future: EditSnapshot[]; last: EditSnapshot | null; lastKey: string; lastAt: number; applying: boolean }>(
    { pageId: null, past: [], future: [], last: null, lastKey: '', lastAt: 0, applying: false },
  );
  const [historyTick, setHistoryTick] = useState(0);
  useEffect(() => {
    const h = history.current;
    if (!selected) { if (h.pageId !== null) { history.current = { pageId: null, past: [], future: [], last: null, lastKey: '', lastAt: 0, applying: false }; setHistoryTick((n) => n + 1); } return; }
    const snap: EditSnapshot = { content: editableContent(selected), seo };
    const key = contentKey(selected) + JSON.stringify(seo);
    const seoJustLoaded = h.last !== null && h.last.seo === null && seo !== null && h.lastKey.startsWith(contentKey(selected));
    if (h.pageId !== selected.pageId || h.last === null || seoJustLoaded) {
      if (h.pageId !== selected.pageId) { h.past = []; h.future = []; }
      h.pageId = selected.pageId; h.last = snap; h.lastKey = key; h.applying = false;
      setHistoryTick((n) => n + 1);
      return;
    }
    if (key === h.lastKey) { h.last = snap; return; }
    if (h.applying) { h.applying = false; h.last = snap; h.lastKey = key; return; }
    const now = Date.now();
    if (!(now - h.lastAt < UNDO_COALESCE_MS && h.past.length > 0)) h.past = [...h.past, h.last].slice(-UNDO_LIMIT);
    h.future = []; h.last = snap; h.lastKey = key; h.lastAt = now;
    setHistoryTick((n) => n + 1);
  }, [selected, seo]);
  const applySnapshot = useCallback((snap: EditSnapshot) => {
    history.current.applying = true;
    setSelected((cur) => {
      if (!cur) return cur;
      const next: Page = { ...cur, ...snap.content };
      for (const k of ['tags', 'kind', 'category', 'authorId'] as const) if (!(k in snap.content)) delete next[k];
      return next;
    });
    if (snap.seo) setSeo(snap.seo);
  }, []);
  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past[h.past.length - 1];
    if (!prev || !h.last) return;
    h.past = h.past.slice(0, -1); h.future = [...h.future, h.last]; h.lastAt = 0;
    applySnapshot(prev); setHistoryTick((n) => n + 1);
  }, [applySnapshot]);
  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future[h.future.length - 1];
    if (!next || !h.last) return;
    h.future = h.future.slice(0, -1); h.past = [...h.past, h.last]; h.lastAt = 0;
    applySnapshot(next); setHistoryTick((n) => n + 1);
  }, [applySnapshot]);
  const canUndo = historyTick >= 0 && history.current.past.length > 0;
  const canRedo = historyTick >= 0 && history.current.future.length > 0;
  // ⌘Z / ⇧⌘Z (Ctrl on other systems; Ctrl+Y redoes too). Inside a text field
  // the browser's own undo applies to that field instead.
  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.closest('input, textarea, select, [contenteditable="true"]'))) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
    };
    // Bound inside the preview frame too: with focus in the page (an open
    // section's editor), the outer window never sees the key.
    window.addEventListener('keydown', onKey);
    frameDoc?.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); frameDoc?.removeEventListener('keydown', onKey); };
  }, [selected, undo, redo, frameDoc]);

  // Autosave, drafts only. Saving a published page changes the live site, and
  // saving a page under review makes its pending approval stale, so those keep
  // the explicit Save. A conflict pauses autosave until the person chooses.
  // A failed autosave is not retried until the next edit: the save already
  // showed its error, and a timer loop would repeat it every few seconds.
  const autosaveFailedOn = useRef<Page | null>(null);
  // ADR 0836 D3 — not on a SCHEDULED draft unless the caller is known to be an
  // admin: a non-admin save cancels the schedule, and that must be a decision
  // (the confirm in `save`), never a keystroke pause.
  const autosaveDraft = selected?.status === 'draft' && !translatorSurface && !(selected.scheduledPublishAt && canAdmin !== true);
  useEffect(() => {
    if (!dirty || !autosaveDraft || busy || saveConflict || autosaveFailedOn.current === selected) return;
    const attempt = selected;
    const handle = setTimeout(() => {
      void save({ silent: true }).then((ok) => { autosaveFailedOn.current = ok ? null : attempt; });
    }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
  }, [dirty, autosaveDraft, busy, saveConflict, save, selected, seo]);
  // ADR 0836 D6 — what a non-admin may not change (the server's live tier): a
  // live or scheduled page's search fields, and a shared section a live or
  // scheduled page renders. Shown read-only with the reason, not offered and 403'd.
  const seoLocked = knownNotAdmin && !!selected && (selected.status !== 'draft' || !!selected.scheduledPublishAt);
  const sharedLocked = knownNotAdmin && (sharedImpact ?? []).some((p) => (p.status !== undefined && p.status !== 'draft') || !!p.scheduledPublishAt);
  const saveState: 'saving' | 'unsaved' | 'unsavedLive' | 'saved' = saving
    ? 'saving'
    : dirty ? (selected?.status === 'published' ? 'unsavedLive' : 'unsaved') : 'saved';

  // Preview honesty (ADR 0204 C4): resolve shared-section refs the way delivery
  // does, so a ref block never previews blank. Shared by the Outline + Public views.
  // CMS2-B5 — the three-case rule (resolved / genuinely gone / READ FAILED)
  // lives in `resolveSharedRefs`, where it can be tested. Inline in this memo it
  // could not be, and the missing third case shipped.
  const resolvedSections = useMemo<Section[]>(
    () => resolveSharedRefs(selected?.sections ?? [], sharedSections, sharedFailed),
    [selected, sharedSections, sharedFailed],
  );

  // ADR 0592 §5 — the Public preview resolved for the chosen locale via the
  // client-side mirror of the normative exact→family→base merge, so the editor
  // can SEE the localized page (draft overlays included) before shipping it.
  // The fallback count feeds the honesty badge — a mixed-language page is
  // exactly what a visitor would get, so the preview says so instead of
  // pretending the locale is complete.
  const effectivePreviewLocale = previewLocale || baseLocale;
  // Review F5 (ADR 0592 §Corrections) — withheld locales resolve in the
  // preview exactly as delivery serves them: overlays stripped pre-merge.
  const withheldLocales = useMemo(
    () => Object.entries(selected?.localePublishState ?? {}).filter(([, v]) => v === 'draft').map(([l]) => l),
    [selected],
  );
  const previewingWithheld = effectivePreviewLocale !== baseLocale && withheldLocales.includes(effectivePreviewLocale);
  const previewResolved = useMemo(
    () => resolvePreviewSections(resolvedSections, effectivePreviewLocale, baseLocale, { withheld: withheldLocales }),
    [resolvedSections, effectivePreviewLocale, baseLocale, withheldLocales],
  );

  // The header's "More" menu: occasional actions.
  const headerMoreItems = !selected ? [] : [
    ...(!translatorSurface && (selected.status === 'draft' || selected.status === 'in_review') ? [{
      id: 'assistant',
      label: <><SparklesIcon size={13} /> {t('askContentEditor')}</>,
      onSelect: () => { stageComposerDraft(t('askContentEditorSeed', { title: selected.title })); void navigate(`/?agent=${encodeURIComponent(CMS_CONTENT_EDITOR_AGENT)}`); },
    }] : []),
    ...(locales.length > 1 ? [{
      id: 'localizer',
      label: <><SparklesIcon size={13} /> {t('askLocalizer')}</>,
      onSelect: () => void navigate(`/?agent=${encodeURIComponent(CMS_LOCALIZER_AGENT)}`),
    }] : []),
    ...(!translatorSurface ? [{
      id: 'a11y',
      label: <><ShieldIcon size={13} /> {t('a11y:panelCheck')}</>,
      onSelect: () => setA11yIssues(checkContentA11y(cmsPageToA11yModel(selected.sections))),
    }] : []),
  ];

  // The editing card of one section, drawn in place on the Edit tab: its name,
  // Done, AI actions (not on the translator surface or a shared reference) and
  // the section's fields, translations and locale state.
  const renderSectionEditor = (sectionId: string): JSX.Element | null => {
    if (!selected) return null;
    const sec = selected.sections.find((x) => x.sectionId === sectionId);
    if (!sec) return null;
    return (
      <div className="cms-cv-editor-body">
        <div className="cms-cv-editor-head">
          <strong className="u-flex-1">{sectionLabel(sec) || t(`sectionType_${sec.type}`, { defaultValue: sec.type })}</strong>
          <span className="u-label-sm">{t('canvasEscHint')}</span>
          <Button variant="primary" size="sm" onClick={closeEditor}>{t('canvasDone')}</Button>
        </div>
                                <SectionsEditor
                                  key={sectionId}
                                  sections={[sec]}
                                  structureElsewhere
                                  assets={assets}
                                  baseLocale={baseLocale}
                                  locales={locales}
                                  translatorMode={translatorSurface}
                                  onPickMedia={pickMedia}
                                  sharedSections={sharedSections}
                                  sharedFailed={sharedFailed}
                                  {...(translatorSurface ? {} : { onSaveShared: (s: Section) => void saveAsShared(s) })}
                                  localeState={selected.localePublishState ?? {}}
                                  translationStatus={trStatus?.sections}
                                  // CMSL2UX-6 — a translator may confirm only on a draft (the server's tier).
                                  onConfirmSource={translatorSurface && selected.status !== 'draft' ? undefined : confirmSource}
                                  {...(translatorSurface ? {} : { onSetLocaleState: (locale: string, state: 'published' | 'draft') => {
                                    void setLocalePublish(orgId, selected.pageId, locale, state)
                                      .then((p) => {
                                        // Merge like the schedule result — locale state is a
                                        // server-owned field; local edits stay intact.
                                        const mergeState = (prev: Page | null): Page => {
                                          if (!prev) return p;
                                          const next: Page = { ...prev, version: p.version, updatedAt: p.updatedAt };
                                          if (p.localePublishState) next.localePublishState = p.localePublishState;
                                          else delete next.localePublishState;
                                          return next;
                                        };
                                        setSelected(mergeState); setSavedPage(mergeState);
                                        toast.success(state === 'draft' ? t('localeWithheldToast', { locale }) : t('localePublishedToast', { locale }));
                                      })
                                      .catch((e) => toast.error(apiErrMsg(e, t('actionFailed', { action: 'locale-publish' }))));
                                  } })}
                                  onChange={(slice) => setSelected((p) => {
                                    if (!p) return p;
                                    const i = p.sections.findIndex((x) => x.sectionId === sectionId);
                                    if (i < 0) return p;
                                    return { ...p, sections: [...p.sections.slice(0, i), ...slice, ...p.sections.slice(i + 1)] };
                                  })}
                                  onTranslate={async (sectionType, data, targetLocale) => {
                                    try {
                                      const overlay = await translateSection(orgId, { sectionType, data, targetLocale });
                                      if (!overlay || Object.keys(overlay).length === 0) {
                                        toast.error(t('translateEmpty'));
                                        return null;
                                      }
                                      return overlay;
                                    } catch (e) {
                                      toast.error(apiErrMsg(e, t('translateUnavailable')));
                                      return null;
                                    }
                                  }}
                                />
        {!translatorSurface && !sec.ref ? (
                                  <SectionAiBar
                                    key={`ai-${sectionId}`}
                                    orgId={orgId}
                                    section={sec}
                                    errorMessage={(e) => apiErrMsg(e, t('aiFailed'))}
                                    onApply={(data) => setSelected((p) => (p ? { ...p, sections: p.sections.map((x) => (x.sectionId === sectionId ? { ...x, data } : x)) } : p))}
                                  />
                                ) : null}
      </div>
    );
  };

  // The per-page "…" overflow menu on the collection landing (grid + list).
  const pageMenu = (p: Page): JSX.Element => (
    <Menu
      label={t('pageMenuLabel', { title: p.title })}
      triggerClassName="btn-ghost btn-sm"
      triggerContent={<MoreHorizontalIcon size={16} />}
      align="end"
      portal
      items={[
        { id: 'edit', label: <><PencilIcon size={13} /> {t('menuEdit')}</>, onSelect: () => openPage(p.pageId) },
        { id: 'clone', label: <><CopyIcon size={13} /> {t('menuClone')}</>, onSelect: () => void clone(p) },
        { id: 'sep', separator: true },
        { id: 'delete', label: <><TrashIcon size={13} /> {t('menuDelete')}</>, onSelect: () => void remove(p) },
      ]}
    />
  );

  const orgPicker = pickerOrgs.length > 0 ? (
    <select
      value={orgId}
      onChange={(e) => {
        const next = e.target.value;
        // CMSLU-2 — an org switch closes the editor; confirm a dirty discard
        // first (the controlled select snaps back when declined).
        void confirmDiscard().then((ok) => { if (ok) { setOrgId(next); navigate(indexPath); } });
      }}
      className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {isSiteAdmin ? (
        <>
          <optgroup label={t('systemScopeGroup')}>
            <option value={SYSTEM_SITE_ORG}>{t('frontPageScope')}</option>
          </optgroup>
          {orgs && orgs.length > 0 ? (
            <optgroup label={t('ui:orgPickerGroupLabel')}>
              {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
            </optgroup>
          ) : null}
        </>
      ) : (
        pickerOrgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)
      )}
    </select>
  ) : undefined;

  return (
    <div data-walkthrough="cms.page">
      <PageHeader eyebrow={t('headerEyebrow')} title={translatorSurface ? t('translatorHeaderTitle') : t('headerTitle')} lede={translatorSurface ? t('translatorHeaderLede') : t('headerLede')} actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* A failed ORGANIZATION read is disclosed even when the page still WORKS.
          For a site admin `pickerOrgs` is non-empty regardless (the Front-page
          scope is synthetic), so without this the page renders perfectly while
          every real organization is missing from the picker — the failure would
          be invisible by construction. The Front-page scope stays usable:
          blocking it would be a bigger lie than the one being fixed.

          HG-4 round 2 — this Notice used to say "The workspace list could not be
          read … it does not mean you have no organizations": the wrong
          collection, three lines above a shared card saying "organizations", and
          then the same clause twice (§4.6 rule 2). One noun, one consequence. */}
      {orgsFailed ? (
        <Notice variant="warning" announce={t('orgsFailedBody')}>
          {t('orgsFailedBody')}{' '}
          <Button variant="link" onClick={retryOrgs}>{t('orgsRetry')}</Button>
        </Notice>
      ) : null}

      {/* HG-4 — the noun and the ORDER are `OrgSelectionState`'s. The title, the
          body, and the body's own second clause all disagreed on this page
          before; now there is one voice and no local branch to reorder.
          `orgs=` is the SITE-ADMIN adjustment, not a clever prop: for a site
          admin the picker is never empty (the Front-page scope is synthetic and
          always offered), so the zero-org card must not fire and the failure
          card must not lock them out of the public homepage editor — the
          warning Notice above is their disclosure. For everyone else it is the
          plain org list, `null` while reading, so the skeleton below stays the
          loading state. */}
      <OrgSelectionState
        orgs={isSiteAdmin ? pickerOrgs : orgs}
        orgsFailed={orgsFailed && !isSiteAdmin}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')}
        icon={<FileTextIcon />}
      >
      {translatorSurface && orgId && myGrantFailed ? (
        <StateCard icon={<ShieldIcon size={20} />} title={t('translatorGrantFailedTitle')} body={t('translatorGrantFailedBody')} announce />
      ) : translatorSurface && orgId && myGrant === undefined ? <Skeleton /> : translatorSurface && orgId && myGrant === null ? (
        /* Honest empty state — an ACCESS statement, not a content statement:
           it makes no claim about what pages exist or whether localization is
           configured; it names the one next action (an admin grants locales). */
        <StateCard icon={<GlobeIcon size={20} />} title={t('translatorNoGrantTitle')} body={t('translatorNoGrantBody')} />
      ) : orgs === null && !isSiteAdmin ? <Skeleton /> : (
        <>
        {/* Front-page collapse (ADR 0027): when the reserved system scope is
            selected, lead with a clear notice + the "show at /" switch — this is
            the public homepage, not an org workspace. Replaces the standalone
            Front-page admin panel. */}
        {!selected && isSystemScope && siteConfig ? (
          <section className="surface-card u-grid u-gap-2 u-mb-2">
            <h2 className="u-fs-16 u-m-0">{t('frontPageScope')}</h2>
            <p className="u-m-0">{t('frontPageBanner')}</p>
            <label className="u-flex u-gap-2 u-items-center">
              <input
                type="checkbox"
                checked={siteConfig.enabled}
                disabled={siteBusy}
                onChange={(e) => void toggleSiteEnabled(e.target.checked)}
              />
              <span className="u-label-sm">{t('frontPageEnabledLabel')}</span>
            </label>
          </section>
        ) : null}
        {/* Org-level content settings (CMSUX-2): ONE disclosure for the
            org-scoped config — languages (ADR 0064) + shared sections
            (ADR 0204 C4) — so the page-level panels (History, Preview links)
            stay visually distinct from org configuration. */}
        {!selected && !translatorSurface ? (
        <details className="surface-card u-gap-2 u-mb-2">
          <summary className="u-label-sm">{t('orgSettingsHeading')}{settings && settings.supportedLocales.length > 0 ? ` · ${t('orgSettingsLocaleCount', { count: settings.supportedLocales.length })}` : ''}{sharedSections.length > 0 ? ` · ${t('sharedHeading', { count: sharedSections.length })}` : ''}</summary>
          <div className="u-mt-2 u-grid u-gap-3">
            <CmsLanguageSettings orgId={orgId} onChange={setSettings} />
            {/* CMS2-B5 — the fourth consequence of the one swallowed read: with
                `sharedSections` at `[]` this whole section simply vanished, so
                the org config screen quietly asserted there are no shared
                sections to manage. */}
            {sharedFailed ? (
              <Notice variant="warning" announce={t('sharedListFailed')}>{t('sharedListFailed')}</Notice>
            ) : null}
            {sharedSections.length > 0 ? (
              <div className="u-grid u-gap-1">
                <span className="u-label-sm">{t('sharedHeading', { count: sharedSections.length })}</span>
                {sharedSections.map((sh) => (
                  <div key={sh.sharedSectionId} className="u-flex u-gap-2 u-items-center u-wrap">
                    <span className="chip chip--accent">{t(`sectionType_${sh.type}`, { defaultValue: sh.type })}</span>
                    <span className="u-flex-1">{sh.name}</span>
                    <span className="u-label-sm">v{sh.version}</span>
                    <IconButton label={t('sharedEditLabel', { name: sh.name })} icon={<PencilIcon />} className="btn-ghost" onClick={() => openSharedEditor(sh)} />
                    <IconButton label={t('sharedDeleteLabel', { name: sh.name })} icon={<TrashIcon />} className="btn-ghost" onClick={() => void removeShared(sh)} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </details>
        ) : null}

        {!selected ? (
          /* ── Collection landing: list / grid + per-item "…" menu (§4.5 rule 11) ── */
          <>
            <div className="u-flex u-gap-2 u-items-center u-wrap u-mb-3">
              <SearchIcon size={14} aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('filterSearchPlaceholder')} aria-label={t('filterSearchPlaceholder')} className="ui-input filterbar-search" />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | PageStatus)} aria-label={t('filterStatusAria')} className="u-w-auto">
                <option value="">{t('filterStatusAll')}</option>
                {PAGE_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
              </select>
              <input value={tagFilter} onChange={(e) => setTagFilter(e.target.value.trim().toLowerCase())} placeholder={t('filterTagPlaceholder')} aria-label={t('filterTagPlaceholder')} className="u-w-auto" />
              {pages && pages.length > 0 ? <ViewToggle value={view} onChange={setView} /> : null}
            </div>
            {!pages ? <Skeleton /> : pages.length === 0 ? (
              <StateCard
                icon={<FileTextIcon />}
                title={q || tagFilter || statusFilter ? t('noPagesMatch') : t('noPagesYet')}
                body={q || tagFilter || statusFilter ? undefined : t('noPagesYetBody')}
                {...(q || tagFilter || statusFilter
                  ? { action: <Button variant="secondary" size="sm" onClick={() => { setQ(''); setStatusFilter(''); setTagFilter(''); }}>{t('clearFilters')}</Button> }
                  : {})}
              />
            ) : view === 'grid' ? (
              <div className="card-grid">
                {pages.map((p) => (
                  <article key={p.pageId} className="surface-card u-grid u-gap-2">
                    <div className="u-flex u-gap-2 u-items-center">
                      <button type="button" className="linklike u-flex-1 u-minw-0 u-truncate u-fs-14" title={p.title} onClick={() => openPage(p.pageId)}><strong>{p.title}</strong></button>
                      {translatorSurface ? null : pageMenu(p)}
                    </div>
                    <div className="u-flex u-gap-2 u-items-center u-wrap">
                      <span className={statusChipClass(p.status)}>{t(`status_${p.status}`)}</span>
                      <span className="u-label-sm">/{p.slug} · v{p.version}</span>
                    </div>
                    {(p.tags ?? []).length > 0 ? <div className="u-flex u-gap-1 u-wrap">{(p.tags ?? []).map((tg) => <span key={tg} className="chip chip--muted">{tg}</span>)}</div> : null}
                    <span className="u-label-sm">{t('updatedAt', { at: formatDateTime(p.updatedAt) })}</span>
                  </article>
                ))}
              </div>
            ) : (
              <div className="surface-card list-view">
                {pages.map((p) => (
                  <div key={p.pageId} className="list-row">
                    <button type="button" className="list-row-id" title={p.title} onClick={() => openPage(p.pageId)}>
                      <span className="list-row-name-wrap">
                        <span className="list-row-name-line">
                          <span className="list-row-name u-truncate">{p.title}</span>
                          <span className={statusChipClass(p.status)}>{t(`status_${p.status}`)}</span>
                        </span>
                        <span className="u-label-sm">/{p.slug} · v{p.version}</span>
                      </span>
                    </button>
                    <span className="list-row-meta u-label-sm">{t('updatedAt', { at: formatDateTime(p.updatedAt) })}</span>
                    <span className="list-row-actions">{translatorSurface ? null : pageMenu(p)}</span>
                  </div>
                ))}
              </div>
            )}
            {translatorSurface ? null : (
            <div className="action-bar u-mt-3">
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('newPageTitlePlaceholder')} aria-label={t('newPageTitlePlaceholder')} className="u-w-auto" onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
              <Button variant="primary" size="sm" disabled={busy || !newTitle.trim()} onClick={() => void create()}><PlusIcon size={14} /> {t('newPageAction')}</Button>
            </div>
            )}
          </>
        ) : (
          /* ── Detail / edit ── */
          <div className="u-grid u-gap-4">
            <div className="u-flex u-gap-2 u-items-center u-wrap">
              <Button variant="quiet" className="u-w-auto" onClick={() => void confirmDiscard().then((ok) => { if (ok) navigate(indexPath); })}><ArrowLeftIcon size={14} /> {t('backToPages')}</Button>
              <strong className="u-fs-16 u-m-0">{selected.title}</strong>
              <span className={statusChipClass(selected.status)}>{t(`status_${selected.status}`)}</span>
              <span className="u-label-sm">/{selected.slug} · v{selected.version}</span>
              <span className="u-flex-1" />
              {/* Workflow actions live in the header so publish/unpublish are
                  reachable from any view (Public / Outline / Editor), not only
                  the Editor form. Authority is enforced server-side. */}
              {/* CFP C1 — the content-editor copilot had no surface entry point.
                  Offered while the page is editable (draft / in review), where its
                  governed draft-patch + submit verbs apply; publishing stays human.
                  Seed the ONE chat with the page context, then deep-link the agent. */}
              <span className="u-label-sm cms-save-state" role="status" data-state={saveState}>{t(`saveState_${saveState}`)}</span>
              {dirty || saveConflict ? (
                // A draft saves itself, so Save is secondary there; on a live page
                // it is the action that matters.
                <Button variant={selected.status === 'published' ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={() => void save()}><SaveIcon /> {t('saveAction')}</Button>
              ) : null}
              {/* The assistant links and the accessibility check are occasional:
                  one "More" menu instead of three more equal-weight buttons. */}
              {headerMoreItems.length > 0 ? (
                <Menu
                  label={t('headerMoreActions')}
                  triggerClassName="btn-ghost btn-sm"
                  triggerContent={<MoreHorizontalIcon size={16} />}
                  align="end"
                  items={headerMoreItems}
                  portal
                />
              ) : null}
              {!translatorSurface ? orderedActions(selected.status)
                // ADR 0859 D4 — never offer the submitter an Approve the server refuses;
                // the pending notice below says who has to decide instead.
                .filter((a) => !(a === 'approve' && (!reviewLoaded || (review?.status === 'pending' && review.awaitingAnotherApprover))))
                .map((a) => (
                <Button
                  key={a}
                  variant={a === PRIMARY_ACTION[selected.status] ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={busy}
                  aria-busy={busy}
                  // ADR 0593 (CMSAU-3) — on `in_review`, `submit` is a RE-submit:
                  // it re-pins the approval to what the reviewer will now read.
                  {...(a === 'reject' ? { ref: rejectBtnRef } : {})}
                  onClick={() => { if (a === 'reject') setRejectNote(''); else if (CHECKED_ACTIONS.has(a)) setPendingAction(a); else void runAction(a); }}
                >
                  {a === 'submit' && selected.status === 'in_review' ? t('action_resubmit')
                    // ADR 0859 D4 (CMSA2UX-4) — for the submitter, Reject is a withdrawal.
                    : a === 'reject' && review?.status === 'pending' && review.awaitingAnotherApprover ? t('action_withdraw')
                    : t(`action_${a}`, { defaultValue: a })}
                </Button>
              )) : null}
            </div>
            {settingsFailed ? (
              <Notice variant="warning" announce={t('langSettingsUnknown')}>{t('langSettingsUnknown')}</Notice>
            ) : null}
            {/* ADR 0593 D4 (CMSAU-5 / CMSA-9) — a rejection collects a REASON.
                This lane sent no body at all, so a reason typed anywhere here
                vanished while the inbox lane persisted one. */}
            {rejectNote !== null ? (
              <div className="surface-card u-grid u-gap-2">
                <label className="u-grid u-gap-1 u-fs-12">
                  <span className="u-label-sm">{t('rejectReasonLabel')}</span>
                  <textarea
                    className="input" rows={2} autoFocus maxLength={2000}
                    value={rejectNote}
                    placeholder={t('rejectReasonPlaceholder')}
                    onChange={(e) => setRejectNote(e.target.value)}
                  />
                </label>
                <span className="action-bar">
                  {/* F7(5) — the reason step used to unmount BEFORE the request
                      resolved, so a failed reject swapped the UI out from under
                      its own error toast and the typed reason was gone from the
                      screen. It now closes only on success.
                      F7(4) — and focus returns to the Reject button rather than
                      dropping to <body> (WCAG 2.4.3). */}
                  <Button variant="secondary" size="sm" disabled={busy} aria-busy={busy}
                    onClick={() => {
                      const note = rejectNote.trim() || undefined;
                      void runAction('reject', note).then((ok) => { if (ok) { setRejectNote(null); rejectBtnRef.current?.focus(); } });
                    }}
                  >{t('rejectSendLabel')}</Button>
                  <Button variant="quiet" size="sm" disabled={busy}
                    onClick={() => { setRejectNote(null); rejectBtnRef.current?.focus(); }}
                  >{t('rejectCancelLabel')}</Button>
                </span>
              </div>
            ) : null}
            {/* ADR 0593 D4 (CMSAU-5) — the rejected state is DISTINGUISHABLE
                from a fresh draft, and carries the reason. Without this a
                rejection was invisible: the page simply read `draft`. */}
            {/* ADR 0593 CORRECTION (review F4/F6/F7) — branch on `decidedBy`, not
                only on status. D2's whole attribution argument is that an
                AUTHORLESS closure says "the system did it"; that only holds if
                something READS the absent actor. This was the one new reader and
                it rendered `decidedBy` nowhere, so a routine `restoreVersion`, a
                `deletePage` cascade and the decide-arm backstop all read to the
                author as a human reviewer sending their page back.
                The announce carries the REASON — announcing the title alone left
                the entire point of CMSAU-5 unspoken. */}
            {selected.status === 'draft' && review?.status === 'rejected' ? (
              review.decidedBy ? (
                <Notice
                  variant="warning"
                  announce={`${t('reviewRejectedTitle')} ${review.note ?? t('reviewRejectedNoReason')}`}
                >
                  <strong>{t('reviewRejectedTitle')}</strong>
                  {review.note ? <div className="u-mt-1">{review.note}</div> : <div className="u-mt-1 muted">{t('reviewRejectedNoReason')}</div>}
                  <div className="u-mt-1 u-fs-12 muted">
                    {t('reviewRejectedMeta', { when: review.resolvedAt ? formatDateTime(review.resolvedAt) : '' })}
                    {' '}
                    {t('reviewRejectedBy', { who: review.decidedBy })}
                  </div>
                </Notice>
              ) : (
                <Notice variant="info" announce={`${t('reviewClosedTitle')} ${review.note ?? ''}`}>
                  <strong>{t('reviewClosedTitle')}</strong>
                  {review.note ? <div className="u-mt-1">{review.note}</div> : null}
                  <div className="u-mt-1 u-fs-12 muted">{t('reviewClosedMeta')}</div>
                </Notice>
              )
            ) : null}
            {selected.status === 'in_review' && review?.status === 'pending' ? (
              // F7(3) — a live region mounted WITH content announces nothing.
              <Notice
                variant="info"
                // ADR 0859 D4 (CMSA2UX-5) — the submitter's next step is spoken, not only shown.
                announce={`${t('reviewPendingBody', { version: review.pageVersion ?? selected.version })}${review.awaitingAnotherApprover ? ` ${t('reviewAwaitingOtherApprover')}` : ''}`}
              >
                {t('reviewPendingBody', { version: review.pageVersion ?? selected.version })}
                {review.awaitingAnotherApprover ? <div className="u-mt-1">{t('reviewAwaitingOtherApprover')}</div> : null}
                {/* ADR 0859 D5 (ADR 0594 D1) — what an approval here does not freeze. */}
                {review.liveReferenceSections?.length ? (
                  <div className="u-mt-1 u-fs-12 muted">{t('reviewLiveData', { count: review.liveReferenceSections.length })}</div>
                ) : null}
              </Notice>
            ) : null}
            {translatorSurface && myGrant ? (
              <div className="u-flex u-gap-1 u-items-center u-wrap">
                <span className="u-label-sm">{t('translatorAccessLine')}</span>
                {myGrant.locales.map((l) => <span key={l} className="chip">{l}</span>)}
              </div>
            ) : null}
                {/* Save conflict (ADR 0592 §1 / CMSLU-3): the page changed under
                    this editor. Their save survived; nothing local is discarded
                    until the user chooses. */}
                {selected.scheduledPublishAt && canAdmin !== true && !translatorSurface ? (
                  <Notice variant="warning">{t('scheduledEditWarning', { at: formatDateTime(selected.scheduledPublishAt) })}</Notice>
                ) : null}
                {saveConflict ? (
                  <Notice variant="warning" announce={t('saveConflictTitle')}>
                    <div className="u-grid u-gap-1">
                      <strong>{t('saveConflictTitle')}</strong>
                      <span>{t('saveConflictBody', { version: saveConflict.currentVersion })}</span>
                      <div className="u-flex u-gap-2 u-items-center">
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void conflictReload()}>{t('saveConflictReload')}</Button>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void conflictOverwrite()}>{t('saveConflictOverwrite')}</Button>
                      </div>
                    </div>
                  </Notice>
                ) : null}
            <div className="cms-mode-bar">
              <Tabs
                items={translatorSurface
                  ? [{ id: 'edit', label: t('workspaceModeEdit') }, { id: 'preview', label: t('workspaceModePreview') }]
                  : [{ id: 'edit', label: t('workspaceModeEdit') }, { id: 'preview', label: t('workspaceModePreview') }, { id: 'page', label: t('workspaceModePage') }]}
                value={workspaceMode}
                onChange={setWorkspaceMode}
                label={t('workspaceModeAria')}
                idBase="cms-mode"
                className="cms-mode-tabs"
              />
              {workspaceMode === 'edit' && resolvedSections.length > 0 ? (
                <Menu
                  label={t('sectionsMenuLabel')}
                  triggerClassName="secondary btn-sm"
                  triggerContent={<><ListIcon size={14} /> {t('sectionsMenu')}</>}
                  items={resolvedSections.map((s, i) => ({
                    id: s.sectionId,
                    label: `${String(i + 1).padStart(2, '0')} · ${sectionLabel(s) || t(`sectionType_${s.type}`, { defaultValue: s.type })}`,
                    onSelect: () => jumpToSection(s.sectionId),
                  }))}
                  portal
                />
              ) : null}
              {workspaceMode === 'edit' ? (
                <span className="u-flex u-gap-1">
                  <IconButton label={t('undoAction')} icon={<UndoIcon size={16} />} className="btn-ghost btn-sm" disabled={!canUndo} onClick={undo} />
                  <IconButton label={t('redoAction')} icon={<RedoIcon size={16} />} className="btn-ghost btn-sm" disabled={!canRedo} onClick={redo} />
                </span>
              ) : null}
              <span className="u-flex-1" />
              {outdatedSummary.length > 0 ? (
                /* ADR 0861 D6 — page-level: which locales hold translations of
                   text that has since changed. */
                <span className="chip chip--warning">{t('translationOutdatedSummary', { list: outdatedSummary.join(', ') })}</span>
              ) : trFailed ? (
                <span className="chip">{t('translationStatusUnavailable')}</span>
              ) : null}
              {workspaceMode !== 'page' && locales.length > 1 ? (
                <label className="u-flex u-gap-1 u-items-center">
                  <span className="u-label-sm">{t('previewLocaleLabel')}</span>
                  <select
                    className="u-w-auto"
                    value={previewLocale}
                    onChange={(e) => setPreviewLocale(e.target.value)}
                    aria-label={t('previewLocaleLabel')}
                  >
                    {locales.map((l) => (
                      <option key={l} value={l === baseLocale ? '' : l}>
                        {l === baseLocale
                          ? t('previewLocaleBase', { locale: l })
                          : withheldLocales.includes(l) ? t('previewLocaleWithheldOption', { locale: l }) : l}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {workspaceMode !== 'page' ? (
                <label className="u-flex u-gap-1 u-items-center">
                  <span className="u-label-sm">{t('previewDeviceLabel')}</span>
                  <select className="u-w-auto" value={previewDevice} onChange={(e) => setPreviewDevice(e.target.value as PreviewDevice)} aria-label={t('previewDeviceLabel')}>
                    <option value="desktop">{t('deviceDesktop')}</option>
                    <option value="tablet">{t('deviceTablet')}</option>
                    <option value="mobile">{t('deviceMobile')}</option>
                  </select>
                </label>
              ) : null}
            </div>
            <TabPanel idBase="cms-mode" tabId={workspaceMode}>
            {workspaceMode === 'page' ? (
                <div className="cms-page-settings">
                <section className="cms-page-group" aria-labelledby="cms-pg-basics">
                  <h2 id="cms-pg-basics" className="u-fs-16 u-m-0">{t('pageGroupBasics')}</h2>
                  {/* Review F1 — title/tags are BASE page chrome: immutable to a
                                            grant-holder (server 403s on field PRESENCE), so translator
                                            mode renders neither editor (capability ≠ permission). */}
                                        {translatorSurface ? null : (
                                        <label className="u-grid u-gap-1">
                                          <span className="u-label-sm">{t('titleLabel')}</span>
                                          <input value={selected.title} onChange={(e) => setSelected((p) => (p ? { ...p, title: e.target.value } : p))} />
                                        </label>
                                        )}

                                        {/* The page's address. The server applies the same slug rules and
                                            adds a suffix if another page has it; a published page keeps
                                            a redirect from the old address. */}
                                        {translatorSurface ? null : (
                                        <label className="u-grid u-gap-1">
                                          <span className="u-label-sm">{t('pageAddressLabel')}</span>
                                          <span className="cms-address">
                                            <span className="cms-address-prefix" aria-hidden="true">{selected.kind === 'post' ? '/blog/' : '/'}</span>
                                            <input
                                              value={selected.slug}
                                              spellCheck={false}
                                              onChange={(e) => { const slug = typedSlug(e.target.value); setSelected((p) => (p ? { ...p, slug } : p)); }}
                                            />
                                          </span>
                                          {selected.status === 'published' && savedPage && selected.slug !== savedPage.slug ? (
                                            <span className="u-label-sm">{t('pageAddressRedirectNote')}</span>
                                          ) : null}
                                        </label>
                                        )}

                                        {/* Tags (ADR 0206 B3) — chips + add input; saved with the page. */}
                                        {translatorSurface ? null : (
                                        <div className="u-grid u-gap-1">
                                          <span className="u-label-sm">{t('tagsLabel')}</span>
                                          <div className="u-flex u-gap-1 u-items-center u-wrap">
                                            {(selected.tags ?? []).map((tag) => (
                                              <button
                                                key={tag}
                                                type="button"
                                                className="chip"
                                                aria-label={t('removeTagLabel', { tag })}
                                                title={t('removeTagLabel', { tag })}
                                                onClick={() => setSelected((p) => (p ? { ...p, tags: (p.tags ?? []).filter((x) => x !== tag) } : p))}
                                              >
                                                {tag} <XIcon size={11} />
                                              </button>
                                            ))}
                                            <input
                                              value={newTag}
                                              onChange={(e) => setNewTag(e.target.value)}
                                              placeholder={t('tagsPlaceholder')}
                                              aria-label={t('tagsPlaceholder')}
                                              className="u-w-auto"
                                              onKeyDown={(e) => {
                                                if (e.key !== 'Enter') return;
                                                e.preventDefault();
                                                const tag = newTag.trim().toLowerCase();
                                                if (!tag) return;
                                                setSelected((p) => (p && !(p.tags ?? []).includes(tag) ? { ...p, tags: [...(p.tags ?? []), tag] } : p));
                                                setNewTag('');
                                              }}
                                            />
                                          </div>
                                        </div>
                                        )}
                </section>
                <section className="cms-page-group" aria-labelledby="cms-pg-post">
                  <h2 id="cms-pg-post" className="u-fs-16 u-m-0">{t('pageGroupPost')}</h2>
                  {/* ADR 0813 — post settings: list the page on the public blog,
                                            its category, and the byline (`'me'` resolves server-side). */}
                                        {translatorSurface ? null : (
                                        <div className="u-grid u-gap-2">
                                          <label className="u-flex u-gap-2 u-items-center">
                                            <input
                                              type="checkbox"
                                              checked={selected.kind === 'post'}
                                              onChange={(e) => setSelected((p) => (p ? { ...p, kind: e.target.checked ? 'post' : 'page' } : p))}
                                            />
                                            <span>{t('postKindToggle')}</span>
                                          </label>
                                          {selected.kind === 'post' ? (
                                            <>
                                              <label className="u-grid u-gap-1">
                                                <span className="u-label-sm">{t('postCategoryLabel')}</span>
                                                <input
                                                  value={selected.category ?? ''}
                                                  placeholder={t('postCategoryPlaceholder')}
                                                  onChange={(e) => setSelected((p) => (p ? { ...p, category: e.target.value } : p))}
                                                />
                                              </label>
                                              <div className="u-grid u-gap-1">
                                                <span className="u-label-sm">{t('postAuthorLabel')}</span>
                                                <div className="u-flex u-gap-2 u-items-center u-wrap">
                                                  <span className="u-label-sm">
                                                    {selected.authorId === 'me' ? t('postAuthorPendingMe') : selected.authorId ? t('postAuthorSet') : t('postAuthorUnset')}
                                                  </span>
                                                  <Button size="sm" variant="secondary" onClick={() => setSelected((p) => (p ? { ...p, authorId: 'me' } : p))}>{t('postAuthorSetMe')}</Button>
                                                  {selected.authorId ? (
                                                    <Button size="sm" variant="quiet" onClick={() => setSelected((p) => (p ? { ...p, authorId: null } : p))}>{t('postAuthorClear')}</Button>
                                                  ) : null}
                                                </div>
                                              </div>
                                            </>
                                          ) : null}
                                        </div>
                                        )}
                </section>
                <section className="cms-page-group">
                  {/* Search and social: what search results and link previews show. */}
                                        {translatorSurface ? null : (
                                        <section className="u-grid u-gap-2" aria-labelledby="cms-seo-heading">
                                          <h3 id="cms-seo-heading" className="u-fs-14 u-m-0">{t('seoHeading')}</h3>
                                          {seoFailed ? (
                                            <Notice variant="warning" announce={t('seoReadFailed')}>{t('seoReadFailed')}</Notice>
                                          ) : !seo ? <Skeleton /> : (
                                            <>
                                              {seoLocked ? <Notice variant="info">{t('seoLiveTierReadOnly')}</Notice> : null}
                                              <label className="u-grid u-gap-1">
                                                <span className="u-flex u-gap-2 u-items-center">
                                                  <span className="u-label-sm u-flex-1">{t('seoDescriptionLabel')}</span>
                                                  <span className="u-label-sm" aria-live="polite">{t('seoDescriptionCount', { count: (seo.metaDescription ?? '').length })}</span>
                                                </span>
                                                <textarea
                                                  rows={3}
                                                  value={seo.metaDescription ?? ''}
                                                  readOnly={seoLocked}
                                                  aria-describedby="cms-seo-description-hint"
                                                  onChange={(e) => { const metaDescription = e.target.value; setSeo((cur) => (cur ? { ...cur, metaDescription } : cur)); }}
                                                />
                                                <span id="cms-seo-description-hint" className="u-label-sm">{t('seoDescriptionHint')}</span>
                                              </label>
                                              <div className="u-grid u-gap-1">
                                                <span className="u-label-sm">{t('seoImageLabel')}</span>
                                                <div className="u-flex u-gap-2 u-items-center u-wrap">
                                                  {seo.ogImageToken ? (
                                                    <img className="cms-seo-thumb" src={assetUrl(seo.ogImageToken)} alt="" />
                                                  ) : (
                                                    <span className="u-label-sm">{t('seoImageNone')}</span>
                                                  )}
                                                  {seoLocked ? null : <Button size="sm" variant="secondary" onClick={() => { void pickMedia().then((token) => { if (token) setSeo((cur) => (cur ? { ...cur, ogImageToken: token } : cur)); }); }}>{t('seoImageChoose')}</Button>}
                                                  {seo.ogImageToken && !seoLocked ? (
                                                    <Button size="sm" variant="quiet" onClick={() => setSeo((cur) => { if (!cur) return cur; const { ogImageToken: _drop, ...rest } = cur; return rest; })}>{t('seoImageRemove')}</Button>
                                                  ) : null}
                                                </div>
                                              </div>
                                            </>
                                          )}
                                        </section>
                                        )}
                </section>
                <section className="cms-page-group" aria-labelledby="cms-pg-publishing">
                  <h2 id="cms-pg-publishing" className="u-fs-16 u-m-0">{t('pageGroupPublishing')}</h2>
                  <div className="action-bar">
                                          {/* Scheduled publish (ADR 0204 C2): admin-set one-shot; the
                                              backend 409s when the approval gate is ON. Hidden on the
                                              translator surface (admin authority; would only 403). */}
                                          {!translatorSurface && (selected.status === 'draft' || selected.status === 'in_review') ? (
                                            selected.scheduledPublishAt ? (
                                              <span className="u-flex u-gap-1 u-items-center">
                                                <span className="chip chip--warning"><ClockIcon size={12} /> {t('scheduledChip', { at: formatDateTime(selected.scheduledPublishAt) })}</span>
                                                {knownNotAdmin ? null : <Button variant="quiet" className="u-w-auto" onClick={() => void unschedule()}>{t('scheduleCancel')}</Button>}
                                              </span>
                                            ) : knownNotAdmin ? null : (
                                              <label className="u-flex u-gap-1 u-items-center">
                                                <span className="u-label-sm">{t('scheduleAtLabel')}</span>
                                                <input
                                                  type="datetime-local"
                                                  value={scheduleAt}
                                                  onChange={(e) => setScheduleAt(e.target.value)}
                                                  className="u-w-auto"
                                                />
                                                <Button variant="quiet" className="u-w-auto" disabled={!scheduleAt} onClick={() => void schedule()}>
                                                  <ClockIcon size={13} /> {t('scheduleSetAction')}
                                                </Button>
                                              </label>
                                            )
                                          ) : null}
                                          {/* Scheduled unpublish (ADR 0204 C2b): legal while published,
                                              or paired with a pending publish (then it must be later —
                                              the backend validates the ordering). Ungated: removing
                                              content is the fail-safe direction. */}
                                          {!translatorSurface && (selected.status === 'published' || selected.scheduledUnpublishAt || ((selected.status === 'draft' || selected.status === 'in_review') && selected.scheduledPublishAt)) ? (
                                            selected.scheduledUnpublishAt ? (
                                              <span className="u-flex u-gap-1 u-items-center">
                                                <span className="chip chip--warning"><ClockIcon size={12} /> {t('scheduledUnpublishChip', { at: formatDateTime(selected.scheduledUnpublishAt) })}</span>
                                                {/* Distinct accessible name: with the embargo pair pending, TWO
                                                    cancel buttons render — SR users need to know which lane. */}
                                                {knownNotAdmin ? null : <Button variant="quiet" className="u-w-auto" aria-label={t('scheduleUnpublishCancelAria')} onClick={() => void doCancelScheduleUnpublish()}>{t('scheduleCancel')}</Button>}
                                              </span>
                                            ) : knownNotAdmin ? null : (
                                              <label className="u-flex u-gap-1 u-items-center">
                                                <span className="u-label-sm">{t('scheduleUnpublishAtLabel')}</span>
                                                <input
                                                  type="datetime-local"
                                                  value={unpublishAt}
                                                  onChange={(e) => setUnpublishAt(e.target.value)}
                                                  className="u-w-auto"
                                                />
                                                <Button variant="quiet" className="u-w-auto" disabled={!unpublishAt} onClick={() => void doScheduleUnpublish()}>
                                                  <ClockIcon size={13} /> {t('scheduleUnpublishSetAction')}
                                                </Button>
                                              </label>
                                            )
                                          ) : null}
                                        </div>
                                      {/* Preview links (ADR 0204 C3) — sharing owns mint/revoke/expiry;
                                          this panel is the CMS affordance over it. Keyed by page (same
                                          remount rule as History). */}
                                      {translatorSurface ? null : (
                                      <details
                                        key={`pl-${selected.pageId}`}
                                        className="surface-card u-gap-2"
                                        onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && previewLinks === null) loadPreviewLinks(selected.pageId); }}
                                      >
                                        <summary className="u-label-sm"><LinkIcon size={13} /> {t('previewLinksHeading')}</summary>
                                        <div className="u-grid u-gap-1 u-mt-2">
                                          <div className="u-flex u-gap-1 u-items-center">
                                            <span className="u-label-sm u-flex-1">{t('previewLinksLede')}</span>
                                            <Button variant="quiet" className="u-w-auto" onClick={() => void createPreviewLink()}><PlusIcon size={13} /> {t('previewLinkCreate')}</Button>
                                          </div>
                                          {!previewLinks ? <Skeleton /> : previewLinksFailed ? (
                                            <span className="u-label-sm">{t('previewLinksFailed')}</span>
                                          ) : previewLinks.length === 0 ? (
                                            <span className="u-label-sm">{t('previewLinksEmpty')}</span>
                                          ) : previewLinks.map((l) => (
                                            // ADR 0448 P2 — hashed at rest: the URL was copied at mint and
                                            // cannot be re-read; the fingerprint identifies the link.
                                            <div key={l.tokenHash} className="u-flex u-gap-2 u-items-center u-wrap">
                                              <span className="u-label-sm u-flex-1">{l.label ?? l.tokenHash.slice(0, 8)}{l.expiresAt ? ` · ${t('previewLinkExpires', { at: formatDateTime(l.expiresAt) })}` : ''}</span>
                                              <Button
                                                variant="quiet" className="u-w-auto"
                                                onClick={() => { void revokeLink(orgId, l.tokenHash).then(() => { loadPreviewLinks(selected.pageId); toast.success(t('previewLinkRevoked')); }).catch((e) => toast.error(apiErrMsg(e, t('previewLinkFailed')))); }}
                                              >{t('previewLinkRevoke')}</Button>
                                            </div>
                                          ))}
                                        </div>
                                      </details>
                                      )}
                </section>
                <section className="cms-page-group">
                  {/* Version history (ADR 0206 B1) — lazy; one read per open. Keyed
                                          by page so switching pages remounts it CLOSED (an open panel
                                          would otherwise strand on a skeleton — versions reset lazily). */}
                                      {translatorSurface ? null : (
                                      <details
                                        key={selected.pageId}
                                        className="surface-card u-gap-2"
                                        onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && versions === null) loadVersions(selected.pageId); }}
                                      >
                                        <summary className="u-label-sm"><ClockIcon size={13} /> {t('historyHeading')}</summary>
                                        <div className="u-grid u-gap-1 u-mt-2">
                                          {versionsFailed ? (
                                            <span className="u-label-sm">{t('historyFailed')}</span>
                                          ) : !versions ? <Skeleton /> : versions.length === 0 ? (
                                            <span className="u-label-sm">{t('historyEmpty')}</span>
                                          ) : versions.map((v) => (
                                            <div key={v.versionId} className="u-flex u-gap-2 u-items-center u-wrap">
                                              {v.origin === 'seed'
                                                ? <span className="chip chip--accent" title={t('historySeedOfferHint')}>{t('historySeedOffer')}</span>
                                                : <span className="chip chip--muted">v{v.version}</span>}
                                              <span className="u-label-sm">{formatDateTime(v.publishedAt)} · {v.publishedBy}</span>
                                              <span className="u-flex-1" />
                                              <Button variant="quiet" className="u-w-auto" onClick={() => setDiffVersion(v)}>{t('historyDiff')}</Button>
                                              {knownNotAdmin ? null : (
                                                <Button variant="quiet" className="u-w-auto" onClick={() => void restore(v.versionId, v.version)}>
                                                  <RotateCwIcon size={13} /> {t('historyRestore')}
                                                </Button>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      </details>
                                      )}
                </section>
                <section className="cms-page-group">
                  {/* Page experiments (ADR 0236 — campaign gap D1): variants over the
                                          page's captured versions, consent-gated visitor assignment on
                                          the public read, promote-winner via restore→publish. */}
                                      {translatorSurface ? null : (
                                      <PageExperimentsPanel
                                        orgId={orgId}
                                        pageId={selected.pageId}
                                        versions={versions}
                                        onLoadVersions={() => loadVersions(selected.pageId)}
                                        onPageChanged={() => { open(selected.pageId); loadPages(orgId); }}
                                      />
                                      )}
                </section>
                </div>

            ) : (
              <div className="cms-ws-canvas">
                {effectivePreviewLocale !== baseLocale && resolvedSections.length > 0 ? (
                  <div className="u-flex u-gap-1 u-items-center u-wrap">
                    <span className="chip chip--accent">{t('previewLocaleChip', { locale: effectivePreviewLocale })}</span>
                    {previewingWithheld ? (
                      /* Review F5 — a withheld locale must never read as "complete":
                         visitors currently get base; the preview says so. */
                      <span className="chip chip--warning">{t('previewLocaleWithheldBadge', { locale: effectivePreviewLocale, base: baseLocale })}</span>
                    ) : previewResolved.fallbackCount > 0 ? (
                      <span className="u-label-sm">{t('previewLocaleFallback', { count: previewResolved.fallbackCount, total: resolvedSections.length, base: baseLocale })}</span>
                    ) : (
                      <span className="u-label-sm">{t('previewLocaleComplete')}</span>
                    )}
                  </div>
                ) : null}
                {resolvedSections.length === 0 ? (
                  <StateCard
                    icon={<FileTextIcon />}
                    title={t('previewEmpty')}
                    {...(workspaceMode === 'edit' && !translatorSurface
                      ? { action: <Button variant="primary" size="sm" onClick={() => setInsertAt(0)}><PlusIcon size={14} /> {t('canvasAddFirst')}</Button> }
                      : {})}
                  />
                ) : (
                  <div className="cms-preview-stage">
                    <div className="cms-preview-device" style={DEVICE_MAXW[previewDevice] ? { maxWidth: DEVICE_MAXW[previewDevice] } : undefined}>
                      <PublicPreviewFrame title={t('previewModePublic')} onDocument={setFrameDoc}>
                        {workspaceMode === 'edit' ? (
                          <CmsCanvas
                            sections={previewResolved.sections}
                            editingId={editingSectionId}
                            selectedId={selectedSectionId}
                            structure={!translatorSurface}
                            renderEditor={renderSectionEditor}
                            handlers={{
                              onEdit: selectSection,
                              onCloseEditor: closeEditor,
                              onMove: moveSection,
                              onReorder: reorderSection,
                              onDuplicate: duplicateSection,
                              onRemove: (id) => void removeSection(id),
                              onInsertAt: setInsertAt,
                            }}
                          />
                        ) : (
                          <RenderSections sections={previewResolved.sections} mode="public" />
                        )}
                      </PublicPreviewFrame>
                    </div>
                  </div>
                )}
              </div>
            )}
            </TabPanel>
          </div>
        )}
        </>
      )}
      </OrgSelectionState>

      {/* Add a section at an insertion point on the Edit tab. */}
      {insertAt !== null ? (
        <SectionPicker
          sharedSections={sharedSections}
          onPick={(section) => insertSection(insertAt, section)}
          onClose={() => setInsertAt(null)}
        />
      ) : null}

      {/* Review before Publish / Approve / Submit (ADR 0828 phase 3). */}
      {pendingAction && selected ? (
        <PublishChecklist
          page={selected}
          action={pendingAction}
          checks={publishChecks(selected, seo, { baseLocale, locales })}
          busy={busy}
          onConfirm={() => { const a = pendingAction; void runAction(a).then((ok) => { if (ok) setPendingAction(null); }); }}
          onFix={(c) => {
            setPendingAction(null);
            if (c.sectionId) selectSection(c.sectionId);
            else setWorkspaceMode('page');
          }}
          onClose={() => setPendingAction(null)}
        />
      ) : null}

      {/* Media picker (ADR 0206 B4) — resolves the in-flight pick. */}
      {pickerResolve ? (
        <MediaPickerDialog
          orgId={orgId}
          onSelect={(asset) => { pickerResolve(asset.serveToken ?? null); setPickerResolve(null); }}
          onClose={() => { pickerResolve(null); setPickerResolve(null); }}
        />
      ) : null}

      {/* Field-level version diff (ADR 0206 B1) — snapshot vs the CURRENT editor content. */}
      {diffVersion && selected ? (
        <Modal onClose={() => setDiffVersion(null)} label={t('diffTitle', { version: diffVersion.version })} className="hire-modal cms-diff" showClose>
          <VersionDiff
            from={diffVersion}
            to={selected}
            onTake={(entry) => takeFromVersion(diffVersion, entry)}
            onUseWhole={() => { const v = diffVersion; setDiffVersion(null); void restore(v.versionId, v.version); }}
          />
        </Modal>
      ) : null}

      {/* Accessibility checker (ADR 0363 P2) — the shared authored-content check. */}
      {a11yIssues !== null ? (
        <Modal onClose={() => setA11yIssues(null)} label={t('a11y:panelTitle')} showClose>
          <A11yIssuesPanel issues={a11yIssues} />
        </Modal>
      ) : null}

      {/* Shared-section editor (ADR 0204 C4) — the impact list ("these pages
          change") shows BEFORE save; save confirms when pages are impacted. */}
      {editShared ? (
        <Modal onClose={() => setEditShared(null)} label={t('sharedEditTitle', { name: editShared.name })}>
          <div className="u-grid u-gap-2">
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('sharedNameLabel')}</span>
              <input value={editShared.name} onChange={(e) => setEditShared((s) => (s ? { ...s, name: e.target.value } : s))} />
            </label>
            <SectionFields
              section={{ sectionId: editShared.sharedSectionId, type: editShared.type, data: editShared.data }}
              assets={assets}
              onChange={(data) => setEditShared((s) => (s ? { ...s, data } : s))}
              onPickMedia={pickMedia}
            />
            {editShared.localizations && Object.keys(editShared.localizations).length > 0 ? (
              <span className="u-label-sm">{t('sharedOverlaysNote', { locales: Object.keys(editShared.localizations).join(', ') })}</span>
            ) : null}
            {sharedImpactFailed ? (
              <Notice variant="warning" announce={t('sharedImpactUnknown')}>{t('sharedImpactUnknown')}</Notice>
            ) : !sharedImpact ? <Skeleton /> : (
              <Notice variant={sharedImpact.length > 0 ? 'warning' : 'info'}>
                {sharedImpact.length > 0
                  ? t('sharedImpactWarning', { count: sharedImpact.length, pages: sharedImpact.map((p) => p.title).join(' · ') })
                  : t('sharedImpactNone')}
              </Notice>
            )}
            {sharedLocked ? <Notice variant="info">{t('sharedLiveTierReadOnly')}</Notice> : null}
            <div className="action-bar">
              <span className="u-flex-1" />
              <Button variant="primary" disabled={sharedLocked} onClick={() => void saveShared()}><SaveIcon /> {t('common:save')}</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** The rendered diff body: title change + per-section field changes. */
function VersionDiff({ from, to, onTake, onUseWhole }: {
  from: PageVersion;
  to: Page;
  onTake: (entry: SectionDiffEntry) => void;
  onUseWhole: () => void;
}): JSX.Element {
  const { t } = useTranslation('cms');
  // A seeded update's sections carry freshly minted ids: pair them by position.
  const entries = diffSections(from.snapshot.sections, to.sections, { pairByPosition: from.origin === 'seed' });
  const titleChanged = from.snapshot.title !== to.title;
  const kindChip = (kind: string): string => {
    switch (kind) {
      case 'added': return 'chip chip--success';
      case 'removed': return 'chip chip--warning';
      case 'moved': return 'chip chip--muted';
      default: return 'chip chip--accent'; // changed
    }
  };
  const nameOf = (e: SectionDiffEntry): string => {
    const s = from.snapshot.sections.find((x) => x.sectionId === e.sectionId) ?? to.sections.find((x) => x.sectionId === (e.toSectionId ?? e.sectionId));
    return (s && sectionLabel(s)) || t(`sectionType_${e.type}`, { defaultValue: e.type });
  };
  return (
    <div className="u-grid u-gap-3">
      <div className="u-grid u-gap-1">
        <h2 className="u-fs-16 u-m-0">{from.origin === 'seed' ? t('diffSeedTitle') : t('diffTitle', { version: from.version })}</h2>
        <p className="u-label-sm u-m-0">{t('diffLede')}</p>
      </div>
      {!titleChanged && entries.length === 0 ? (
        <span className="u-label-sm">{t('diffNoChanges')}</span>
      ) : null}
      {titleChanged ? (
        <div className="u-grid u-gap-1">
          <span className="u-label-sm">{t('titleLabel')}</span>
          <div className="cms-diff-cols">
            <div className="cms-diff-col"><span className="u-label-sm">{t('diffVersionCol')}</span><span>{from.snapshot.title}</span></div>
            <div className="cms-diff-col"><span className="u-label-sm">{t('diffDraftCol')}</span><span>{to.title}</span></div>
          </div>
        </div>
      ) : null}
      {entries.map((e) => (
        <section key={e.sectionId} className="cms-diff-entry" aria-label={nameOf(e)}>
          <div className="u-flex u-gap-2 u-items-center u-wrap">
            <strong className="u-flex-1">{nameOf(e)}</strong>
            <span className={kindChip(e.kind)}>{t(`diffKind_${e.kind}`)}</span>
            {e.kind === 'changed' ? (
              <Button variant="secondary" size="sm" aria-label={t('diffTakeAria', { section: nameOf(e) })} onClick={() => onTake(e)}>{t('diffTake')}</Button>
            ) : e.kind === 'removed' ? (
              <Button variant="secondary" size="sm" aria-label={t('diffPutBackAria', { section: nameOf(e) })} onClick={() => onTake(e)}>{t('diffPutBack')}</Button>
            ) : null}
          </div>
          {e.kind === 'added' ? <span className="u-label-sm">{t('diffOnlyInDraft')}</span> : null}
          {e.kind === 'removed' ? <span className="u-label-sm">{t('diffOnlyInVersion')}</span> : null}
          {e.fields.map((f) => (
            <div key={f.key} className="u-grid u-gap-1">
              <span className="u-label-sm">{f.key}</span>
              <div className="cms-diff-cols">
                <div className="cms-diff-col" data-side="version"><span className="u-label-sm">{t('diffVersionCol')}</span><span className="cms-diff-text">{f.from || t('diffEmptyValue')}</span></div>
                <div className="cms-diff-col" data-side="draft"><span className="u-label-sm">{t('diffDraftCol')}</span><span className="cms-diff-text">{f.to || t('diffEmptyValue')}</span></div>
              </div>
            </div>
          ))}
        </section>
      ))}
      <div className="action-bar">
        <span className="u-label-sm u-flex-1">{t('diffUndoHint')}</span>
        <Button variant="secondary" onClick={onUseWhole}>{t('diffUseWhole')}</Button>
      </div>
    </div>
  );
}

// The section editor + preview now live in the shared `SectionsEditor` /
// `SectionRenderer` (ADR 0027) so the org CMS editor and the host-level home-page
// editor use the same controls.
