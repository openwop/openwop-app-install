/**
 * Creative Briefs page (ADR 0353) — list + detail editor for the visual-brief
 * entity: content fields, direction variants, mood-board assembly (media's
 * weighted selection), lifecycle (draft → review → approved w/ privileged
 * approval), version history w/ field diffs, and PDF export. Deep-linked via
 * `?brief=<id>` (the ADR 0336 spine). Sharing rides the generic sharing
 * surface once a brief is APPROVED (backend-gated).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice, PageHeader, StateCard, Skeleton } from '../../ui/index.js';
import { TextField, TextareaField } from '../../ui/Field.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { AlertIcon, ArrowLeftIcon, LockIcon, PlusIcon, TrashIcon, FileTextIcon, SaveIcon, ImageIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatDateTime } from '../../i18n/format.js';
// The media feature OWNS media UX — reuse its picker + client (the ADR 0206 B4
// cross-feature precedent: CMS + document-editor import the same pair).
import { MediaPickerDialog } from '../media/MediaPickerDialog.js';
import { absoluteServeUrl, listAssets, type MediaAsset } from '../media/mediaClient.js';
import {
  listOrgs, listBriefs, getBrief, createBrief, updateBrief, transitionBrief, deleteBrief,
  listVersions, diffBriefVersions, assembleMoodBoard, downloadPdf,
  type CreativeBrief, type CreativeBriefVersion, type CreativeDirection, type Org,
} from './creativeBriefsClient.js';
import { RendersSection } from './RendersSection.js';

/** A direction row carries a stable client key so a mid-list remove doesn't
 *  steal focus from the wrong input (index keys reorder on splice). */
type DirectionRow = { key: string; label: string; rationale: string };

const BRIEF_STATUSES = ['draft', 'review', 'approved'] as const;

function statusChip(status: CreativeBrief['status']): string {
  return status === 'approved' ? 'chip chip--success' : 'chip chip--muted';
}

