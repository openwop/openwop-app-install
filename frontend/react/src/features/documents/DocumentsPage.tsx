/**
 * Documents page (ADR 0053). An org-scoped business-document workspace: a
 * documents list (grid/list, filterable) + a Markdown editor with version
 * history and export. Document CREATION (blank, from a template, from a canvas)
 * and template management now live in the on-demand <NewDocumentModal> behind
 * the header's "New document" action — the page body is no longer cluttered by
 * always-on create/starter/template sections (the blank-first, templates-on-
 * demand pattern Word/Drive converge on). Honest about run-scoped generation:
 * the page assembles + lets you author/save versions; the actual AI draft is
 * produced by the feature.documents.nodes workflow node / agent.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice, PageHeader, StateCard, Skeleton, ViewToggle, useViewMode } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { listProjects, type Project } from '../projects/projectsClient.js';

import { confirm } from '../../ui/confirm.js';import { LockIcon, GlobeIcon, PlusIcon, FileTextIcon } from '../../ui/icons/index.js';
import { DocumentCard, DocumentRow, CanvasDocCard, CanvasDocRow } from './DocumentViews.js';
import { NewDocumentModal } from './NewDocumentModal.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useCreatableTypeAccess } from '../../canvas/useCreatableTypeAccess.js';
import { getEffectiveAccess } from '../../client/accessClient.js';
import { CREATABLE_CANVAS_TYPES, canvasTypeIcon, canvasTypeNameKey } from '../../canvas/creatableTypes.js';
import { listPackCanvasTypes, type PackCanvasTypeRow } from '../../canvas/canvasClient.js';
import {
  listOrgs, listDocuments, patchDocument, deleteDocument,
  listCanvasSources, deleteCanvas,
  type Org, type DocumentRecord, type CanvasSourceRow,
} from './documentsClient.js';

export function DocumentsPage(): JSX.Element {
  const { t } = useTranslation('documents');
  const { t: tc } = useTranslation('canvas');
  const navigate = useNavigate();
  const access = useFeatureAccess('documents');
  // ADR 0319 — canvases are documents in this list; the ONE shared per-type
  // access map (architect review of #1609).
  const canvasAccess = useCreatableTypeAccess();
  const packsAccess = useFeatureAccess('canvas-packs');
  // UX-DOC-1/3/5 — "the read failed" is a different fact from "the answer is
  // empty", and each of these used to collapse into the empty branch.
  const [accessFailed, setAccessFailed] = useState(false);
  const [canvasesFailed, setCanvasesFailed] = useState(false);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [canvases, setCanvases] = useState<CanvasSourceRow[]>([]);
  const [packTypes, setPackTypes] = useState<PackCanvasTypeRow[]>([]);
  // CONT-2: distinguish "not loaded yet" from "truly empty" so the empty
  // StateCard doesn't flash before the first fetch (or across org switches).
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useViewMode('documents', 'grid');
  const [showNew, setShowNew] = useState(false);
  // ADR 0063 — only offer "New document" to a caller who can write, so a
  // read-only member doesn't get a create modal that 403s on submit.
  const [canCreate, setCanCreate] = useState(false);
  // ADR 0314 — row-level "Add to project" (rides the existing ownerSubject
  // PATCH). Projects load lazily on first open; the same gate as create.
  const projectsAccess = useFeatureAccess('projects');
  const [assignFor, setAssignFor] = useState<DocumentRecord | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  // UX-DOC-4 — a failed projects read must not read as "you have no projects"
  // in the assign modal (the chip path keeps its designed generic-label
  // fallback; only the modal makes an actionable claim from the list).
  const [projectsFailed, setProjectsFailed] = useState(false);
  const loadProjects = useCallback(() => {
    setProjectsFailed(false);
    listProjects().then(setProjects).catch(() => setProjectsFailed(true));
  }, []);
  const [assignProjectId, setAssignProjectId] = useState('');

  // ADR 0319 — the unified list: markdown documents AND the tenant's canvases,
  // each a peer row, newest-first. A canvas row opens its editor; a document row
  // opens the inline markdown editor.
  type ListItem = ({ kind: 'doc'; doc: DocumentRecord } | { kind: 'canvas'; canvas: CanvasSourceRow }) & { sortKey: string; matchText: string };
  const items = useMemo<ListItem[]>(() => {
    const merged: ListItem[] = [
      ...docs.map((d): ListItem => ({ kind: 'doc', doc: d, sortKey: d.updatedAt, matchText: d.title.toLowerCase() })),
      ...canvases.map((c): ListItem => ({ kind: 'canvas', canvas: c, sortKey: c.updatedAt, matchText: (c.name ?? '').toLowerCase() })),
    ];
    return merged.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [docs, canvases]);
  const totalCount = items.length;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((it) => it.matchText.includes(q)) : items;
  }, [items, query]);

  // ADR 0316 — resolve a project-owned document's id to its name for the chip.
  // Lazily fetch the project list the first time any listed document is
  // project-owned (also feeds the assign modal); until it lands, the chip
  // falls back to the generic label. Absent list ⇒ undefined ⇒ fallback.
  const anyProjectOwned = useMemo(() => docs.some((d) => d.ownerSubject?.kind === 'project') || canvases.some((c) => Boolean(c.projectId)), [docs, canvases]);
  useEffect(() => {
    // `!projectsFailed` stops a failed read from re-firing every render; the
    // modal owns the retry affordance (UX-DOC-4).
    if (anyProjectOwned && projectsAccess.enabled && projects === null && !projectsFailed) {
      loadProjects();
    }
  }, [anyProjectOwned, projectsAccess.enabled, projects, projectsFailed, loadProjects]);
  const projectNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects ?? []) m.set(p.id, p.name);
    return m;
  }, [projects]);
  const projectNameFor = (doc: DocumentRecord): string | undefined =>
    doc.ownerSubject?.kind === 'project' ? projectNames.get(doc.ownerSubject.id) : undefined;
  const canvasProjectNameFor = (c: CanvasSourceRow): string | undefined =>
    c.projectId ? projectNames.get(c.projectId) : undefined;

  // A canvas type's editor route, or null when its feature is off (row shows
  // "Off", not openable — but stays deletable). First-party types gate on their
  // single merged toggle; pack types on `canvas-packs` (ADR 0319).
  const openPathFor = (c: CanvasSourceRow): string | null => {
    const def = CREATABLE_CANVAS_TYPES.find((d) => d.canvasTypeId === c.canvasTypeId);
    // Carry the org, exactly as `docHref` does below. Without it the editor
    // cannot know which workspace the canvas is in and used to guess `orgs[0]`.
    const q = `?org=${encodeURIComponent(orgId)}`;
    if (def) return canvasAccess[def.toggleId]?.enabled ? `${def.editorPath}/${c.canvasId}${q}` : null;
    return packsAccess.enabled ? `/canvas/${c.canvasTypeId}/${c.canvasId}${q}` : null;
  };
  // ADR 0350 Phase 1 — a markdown document's own full-screen URL. Org rides as a
  // query param so the address is copyable and resolves on reload.
  const docHref = (doc: DocumentRecord): string => `/documents/${doc.documentId}?org=${encodeURIComponent(orgId)}`;
  const typeNameFor = (canvasTypeId: string): string => {
    const key = canvasTypeNameKey(canvasTypeId);
    if (key) return tc(key);
    const pack = packTypes.find((p) => p.canvasTypeId === canvasTypeId);
    return pack?.title ?? canvasTypeId.replace(/^canvas\./, '');
  };

  // ADR 0350 Phase 1 — documents now live at their own URL. Legacy `?doc=&org=`
  // deep-links (older agent-deliverable tools + inbox notifications) redirect to
  // `/documents/:documentId?org=` so shared links keep working. A bare `?org=`
  // (no doc) just pre-selects that org's list.
  const [searchParams] = useSearchParams();
  const deepLinkDocId = searchParams.get('doc');
  const deepLinkOrgId = searchParams.get('org');
  /** The shared read (`ui/useOrgSelection`) — keeps `orgs` null on failure, so
   *  the "create an organization first" instruction can no longer be reached by
   *  a rejection, and owns the retry the page used to hand-roll. */
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, access.enabled, deepLinkOrgId ?? '');

  useEffect(() => {
    if (!deepLinkDocId) return;
    const q = deepLinkOrgId ? `?org=${encodeURIComponent(deepLinkOrgId)}` : '';
    navigate(`/documents/${deepLinkDocId}${q}`, { replace: true });
  }, [deepLinkDocId, deepLinkOrgId, navigate]);

  // The ORG read moved to `ui/useOrgSelection` above. UX-DOC-1's catch had to
  // write BOTH `setOrgsFailed(true)` and `setOrgs([])` — the sentinel it was
  // explaining, kept only because the render asked the flag first. The hook
  // leaves `orgs` null, so there is no sentinel to compensate for, and the
  // hand-rolled `reloadOrgs` counter is replaced by the hook's own retry.
  useEffect(() => {
    if (!access.enabled) return;
    // UX-DOC-3 — a failed access read is not "you lack permission". Failing
    // closed on the ACTION is right; silently deleting the affordance is not,
    // because the user cannot tell "not allowed" from "we couldn't check".
    void getEffectiveAccess()
      .then((a) => { setAccessFailed(false); setCanCreate(a.scopes.includes('workspace:write')); })
      .catch(() => { setAccessFailed(true); setCanCreate(false); });
  }, [access.enabled]);

  useEffect(() => {
    if (!orgId) return;
    setError('');
    setDocsLoaded(false); // org switch: back to loading, not a stale empty (CONT-2)
    // Documents (org-scoped) + canvases (tenant-scoped) load together so the list
    // reveals as one unit (ADR 0319). Canvas failure doesn't sink the documents.
    setCanvasesFailed(false);
    void Promise.all([
      listDocuments(orgId),
      // UX-DOC-5 — keeping a canvas failure from sinking the documents (ADR 0319)
      // is right; staying SILENT about it is not. The combined list would just
      // render fewer rows, so a reader cannot tell "no canvases" from "the canvas
      // half didn't load" — and might create a duplicate of something they own.
      listCanvasSources(orgId).catch(() => { setCanvasesFailed(true); return { canvases: [], total: 0 }; }),
    ])
      .then(([d, c]) => { setDocs(d); setCanvases(c.canvases); setDocsLoaded(true); })
      .catch((e: Error) => { setError(e.message); setDocsLoaded(true); });
  }, [orgId]);

  // Pack-declared canvas types — their titles + editor routes for pack canvas rows.
  useEffect(() => {
    if (!orgId || !packsAccess.enabled) { setPackTypes([]); return; }
    let cancelled = false;
    listPackCanvasTypes(orgId).then((rows) => { if (!cancelled) setPackTypes(rows); }).catch(() => { /* no pack rows */ });
    return () => { cancelled = true; };
  }, [orgId, packsAccess.enabled]);

  async function refreshDocs(): Promise<void> { setDocs(await listDocuments(orgId)); setDocsLoaded(true); }
  async function refreshCanvases(): Promise<void> { const r = await listCanvasSources(orgId); setCanvases(r.canvases); }

  async function removeCanvas(c: CanvasSourceRow): Promise<void> {
    const name = c.name || t('untitledCanvas');
    if (!(await confirm({ title: t('deleteCanvasConfirm', { name }), body: t('deleteCanvasBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    setError('');
    try {
      await deleteCanvas(orgId, c.canvasId);
      await refreshCanvases();
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); }
  }

  async function removeDoc(doc: DocumentRecord): Promise<void> {
    if (!(await confirm({ title: t('deleteDocumentConfirm', { name: doc.title }), body: t('deleteDocumentBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    setError('');
    try {
      await deleteDocument(orgId, doc.documentId);
      await refreshDocs();
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); }
  }

  function openAssign(doc: DocumentRecord): void {
    setAssignFor(doc);
    setAssignProjectId(doc.ownerSubject?.kind === 'project' ? doc.ownerSubject.id : '');
    if (projects === null) loadProjects();
  }

  async function saveAssign(): Promise<void> {
    if (!assignFor) return;
    setBusy(true); setError('');
    try {
      await patchDocument(orgId, assignFor.documentId, { ownerSubject: assignProjectId ? { kind: 'project', id: assignProjectId } : null });
      setAssignFor(null);
      await refreshDocs();
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  const headerActions = orgs && orgs.length > 0 ? (
    <>
      {orgPicker}
      {canCreate ? (
        <Button variant="accent-solid" disabled={!orgId} onClick={() => setShowNew(true)}>
          <PlusIcon size={14} aria-hidden /> {t('newDocumentButton')}
        </Button>
      ) : null}
    </>
  ) : undefined;

  return (
    <div className="u-grid u-gap-4" data-walkthrough="documents.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={headerActions} />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* UX-DOC-3 — say the permission check failed; don't just delete the button.
          NOT announced: one polite slot per page, and `canvasSourcesFailed` below wins
          it because an incomplete LIST is the false conclusion this effort exists to
          stop (missing data read as absent data). A missing control is visible. */}
      {accessFailed ? <Notice variant="warning">{t('accessCheckFailed')}</Notice> : null}
      {/* UX-DOC-5 — the canvas half is missing from the list below; say so. */}
      {canvasesFailed ? <Notice variant="warning" announce={t('canvasSourcesFailed')}>{t('canvasSourcesFailed')}</Notice> : null}

      {/* UX-DOC-1 — a FAILED orgs read must never borrow the "create an
          organization first" instruction. That order is the component's now. */}
      <OrgSelectionState
        orgs={orgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
        icon={<GlobeIcon />}
      >
        {(
        <div className="u-grid u-gap-4" data-walkthrough="documents.page">
          {/* documents list */}
          <div className="u-grid u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('documentsHeading', { count: totalCount })}</h2>
            {!docsLoaded && totalCount === 0 ? (
              <div role="status"><span className="sr-only">{t('common:loading')}</span><Skeleton width="60%" /><Skeleton width="90%" /></div>
            ) : totalCount === 0 ? (
              <StateCard
                icon={<FileTextIcon size={20} />}
                title={t('noDocumentsTitle')}
                body={t('noDocumentsBody')}
                action={canCreate ? <Button variant="primary" disabled={!orgId} onClick={() => setShowNew(true)}>{t('newDocumentButton')}</Button> : undefined}
              />
            ) : (
              <>
                <div className="filterbar" role="group" aria-label={t('filterGroup')}>
                  {totalCount > 3 ? (
                    <input
                      type="search"
                      className="ui-input filterbar-search"
                      placeholder={t('filterPlaceholder')}
                      aria-label={t('filterAria')}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  ) : null}
                  <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
                </div>

                {visible.length === 0 ? (
                  <StateCard
                    icon={<FileTextIcon size={20} />}
                    title={t('noMatchTitle')}
                    body={t('noMatchBody')}
                    action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearSearch')}</Button>}
                  />
                ) : viewMode === 'grid' ? (
                  <div className="card-grid">
                    {visible.map((it) => {
                      if (it.kind === 'doc') return <DocumentCard key={`d:${it.doc.documentId}`} doc={it.doc} href={docHref(it.doc)} projectName={projectNameFor(it.doc)} />;
                      const path = openPathFor(it.canvas);
                      return <CanvasDocCard key={`c:${it.canvas.canvasId}`} canvas={it.canvas} typeName={typeNameFor(it.canvas.canvasTypeId)} Icon={canvasTypeIcon(it.canvas.canvasTypeId)} {...(path ? { href: path } : {})} projectName={canvasProjectNameFor(it.canvas)} />;
                    })}
                  </div>
                ) : (
                  <div className="surface-card list-view">
                    {visible.map((it) => {
                      if (it.kind === 'doc') return <DocumentRow key={`d:${it.doc.documentId}`} doc={it.doc} href={docHref(it.doc)} onRemove={(doc) => void removeDoc(doc)} {...(projectsAccess.enabled && canCreate ? { onAssignProject: openAssign } : {})} projectName={projectNameFor(it.doc)} />;
                      const path = openPathFor(it.canvas);
                      return <CanvasDocRow key={`c:${it.canvas.canvasId}`} canvas={it.canvas} typeName={typeNameFor(it.canvas.canvasTypeId)} Icon={canvasTypeIcon(it.canvas.canvasTypeId)} {...(path ? { href: path } : {})} onRemove={(c) => void removeCanvas(c)} projectName={canvasProjectNameFor(it.canvas)} />;
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        )}
      </OrgSelectionState>

      {assignFor ? (
        <Modal label={t('addToProject')} onClose={() => setAssignFor(null)}>
          <div className="u-grid u-gap-3">
            <h2 className="u-fs-16 u-m-0">{t('addToProjectTitle', { title: assignFor.title })}</h2>
            {projectsFailed ? (
              <Notice variant="warning" announce={t('projectsLoadFailed')}>
                {t('projectsLoadFailed')}{' '}
                <Button variant="secondary" size="sm" onClick={loadProjects}>{t('common:retry')}</Button>
              </Notice>
            ) : projects === null ? <Skeleton /> : (
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">{t('projectLabel')}</span>
                <select autoFocus value={assignProjectId} onChange={(e) => setAssignProjectId(e.target.value)} className="u-w-auto">
                  <option value="">{t('projectNone')}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            <div className="action-bar u-justify-end">
              <Button variant="secondary" size="sm" onClick={() => setAssignFor(null)}>{t('common:cancel')}</Button>
              <Button variant="primary" disabled={busy || projects === null} onClick={() => void saveAssign()}>{t('projectAdd')}</Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {showNew && orgId ? (
        <NewDocumentModal
          orgId={orgId}
          onClose={() => setShowNew(false)}
          onCreated={(doc) => {
            setShowNew(false);
            // Open the new document at its own URL (ADR 0350 Phase 1).
            navigate(`/documents/${doc.documentId}?org=${encodeURIComponent(orgId)}`);
          }}
        />
      ) : null}
    </div>
  );
}