export function CreativeBriefsPage(): JSX.Element {
  const { t } = useTranslation('creative-briefs');
  const access = useFeatureAccess('creative-briefs');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [briefs, setBriefs] = useState<CreativeBrief[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  // ADR 0522 — the open brief is a ROUTE (`/creative-briefs/:briefId`), not a
  // `?brief=` mirror: this detail is a full-page swap, which §4.5 rule 12 puts
  // in the path lane. One component still serves both routes (the Tutorials
  // precedent), so the list state survives a back-navigation.
  const { briefId: selectedId = '' } = useParams<{ briefId: string }>();
  const navigate = useNavigate();
  /** A cell's href — a real URL the browser can open in a new tab or copy. */
  const briefHref = useCallback((id: string): string => `/creative-briefs/${encodeURIComponent(id)}`, []);
  const [selected, setSelected] = useState<CreativeBrief | null>(null);
  // CS-UX-6: the ?brief= deep-link resolves with a visible loading state and a
  // surfaced (not swallowed) failure.
  const [briefLoading, setBriefLoading] = useState(false);
  const [deepLinkError, setDeepLinkError] = useState('');
  // CS-UX-11: a busy guard so a double-click can't create two briefs.
  const [creating, setCreating] = useState(false);
  // CS-UX-13: the §4.5 collection canon — name filter + status chips + grid/list.
  const [briefQuery, setBriefQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CreativeBrief['status'] | null>(null);
  const [viewMode, setViewMode] = useViewMode('creative-briefs', 'grid');

  // R2 CRB-SP-11 — a failed orgs read must not leave the loading skeleton up
  // forever under the error notice (failure reported + "still working" at once).
  const [orgsFailed, setOrgsFailed] = useState(false);
  // CS-UX-7: surface a genuine load failure instead of masking it as the
  // "no organizations" empty state (the KB page pattern). Extracted so the
  // failure card can offer a real RETRY (review fold-in).
  const loadOrgs2 = useCallback(() => {
    setOrgsFailed(false); setError('');
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => { setOrgsFailed(true); setError(e instanceof Error && e.message ? e.message : t('loadOrgsFailed')); });
  }, [t]);
  useEffect(() => {
    if (!access.enabled) return;
    loadOrgs2();
  }, [access.enabled, loadOrgs2]);

  // R2 CRB-SP-14 — latest-wins: two quick org switches could land the OLDER
  // org's list last.
  const reloadSeq = useRef(0);
  const reload = useCallback(async (oid: string) => {
    const seq = ++reloadSeq.current;
    try { const rows = await listBriefs(oid); if (seq === reloadSeq.current) { setBriefs(rows); setLoaded(true); } }
    catch (e) { if (seq === reloadSeq.current) { setError(e instanceof Error ? e.message : 'load failed'); setLoaded(true); } }
  }, []);

  useEffect(() => { if (orgId) { setLoaded(false); void reload(orgId); } }, [orgId, reload]);

  const open = useCallback((id: string | null): void => {
    navigate(id ? briefHref(id) : '/creative-briefs', { replace: !id });
  }, [navigate, briefHref]);

  // URL-owned selection (ADR 0336): the param IS the source of truth.
  useEffect(() => {
    if (!orgId || !selectedId) { setSelected(null); setBriefLoading(false); return; }
    let cancelled = false;
    setBriefLoading(true);
    getBrief(orgId, selectedId)
      .then((b) => { if (!cancelled) { setSelected(b); setDeepLinkError(''); } })
      .catch((e) => {
        if (cancelled) return;
        setSelected(null);
        setDeepLinkError(e instanceof Error && e.message ? e.message : t('briefLoadFailed'));
        open(null); // clear the dead param so the list renders (CS-UX-6)
      })
      .finally(() => { if (!cancelled) setBriefLoading(false); });
    return () => { cancelled = true; };
  }, [orgId, selectedId, open, t]);

  const visibleBriefs = useMemo(() => {
    const q = briefQuery.trim().toLowerCase();
    return briefs.filter((b) => (!q || b.title.toLowerCase().includes(q)) && (!statusFilter || b.status === statusFilter));
  }, [briefs, briefQuery, statusFilter]);

  const createNew = async (): Promise<void> => {
    if (creating || !orgId) return;
    setCreating(true);
    try {
      const b = await createBrief(orgId, { title: t('untitled'), sceneDescription: t('scenePlaceholderNew'), directions: [], moodBoard: [] });
      await reload(orgId);
      setDeepLinkError('');
      open(b.briefId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setCreating(false); }
  };

  // R2 CRB-SP-13 — an in-flight guard (a double-click stacked two DELETEs, the
  // second 404-toasting over a successful delete) and the cascade disclosure
  // the RENDER delete already had but the bigger delete lacked.
  const [removing, setRemoving] = useState(false);
  const remove = async (b: CreativeBrief): Promise<void> => {
    if (removing) return;
    if (!(await confirm({ title: t('deleteConfirm', { title: b.title }), body: t('deleteConfirmCascade'), danger: true, confirmLabel: t('common:delete') }))) return;
    setRemoving(true);
    try {
      await deleteBrief(orgId, b.briefId);
      if (selectedId === b.briefId) open(null);
      await reload(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setRemoving(false); }
  };

  if (access.loading) return <Skeleton />;
  if (!access.enabled) return <StateCard icon={<LockIcon />} title={t('disabledTitle')} body={t('disabledBody')} />;

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgAriaLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div className="u-grid u-gap-4" data-walkthrough="creative-briefs.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={
        <>
          {orgPicker}
          <Button variant="accent-solid" disabled={!orgId || creating} onClick={() => void createNew()}><PlusIcon size={14} aria-hidden /> {t('newBrief')}</Button>
        </>
      } />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {deepLinkError ? <Notice variant="error">{deepLinkError}</Notice> : null}

      {selected ? (
        // R2 CRB-SP-1 — `key` remounts the WHOLE detail (RendersSection
        // included) when the brief identity changes. Without it, "New brief"
        // navigated A→B with the component staying mounted: the form kept A's
        // field state and Save wrote brief A's content INTO brief B; A's reel
        // poll kept running and wrote A's renders under B's heading.
        // R2 CRB-SP-14 — onChanged guards against a post-save resolve landing
        // AFTER Back cleared the URL-owned selection (it used to resurrect the
        // detail while the URL said /creative-briefs).
        <BriefDetail key={selected.briefId} t={t} orgId={orgId} brief={selected} onBack={() => open(null)}
          onChanged={async () => {
            const forBrief = selected.briefId;
            const b = await getBrief(orgId, forBrief);
            setSelected((cur) => (cur && cur.briefId === forBrief ? b : cur));
            await reload(orgId);
          }}
          onDelete={() => void remove(selected)} />
      ) : briefLoading ? (
        <div role="status"><span className="sr-only">{t('common:loading')}</span><Skeleton width="40%" /><Skeleton width="90%" /><Skeleton width="75%" /></div>
      ) : orgsFailed ? (
        <StateCard announce icon={<FileTextIcon size={20} />} title={t('common:loadFailedTitle')} body={t('common:loadFailedBody')}
          action={<Button variant="secondary" size="sm" onClick={loadOrgs2}>{t('common:retry')}</Button>} />
      ) : !orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<FileTextIcon size={20} />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : !loaded ? (
        <div role="status"><span className="sr-only">{t('common:loading')}</span><Skeleton width="60%" /><Skeleton width="90%" /></div>
      ) : briefs.length === 0 ? (
        <StateCard icon={<FileTextIcon size={20} />} title={t('emptyTitle')} body={t('emptyBody')}
          action={<Button variant="primary" disabled={!orgId || creating} onClick={() => void createNew()}>{t('newBrief')}</Button>} />
      ) : (
        <>
          <div className="filterbar" role="group" aria-label={t('filterGroup')}>
            {briefs.length > 3 ? (
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={briefQuery}
                onChange={(e) => setBriefQuery(e.target.value)}
              />
            ) : null}
            {/* Status chips double as filters (§4.5 "stats are filters"): the
                selected state rides is-selected + aria-pressed, not color alone. */}
            <div className="u-flex u-gap-1 u-items-center u-wrap" role="group" aria-label={t('statusFilterLabel')}>
              {BRIEF_STATUSES.map((s) => (
                <button key={s} type="button" className={`${statusChip(s)}${statusFilter === s ? ' is-selected' : ''}`}
                  aria-pressed={statusFilter === s} onClick={() => setStatusFilter((cur) => (cur === s ? null : s))}>
                  {t(`status_${s}`)}
                </button>
              ))}
            </div>
            <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
          </div>

          {visibleBriefs.length === 0 ? (
            <StateCard
              icon={<FileTextIcon size={20} />}
              title={t('noMatchTitle')}
              body={t('noMatchBody')}
              action={<Button variant="secondary" onClick={() => { setBriefQuery(''); setStatusFilter(null); }}>{t('clearFilters')}</Button>}
            />
          ) : viewMode === 'grid' ? (
            <div className="card-grid">
              {visibleBriefs.map((b) => <BriefCard key={b.briefId} t={t} brief={b} href={briefHref(b.briefId)} />)}
            </div>
          ) : (
            <div className="surface-card list-view">
              {visibleBriefs.map((b) => <BriefRow key={b.briefId} t={t} brief={b} href={briefHref(b.briefId)} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Grid cell of the §4.5 collection canon (mirrors KB's DocumentCard). A real
 *  `<Link>`, and NO delete — destructive actions live on the brief's own
 *  surface (§4.5 rule 12), not one slip from the card you meant to open. */
function BriefCard({ t, brief: b, href }: { t: TFn; brief: CreativeBrief; href: string }): JSX.Element {
  return (
    <Link to={href} className="surface-card u-flex u-flex-col u-gap-2" title={t('openBrief', { title: b.title })}>
      <span className="u-flex u-items-center u-gap-2">
        <FileTextIcon size={16} aria-hidden /> <strong className="u-fs-14">{b.title}</strong>
      </span>
      <span className="muted u-fs-13">{b.assetType}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <span className={statusChip(b.status)}>{t(`status_${b.status}`)}</span>
        {/* R3 CRB-SP-15 remainder — facts the card fetched and dropped: the
            direction count. Absent facts
            render nothing (no fabricated defaults). */}
        {b.directions && b.directions.length > 0 ? (
          <span className="chip chip--muted">{t('cardDirections', { count: b.directions.length })}</span>
        ) : null}
        <span className="muted u-fs-13">{formatDateTime(b.updatedAt)}</span>
      </div>
    </Link>
  );
}

/** List cell of the §4.5 collection canon. Same two rules as the card: a real
 *  `<Link>`, and no delete on the cell. */
function BriefRow({ t, brief: b, href }: { t: TFn; brief: CreativeBrief; href: string }): JSX.Element {
  return (
    <div className="list-row">
      <Link to={href} className="list-row-id" title={t('openBrief', { title: b.title })}>
        <FileTextIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line"><span className="list-row-name">{b.title}</span></span>
          <span className="list-row-sub">{b.assetType}</span>
        </span>
      </Link>
      <div className="list-row-meta">
        <span className={statusChip(b.status)}>{t(`status_${b.status}`)}</span>
        <span>{formatDateTime(b.updatedAt)}</span>
      </div>
      <div className="list-row-actions action-bar">
        <Link to={href} className="btn secondary btn-sm">{t('open')}</Link>
      </div>
    </div>
  );
}

type TFn = ReturnType<typeof useTranslation>['t'];

function BriefDetail({ t, orgId, brief, onBack, onChanged, onDelete }: {
  t: TFn; orgId: string; brief: CreativeBrief; onBack: () => void; onChanged: () => Promise<void>;
  /** §4.5 rule 12 — delete belongs to the entity's own surface, so it lives
   *  here rather than on the collection cell. */
  onDelete: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(brief.title);
  const [assetType, setAssetType] = useState(brief.assetType);
  const [scene, setScene] = useState(brief.sceneDescription);
  const [composition, setComposition] = useState(brief.composition ?? '');
  const [cameraAngle, setCameraAngle] = useState(brief.cameraAngle ?? '');
  const [lighting, setLighting] = useState(brief.lighting ?? '');
  const [messagingIntent, setMessagingIntent] = useState(brief.messagingIntent ?? '');
  // POLISH-2: structured per-direction rows instead of fragile em-dash textarea
  // parsing (a rationale containing " — " used to split into the wrong fields).
  const [directions, setDirections] = useState<DirectionRow[]>(
    () => brief.directions.map((d) => ({ key: crypto.randomUUID(), label: d.label, rationale: d.rationale ?? '' })));
  const updateDirection = (key: string, patch: Partial<DirectionRow>): void =>
    setDirections((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addDirection = (): void =>
    setDirections((rows) => [...rows, { key: crypto.randomUUID(), label: '', rationale: '' }]);
  const removeDirection = (key: string): void =>
    setDirections((rows) => rows.filter((r) => r.key !== key));
  // R2 CRB-SP-7 — platformSpec was agent-settable but had NO control anywhere,
  // while the validator warns about its absence; brandPalette silently wins the
  // render accent vote while invisible.
  const [platform, setPlatform] = useState(brief.platformSpec?.platform ?? '');
  const [platformFormat, setPlatformFormat] = useState(brief.platformSpec?.format ?? '');
  const [moodProduct, setMoodProduct] = useState('');
  const [versions, setVersions] = useState<CreativeBriefVersion[] | null>(null);
  const [diff, setDiff] = useState<Array<{ field: string; from: unknown; to: unknown }> | null>(null);
  const [busy, setBusy] = useState(false);
  // CS-UX-2: PDF export gets a busy state + a surfaced failure (was a
  // fire-and-forget unhandled rejection).
  const [exporting, setExporting] = useState(false);
  // CS-UX-5: resolve mood-board asset ids to real thumbnails via the media
  // client; null = still resolving.
  const [assetsById, setAssetsById] = useState<Map<string, MediaAsset> | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const moodBoard = brief.moodBoard;
  useEffect(() => {
    if (moodBoard.length === 0) { setAssetsById(new Map()); return; }
    let cancelled = false;
    listAssets(orgId)
      .then((all) => { if (!cancelled) setAssetsById(new Map(all.map((a) => [a.assetId, a]))); })
      .catch(() => { if (!cancelled) { setAssetsById(new Map()); toast.error(t('actionFailed')); } });
    return () => { cancelled = true; };
  }, [orgId, moodBoard, t]);

  const exportPdf = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try { await downloadPdf(orgId, brief.briefId, brief.title); }
    catch { toast.error(t('exportPdfFailed')); }
    finally { setExporting(false); }
  };

  const addMoodAsset = async (asset: MediaAsset): Promise<void> => {
    setPickerOpen(false);
    if (brief.moodBoard.some((m) => m.mediaAssetId === asset.assetId)) return;
    setBusy(true);
    try { await updateBrief(orgId, brief.briefId, { moodBoard: [...brief.moodBoard, { mediaAssetId: asset.assetId }] }); await onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  const removeMoodAsset = async (mediaAssetId: string): Promise<void> => {
    setBusy(true);
    try { await updateBrief(orgId, brief.briefId, { moodBoard: brief.moodBoard.filter((m) => m.mediaAssetId !== mediaAssetId) }); await onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  /** The write half of Save, without the busy/toast shell — so a lifecycle
   *  transition can persist the form first without double-toasting. */
  const saveFields = async (): Promise<void> => {
    await updateBrief(orgId, brief.briefId, {
        title, assetType, sceneDescription: scene,
        composition, cameraAngle, lighting, messagingIntent,
        directions: directions
          .map((d): CreativeDirection => ({ label: d.label.trim(), ...(d.rationale.trim() ? { rationale: d.rationale.trim() } : {}) }))
          .filter((d) => d.label), // drop empty rows (no label) on save
      // R2 CRB-SP-7 — platform/format come from the fields (empty = cleared);
      // ONLY the invisible textRulePct is preserved from the stored spec.
      // Review fold-in: clearing BOTH fields with no textRulePct sends the
      // explicit `null` clear sentinel — omitting the key means "keep", so the
      // old omission silently resurrected the stored platform on every save.
      ...(platform.trim() || platformFormat.trim() || brief.platformSpec?.textRulePct !== undefined
        ? { platformSpec: {
            ...(brief.platformSpec?.textRulePct !== undefined ? { textRulePct: brief.platformSpec.textRulePct } : {}),
            ...(platform.trim() ? { platform: platform.trim() } : {}),
            ...(platformFormat.trim() ? { format: platformFormat.trim() } : {}),
          } }
        : brief.platformSpec ? { platformSpec: null } : {}),
      moodBoard: brief.moodBoard,
    });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await saveFields();
      await onChanged();
      toast.success(t('saved'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  // CRB-G1 — every lifecycle action targets the SERVER's brief, while the form
  // holds unsaved edits. Approving a dirty form approves a version the approver
  // is not looking at — and approval is what unlocks sharing. Worse, the service
  // demotes an approved brief back to `draft` on the next content edit (and the
  // sharing route purges its links), so edit → approve → save silently
  // un-approves and drops the links. Saving first makes the transition act on
  // the document on screen and removes the whiplash entirely.
  const dirty = useMemo(() => (
    title !== brief.title
    || assetType !== brief.assetType
    || scene !== brief.sceneDescription
    || composition !== (brief.composition ?? '')
    || cameraAngle !== (brief.cameraAngle ?? '')
    || lighting !== (brief.lighting ?? '')
    || messagingIntent !== (brief.messagingIntent ?? '')
    || directions.filter((d) => d.label.trim()).map((d) => `${d.label.trim()}|${d.rationale.trim()}`).join('\n')
       !== brief.directions.map((d) => `${d.label}|${d.rationale ?? ''}`).join('\n')
    || platform !== (brief.platformSpec?.platform ?? '')
    || platformFormat !== (brief.platformSpec?.format ?? '')
  ), [title, assetType, scene, composition, cameraAngle, lighting, messagingIntent, directions, platform, platformFormat, brief]);

  // An issue whose severity the server did not set is treated as an ERROR: a
  // rule we don't recognise must not be quietly downgraded to a suggestion.
  const briefErrors = (brief.issues ?? []).filter((i) => i.severity !== 'warning');
  /** CRB-G3 — the validator names the field on every issue; with real Fields
   *  that message can sit ON the control instead of only in the panel above. */
  const fieldError = (field: string): string | undefined =>
    briefErrors.find((i) => i.field === field)?.message;
  const briefWarnings = (brief.issues ?? []).filter((i) => i.severity === 'warning');

  const transition = async (status: CreativeBrief['status']): Promise<void> => {
    setBusy(true);
    try {
      if (dirty) await saveFields();
      await transitionBrief(orgId, brief.briefId, status);
      await onChanged();
    }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  const moodboard = async (): Promise<void> => {
    setBusy(true);
    try { await assembleMoodBoard(orgId, brief.briefId, { ...(moodProduct.trim() ? { product: moodProduct.trim() } : {}), limit: 6 }); await onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  const showVersions = async (): Promise<void> => {
    try { setVersions(await listVersions(orgId, brief.briefId)); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
  };

  const showDiff = async (from: number, to: number): Promise<void> => {
    try { setDiff(await diffBriefVersions(orgId, brief.briefId, from, to)); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
  };

  return (
    <div className="u-grid u-gap-3">
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <Button variant="quiet" size="sm" onClick={onBack}><ArrowLeftIcon size={14} aria-hidden /> {t('backToList')}</Button>
        <span className={statusChip(brief.status)}>{t(`status_${brief.status}`)}</span>
        <span className="u-label-sm">v{brief.version}</span>
        <div className="action-bar u-ml-auto">
          <Button variant="danger" size="sm" onClick={onDelete}><TrashIcon size={14} aria-hidden /> {t('common:delete')}</Button>
          {/* CRB-G1 — when the form is dirty the action saves first, and says so,
              so a transition never acts on a document the reader isn't seeing. */}
          {brief.status === 'draft' ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void transition('review')}>{dirty ? t('saveAndSendToReview') : t('sendToReview')}</Button> : null}
          {brief.status === 'review' ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void transition('approved')}>{dirty ? t('saveAndApprove') : t('approve')}</Button> : null}
          {brief.status !== 'draft' ? <Button variant="quiet" size="sm" disabled={busy} onClick={() => void transition('draft')}>{t('backToDraft')}</Button> : null}
          <Button variant="quiet" size="sm" disabled={busy || exporting} onClick={() => void exportPdf()}><FileTextIcon size={14} aria-hidden /> {exporting ? t('exporting') : t('exportPdf')}</Button>
        </div>
      </div>

      {/* CRB-G2 — the validator grades each issue `error` | `warning` AND names
          its field. Both were erased: every issue was joined into one WARNING
          strip, so "A title is required" (a blocker) read exactly like
          "Messaging intent helps the designer land the point" (a suggestion).
          Errors and warnings now separate, and each issue names its field. */}
      {briefErrors.length > 0 ? (
        <Notice variant="error">
          <div>
            <p className="u-m-0 u-fw-600">{t('issuesErrorsTitle', { count: briefErrors.length })}</p>
            <ul className="u-m-0 u-mt-1">
              {briefErrors.map((i) => (
                <li key={`e:${i.field}`}><span className="u-fw-600">{t(`issueField_${i.field}`, { defaultValue: i.field })}</span>{': '}{i.message}</li>
              ))}
            </ul>
          </div>
        </Notice>
      ) : null}
      {briefWarnings.length > 0 ? (
        <Notice variant="warning">
          <div>
            <p className="u-m-0 u-fw-600">{t('issuesWarningsTitle', { count: briefWarnings.length })}</p>
            <ul className="u-m-0 u-mt-1">
              {briefWarnings.map((i) => (
                <li key={`w:${i.field}`}><span className="u-fw-600">{t(`issueField_${i.field}`, { defaultValue: i.field })}</span>{': '}{i.message}</li>
              ))}
            </ul>
          </div>
        </Notice>
      ) : null}
      {brief.needsAssetNote ? <Notice variant="info">{brief.needsAssetNote}</Notice> : null}

      <section className="surface-card u-p-4 u-grid u-gap-2">
        {/* CRB-G3 — the validator already grades `title` and `sceneDescription`
            as ERRORS and names the field (see the issues panel above). Now that
            these are real Fields, that grading is wired straight onto the
            control: `aria-invalid` + a described error, not just a notice
            further up the page. */}
        <TextField label={t('fieldTitle')} value={title} onChange={(e) => setTitle(e.target.value)}
          required {...(fieldError('title') ? { error: fieldError('title') } : {})} />
        <TextField label={t('fieldAssetType')} value={assetType} onChange={(e) => setAssetType(e.target.value)} />
        <TextareaField label={t('fieldScene')} rows={3} value={scene} onChange={(e) => setScene(e.target.value)}
          required {...(fieldError('sceneDescription') ? { error: fieldError('sceneDescription') } : {})} />
        <TextareaField label={t('fieldComposition')} rows={2} value={composition} onChange={(e) => setComposition(e.target.value)} />
        <div className="u-flex u-gap-2 u-wrap">
          <TextField className="u-flex-1" label={t('fieldCamera')} value={cameraAngle} onChange={(e) => setCameraAngle(e.target.value)} />
          <TextField className="u-flex-1" label={t('fieldLighting')} value={lighting} onChange={(e) => setLighting(e.target.value)} />
        </div>
        <TextareaField label={t('fieldMessagingIntent')} rows={2} value={messagingIntent}
          onChange={(e) => setMessagingIntent(e.target.value)}
          {...(fieldError('messagingIntent') ? { help: fieldError('messagingIntent') } : {})} />
        {/* R2 CRB-SP-7 — the platform target the validator warns about now has
            a control; the brand palette (which silently wins the render accent
            vote) is at least visible; campaign provenance links back. */}
        <div className="u-flex u-gap-2 u-wrap">
          <TextField className="u-flex-1" label={t('fieldPlatform')} help={t('fieldPlatformHelp')} value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="meta" />
          <TextField className="u-flex-1" label={t('fieldPlatformFormat')} value={platformFormat} onChange={(e) => setPlatformFormat(e.target.value)} placeholder="feed" />
        </div>
        {(brief.brandPalette ?? []).length > 0 ? (
          <p className="u-fs-13 muted u-m-0">{t('brandPaletteNote')} {(brief.brandPalette ?? []).map((c) => <code key={c}>{c}</code>)}</p>
        ) : null}
        {brief.campaignBriefId ? (
          <p className="u-fs-13 muted u-m-0"><Link className="btn-link" to={`/campaign-brief?brief=${encodeURIComponent(brief.campaignBriefId)}`}>{t('fromCampaignBrief')}</Link></p>
        ) : null}
        <div className="field">
          <span className="field-label">{t('fieldDirections')}</span>
          <div className="u-grid u-gap-2">
            {directions.length === 0 ? <span className="muted u-fs-13">{t('directionsEmpty')}</span> : null}
            {directions.map((d) => (
              <div key={d.key} className="u-flex u-gap-2 u-wrap u-items-start">
                {/* These two keep a visually-hidden label (the row is a repeated
                    pair under one group heading, so a visible label per row would
                    be noise) — `Field` supports that with an `sr-only` label node
                    and still wires htmlFor/id properly. */}
                <TextField className="u-flex-1 u-m-0" label={<span className="sr-only">{t('directionLabel')}</span>}
                  value={d.label} placeholder={t('directionLabel')}
                  onChange={(e) => updateDirection(d.key, { label: e.target.value })} />
                <TextField className="u-flex-1 u-m-0" label={<span className="sr-only">{t('directionRationale')}</span>}
                  value={d.rationale} placeholder={t('directionRationale')}
                  onChange={(e) => updateDirection(d.key, { rationale: e.target.value })} />
                <Button variant="quiet" aria-label={t('removeDirection')} onClick={() => removeDirection(d.key)}><TrashIcon aria-hidden /></Button>
              </div>
            ))}
            <div className="action-bar">
              <Button variant="secondary" size="sm" onClick={addDirection}><PlusIcon size={14} aria-hidden /> {t('addDirection')}</Button>
            </div>
          </div>
        </div>
        <div className="action-bar">
          <Button variant="primary" disabled={busy} onClick={() => void save()}><SaveIcon /> {t('save')}</Button>
        </div>
      </section>

      <section className="surface-card u-p-4 u-grid u-gap-2">
        <h2 className="u-fs-16 u-m-0"><ImageIcon size={16} aria-hidden /> {t('moodBoardHeading')}</h2>
        <div className="u-flex u-gap-2 u-wrap">
          <input className="u-flex-1" value={moodProduct} onChange={(e) => setMoodProduct(e.target.value)} placeholder={t('moodBoardProductPlaceholder')} aria-label={t('moodBoardProductPlaceholder')} />
          <Button variant="secondary" disabled={busy} onClick={() => void moodboard()}>{t('assembleMoodBoard')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => setPickerOpen(true)}><PlusIcon size={14} aria-hidden /> {t('moodBoardAddImage')}</Button>
        </div>
        {brief.moodBoard.length === 0 ? (
          <span className="muted u-fs-13">{t('moodBoardEmpty')}</span>
        ) : assetsById === null ? (
          <Skeleton />
        ) : (
          // CS-UX-5: real thumbnails (media serveUrl) instead of raw asset ids;
          // an unresolvable id degrades to a labeled "missing asset" chip.
          <div className="card-grid">
            {brief.moodBoard.map((m) => {
              const a = assetsById.get(m.mediaAssetId);
              return (
                <figure key={m.mediaAssetId} className="surface-card u-flex u-flex-col u-gap-1 u-p-2 u-m-0">
                  <div className="media-thumb">
                    {a && a.contentType.startsWith('image/')
                      ? <img src={absoluteServeUrl(a.serveUrl)} alt={a.name} className="media-thumb-img" />
                      : <ImageIcon aria-hidden />}
                  </div>
                  <figcaption className="u-fs-13">
                    {a ? <>{a.name}{m.note ? ` — ${m.note}` : ''}</> : <span className="chip chip--warning"><AlertIcon size={12} aria-hidden /> {t('moodBoardMissingAsset')}</span>}
                  </figcaption>
                  <div className="action-bar">
                    <Button variant="quiet" disabled={busy} aria-label={t('moodBoardRemoveAria', { name: a?.name ?? m.mediaAssetId })} onClick={() => void removeMoodAsset(m.mediaAssetId)}><TrashIcon aria-hidden /></Button>
                  </div>
                </figure>
              );
            })}
          </div>
        )}
        {pickerOpen ? <MediaPickerDialog orgId={orgId} onSelect={(a) => void addMoodAsset(a)} onClose={() => setPickerOpen(false)} /> : null}
      </section>

      {/* R2 CRB-SP-3 — the render lane saves-first when the form is dirty (the
          CRB-G1 pattern, extended to the cost-bearing actions); the callback
          reports whether the save landed so a failed save aborts the render. */}
      <RendersSection orgId={orgId} brief={brief} dirty={dirty}
        onSaveFirst={async () => {
          try { await saveFields(); await onChanged(); return true; }
          catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); return false; }
        }} />

      <section className="surface-card u-p-4 u-grid u-gap-2">
        <div className="u-flex u-items-center u-gap-2">
          <h2 className="u-fs-16 u-m-0">{t('versionsHeading')}</h2>
          <Button variant="quiet" size="sm" onClick={() => void showVersions()}>{t('loadVersions')}</Button>
        </div>
        {versions ? versions.length < 2 ? <span className="muted u-fs-13">{t('noDiffYet')}</span> : (
          <div className="u-grid u-gap-1">
            {versions.map((v, i) => (
              <div key={v.versionId} className="u-flex u-gap-2 u-items-center">
                <span className="u-label-sm">v{v.version} · {formatDateTime(v.capturedAt)}</span>
                {i < versions.length - 1 ? (
                  <Button variant="quiet" size="sm" onClick={() => void showDiff(versions[i + 1]!.version, v.version)}>{t('diffPrev')}</Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {diff ? diff.length === 0 ? <span className="muted u-fs-13">{t('noChanges')}</span> : (
          <ul className="u-m-0">
            {diff.map((d) => <li key={d.field} className="u-fs-13"><strong>{d.field}</strong>: {JSON.stringify(d.from) ?? '—'} → {JSON.stringify(d.to) ?? '—'}</li>)}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
