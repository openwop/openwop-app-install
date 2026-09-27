/**
 * NewDocumentModal — the creation hub for everything a user can make from the
 * Documents page (ADR 0314, redesigned from the two-card + footer-link modal).
 *
 * The first step answers "what do you want to make?" in three labeled groups —
 * Write (text document) / Design (one card per toggle-ENABLED canvas type,
 * including pack-declared types) / Start from existing (template, canvas
 * picker). The grouping is the information: canvas types are peers of text
 * documents, not an afterthought. Creating a canvas lands the user in its
 * editor; creating a document stays here. "From a canvas" is a picker over the
 * tenant's real canvases (never a raw-id input), and both create paths take an
 * optional project (the ownerSubject plumbing that already existed backend-side).
 *
 * Template MANAGEMENT stays behind the "Manage templates" step; templates +
 * catalog + projects + canvases all load lazily on first need.
 */

import { Button } from '../../ui/Button.js';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { TemplateGalleryBody } from '../../ui/TemplateGallery.js';
import { Skeleton } from '../../ui/Skeleton.js';
import {
  ArrowLeftIcon, BookOpenIcon, CopyIcon, FileTextIcon, PackageIcon, PlusIcon, SettingsIcon, SparklesIcon, TrashIcon,
} from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useCreatableTypeAccess } from '../../canvas/useCreatableTypeAccess.js';
import { createCanvasClient, listPackCanvasTypes, type PackCanvasTypeRow } from '../../canvas/canvasClient.js';
import { CREATABLE_CANVAS_TYPES, canvasTypeNameKey, canvasTypeIcon, type CreatableCanvasType } from '../../canvas/creatableTypes.js';
import { listProjects, type Project } from '../projects/projectsClient.js';
import {
  createDocument, listTemplates, deleteTemplate, assembleTemplate, listCatalog, instantiateFromCatalog,
  materializeFromCanvas, listCanvasSources, SEEDED_KINDS,
  type DocumentRecord, type DocumentTemplate, type SeedTemplate, type CanvasSourceRow,
} from './documentsClient.js';

type Step = 'choose' | 'blank' | 'canvasNew' | 'canvas' | 'template' | 'assemble' | 'manage';

/** The canvas type a Design card creates — first-party (static registry) or
 *  pack-declared (live rows from the canvas-packs types endpoint). */
type NewCanvasTarget =
  | { kind: 'first-party'; def: CreatableCanvasType }
  | { kind: 'pack'; row: PackCanvasTypeRow };

function hasParams(tmpl: DocumentTemplate): boolean {
  return Object.keys(tmpl.parameters.properties ?? {}).length > 0;
}

export function NewDocumentModal({ orgId, onClose, onCreated }: {
  orgId: string;
  onClose: () => void;
  /** Created/opened a document — the page refreshes its list and opens it. */
  onCreated: (doc: DocumentRecord) => void | Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('documents');
  const { t: tc } = useTranslation('canvas');
  const { t: tcom } = useTranslation('common');
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string>('sow');
  const [projectId, setProjectId] = useState('');
  const [canvasTarget, setCanvasTarget] = useState<NewCanvasTarget | null>(null);

  // The ONE shared per-type access map (architect review of #1609) — keyed by
  // toggle id so a registry reorder can never gate the wrong card; plus the
  // pack + projects gates.
  const accessByToggle = useCreatableTypeAccess();
  const packsAccess = useFeatureAccess('canvas-packs');
  const projectsAccess = useFeatureAccess('projects');
  // DOCNEW-1: every first-party type stays VISIBLE — a type whose editor
  // toggle is off renders as a non-interactive card with an "Off" chip (the
  // ADR 0316 canvases-browser precedent), so nothing is ever silently hidden.
  const isTypeEnabled = (def: CreatableCanvasType): boolean => accessByToggle[def.toggleId]?.enabled === true;

  // Loaded lazily on first need.
  const [templates, setTemplates] = useState<DocumentTemplate[] | null>(null);
  // The catch below sets templates to [] but leaves `catalog` untouched, so a failed
  // read drew "No templates yet — add one from the starter catalog" plus a button into
  // that catalog: an instruction, and a control, both resting on a read that failed.
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [catalog, setCatalog] = useState<SeedTemplate[]>([]);
  const [projects, setProjects] = useState<Project[] | null>(null);
  // DOCT-8 — a failed projects read must not render as "no projects" (the
  // UX-DOC-4 failed-as-empty class, already fixed on DocumentsPage and
  // reintroduced here in the sibling component).
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [sources, setSources] = useState<CanvasSourceRow[] | null>(null);
  // A failed canvas read fell to `[]` and drew "No canvases yet — canvases you create will
  // appear here", telling someone whose read just failed that they own nothing.
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const [sourcesTotal, setSourcesTotal] = useState(0);
  const [pickerQuery, setPickerQuery] = useState('');
  const [packTypes, setPackTypes] = useState<PackCanvasTypeRow[]>([]);

  const [assembleFor, setAssembleFor] = useState<DocumentTemplate | null>(null);
  const [assembleParams, setAssembleParams] = useState<Record<string, string>>({});
  const [assembled, setAssembled] = useState('');

  // Pack-type cards need their rows to RENDER the gallery, so this is the one
  // eager load — and only when the canvas-packs toggle is on. Failure = no
  // pack cards (the first-party gallery still works).
  useEffect(() => {
    if (!packsAccess.enabled) return;
    let cancelled = false;
    listPackCanvasTypes(orgId).then((rows) => { if (!cancelled) setPackTypes(rows); }).catch(() => { /* no pack cards */ });
    return () => { cancelled = true; };
  }, [orgId, packsAccess.enabled]);

  async function loadTemplates(): Promise<void> {
    try {
      const [tmpls, cat] = await Promise.all([listTemplates(orgId), listCatalog(orgId)]);
      setTemplates(tmpls);
      setCatalog(cat);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); setTemplates([]); setTemplatesFailed(true); }
  }

  function go(next: Step): void {
    setError('');
    if ((next === 'template' || next === 'manage') && templates === null) void loadTemplates();
    if ((next === 'blank' || next === 'canvasNew') && projectsAccess.enabled && projects === null) {
      void loadProjects();
    }
    setStep(next);
  }

  // The From-canvas picker's rows — server-backed search (ADR 0316), debounced,
  // so the newest-200 cap is never a dead end for a canvas-heavy tenant. The
  // `stale` flag drops a slow response that a newer query has superseded.
  useEffect(() => {
    if (step !== 'canvas') return;
    const q = pickerQuery;
    let stale = false;
    const timer = setTimeout(() => {
      setSourcesFailed(false);
      listCanvasSources(orgId, q)
        .then((r) => { if (!stale) { setSources(r.canvases); setSourcesTotal(r.total); } })
        .catch((e) => { if (!stale) { setError(e instanceof Error ? e.message : t('actionFailed')); setSources([]); setSourcesTotal(0); setSourcesFailed(true); } });
    }, q ? 300 : 0);
    return () => { stale = true; clearTimeout(timer); };
    // t is stable per i18next; orgId is fixed for the modal's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, pickerQuery, orgId]);

  function pickCanvasType(target: NewCanvasTarget): void {
    setCanvasTarget(target);
    setTitle('');
    go('canvasNew');
  }

  const owner = (): { ownerSubject?: { kind: string; id: string } } =>
    projectId ? { ownerSubject: { kind: 'project', id: projectId } } : {};

  async function createBlank(): Promise<void> {
    if (!title.trim()) return;
    setBusy(true); setError('');
    try {
      const doc = await createDocument(orgId, { title: title.trim(), kind, ...owner() });
      await onCreated(doc);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  }

  async function createCanvas(): Promise<void> {
    if (!canvasTarget || !title.trim()) return;
    setBusy(true); setError('');
    try {
      const basePath = canvasTarget.kind === 'first-party'
        ? canvasTarget.def.basePath
        : `/host/openwop-app/canvas-packs/${canvasTarget.row.canvasTypeId}`;
      const rec = await createCanvasClient({ basePath }).createCanvas(orgId, { name: title.trim(), ...(projectId ? { projectId } : {}) });
      const path = canvasTarget.kind === 'first-party'
        ? `${canvasTarget.def.editorPath}/${rec.canvasId}`
        : `/canvas/${canvasTarget.row.canvasTypeId}/${rec.canvasId}`;
      onClose();
      navigate(path);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  }

  async function importFromCanvas(canvasId: string): Promise<void> {
    setBusy(true); setError('');
    try {
      const r = await materializeFromCanvas(orgId, canvasId);
      // UX-DOC-2 — the server tells us whether it CREATED a document or handed
      // back one this canvas already had (`created`). Dropping that field made
      // "here is your new document" and "you already had one, here it is"
      // identical, so a user could believe they had a fresh copy while editing
      // a document someone else may already be working in.
      if (!r.created) toast.info(t('canvasAlreadyMaterialized'));
      await onCreated({ documentId: r.documentId } as DocumentRecord);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  }

  async function applyTemplate(tmpl: DocumentTemplate): Promise<void> {
    setBusy(true); setError('');
    try {
      // DOCTPL-8 (partial) — "Use" now WRITES the doc→template link (the
      // unbackfillable half; server-validated to exist in this org). The doc
      // still starts empty — seeding content and a template view/edit surface
      // are the recorded product decision (DOCTPL-7/-9), not patched here.
      const doc = await createDocument(orgId, { title: tmpl.name, kind: tmpl.kind, format: tmpl.outputFormat, templateId: tmpl.templateId });
      await onCreated(doc);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  }

  function openAssemble(tmpl: DocumentTemplate): void {
    setError(''); setAssembled('');
    const init: Record<string, string> = {};
    for (const key of Object.keys(tmpl.parameters.properties ?? {})) init[key] = '';
    setAssembleParams(init);
    setAssembleFor(tmpl);
    setStep('assemble');
  }

  async function runAssemble(): Promise<void> {
    if (!assembleFor) return;
    setBusy(true); setError(''); setAssembled('');
    try {
      const result = await assembleTemplate(orgId, assembleFor.templateId, assembleParams);
      setAssembled(result.augmentedPrompt);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }

  async function seedStarter(catalogId: string): Promise<void> {
    setBusy(true); setError('');
    try {
      await instantiateFromCatalog(orgId, catalogId);
      setTemplates(await listTemplates(orgId));
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }

  async function removeTemplate(templateId: string): Promise<void> {
    if (!(await confirm({ title: t('deleteTemplateConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
    setBusy(true); setError('');
    try {
      await deleteTemplate(orgId, templateId);
      setTemplates(await listTemplates(orgId));
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }

  const BackButton = ({ to }: { to: Step }): JSX.Element => (
    <Button variant="quiet" size="sm" onClick={() => go(to)}>
      <ArrowLeftIcon size={14} aria-hidden /> {t('common:back')}
    </Button>
  );

  /** One creation card — icon + noun + one-line hint, the shared gallery idiom. */
  const GalleryCard = ({ icon, label, hint, onPick }: { icon: JSX.Element; label: string; hint: string; onPick: () => void }): JSX.Element => (
    <button type="button" className="surface-card u-flex u-flex-col u-gap-1 u-text-left doc-gallery__card" onClick={onPick}>
      <span className="u-flex u-items-center u-gap-2">
        {icon} <strong className="u-fs-13">{label}</strong>
      </span>
      <span className="muted u-fs-12">{hint}</span>
    </button>
  );

  // DOCNEW-6: a real heading labels the section via aria-labelledby (heading
  // nav works; the visible label is no longer double-announced by aria-label).
  const GalleryGroup = ({ label, children }: { label: string; children: ReactNode }): JSX.Element => {
    const headingId = useId();
    return (
      <section className="u-grid u-gap-2" aria-labelledby={headingId}>
        <h3 id={headingId} className="u-label-sm muted u-m-0">{label}</h3>
        <div className="doc-gallery__cards">{children}</div>
      </section>
    );
  };

  /** DOCNEW-1: the non-interactive face of a toggle-off canvas type. */
  const GalleryCardOff = ({ icon, label, hint }: { icon: JSX.Element; label: string; hint: string }): JSX.Element => (
    <div className="surface-card u-flex u-flex-col u-gap-1 u-text-left doc-gallery__card doc-gallery__card--off">
      <span className="u-flex u-items-center u-gap-2">
        {icon} <strong className="u-fs-13">{label}</strong> <span className="chip chip--muted">{t('editorOff')}</span>
      </span>
      <span className="muted u-fs-12">{hint}</span>
    </div>
  );

  /** Optional project select — shown on create steps when Projects is enabled
   *  and the tenant has any. A render FUNCTION (not a nested component): a
   *  component type recreated per render would remount the <select> and drop
   *  focus after every selection. */
  // DOCT-8 — the DocumentsPage pattern: state the failure + offer retry,
  // never silently drop the picker.
  async function loadProjects(): Promise<void> {
    setProjectsFailed(false);
    try { setProjects(await listProjects()); } catch { setProjects(null); setProjectsFailed(true); }
  }

  const renderProjectSelect = (): JSX.Element | null => {
    if (!projectsAccess.enabled) return null;
    if (projectsFailed) {
      return (
        <Notice variant="warning" announce={t('projectsLoadFailed')}>
          {t('projectsLoadFailed')}{' '}
          <Button variant="secondary" size="sm" onClick={() => void loadProjects()}>{t('common:retry')}</Button>
        </Notice>
      );
    }
    if (projects === null || projects.length === 0) return null;
    return (
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('projectLabel')}</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="u-w-auto">
          <option value="">{t('projectNone')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
    );
  };

  const typeLabel = (canvasTypeId: string): string => {
    const key = canvasTypeNameKey(canvasTypeId);
    if (key) return tc(key);
    const pack = packTypes.find((p) => p.canvasTypeId === canvasTypeId);
    return pack?.title ?? canvasTypeId.replace(/^canvas\./, '');
  };

  return (
    <Modal label={t('newDocumentButton')} onClose={onClose} showClose error={error || undefined}>
      {step === 'choose' ? (
        <div className="u-grid u-gap-3">
          <h2 className="u-fs-16 u-m-0">{t('newDocumentButton')}</h2>
          <p className="muted u-m-0">{t('newChoosePrompt')}</p>

          <GalleryGroup label={t('groupWrite')}>
            <GalleryCard icon={<FileTextIcon size={18} aria-hidden />} label={t('newBlankTitle')} hint={t('newBlankHint')} onPick={() => go('blank')} />
          </GalleryGroup>

          <GalleryGroup label={t('groupDesign')}>
            {CREATABLE_CANVAS_TYPES.map((def) => {
              const Icon = canvasTypeIcon(def.canvasTypeId);
              return isTypeEnabled(def) ? (
                <GalleryCard
                  key={def.canvasTypeId}
                  icon={<Icon size={18} aria-hidden />}
                  label={tc(def.nameKey)}
                  hint={tc(def.hintKey)}
                  onPick={() => pickCanvasType({ kind: 'first-party', def })}
                />
              ) : (
                <GalleryCardOff
                  key={def.canvasTypeId}
                  icon={<Icon size={18} aria-hidden />}
                  label={tc(def.nameKey)}
                  hint={tc(def.hintKey)}
                />
              );
            })}
            {packsAccess.enabled ? packTypes.map((row) => (
              <GalleryCard
                key={row.canvasTypeId}
                icon={<PackageIcon size={18} aria-hidden />}
                label={row.title}
                hint={t('packTypeHint')}
                onPick={() => pickCanvasType({ kind: 'pack', row })}
              />
            )) : null}
          </GalleryGroup>

          <GalleryGroup label={t('groupReuse')}>
            <GalleryCard icon={<BookOpenIcon size={18} aria-hidden />} label={t('newTemplateTitle')} hint={t('newTemplateHint')} onPick={() => go('template')} />
            <GalleryCard icon={<CopyIcon size={18} aria-hidden />} label={t('fromCanvasTitle')} hint={t('fromCanvasHint')} onPick={() => go('canvas')} />
          </GalleryGroup>

          <div className="action-bar u-justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common:cancel')}</Button>
          </div>
        </div>
      ) : null}

      {step === 'blank' ? (
        <form className="u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void createBlank(); }}>
          <h2 className="u-fs-16 u-m-0">{t('newBlankTitle')}</h2>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('newDocumentLabel')}</span>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('newDocumentPlaceholder')} />
          </label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('kindLabel')}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="u-w-auto">
              {SEEDED_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          {renderProjectSelect()}
          <div className="action-bar u-justify-between">
            <BackButton to="choose" />
            <Button variant="primary" type="submit" disabled={busy || !title.trim()}>
              <PlusIcon size={14} aria-hidden /> {t('newDocumentButton')}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'canvasNew' && canvasTarget ? (
        <form className="u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void createCanvas(); }}>
          <h2 className="u-fs-16 u-m-0">
            {canvasTarget.kind === 'first-party' ? tc(canvasTarget.def.nameKey) : canvasTarget.row.title}
          </h2>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('canvasNameLabel')}</span>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('canvasNamePlaceholder')} />
          </label>
          {renderProjectSelect()}
          <div className="action-bar u-justify-between">
            <BackButton to="choose" />
            <Button variant="primary" type="submit" disabled={busy || !title.trim()}>
              <PlusIcon size={14} aria-hidden /> {t('createAndOpen')}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'canvas' ? (
        <div className="u-grid u-gap-3">
          <h2 className="u-fs-16 u-m-0">{t('fromCanvasTitle')}</h2>
          <p className="muted u-m-0 u-fs-13">{t('canvasPickerPrompt')}</p>
          {sources !== null && (sources.length > 0 || pickerQuery) ? (
            <input
              type="search"
              className="ui-input"
              placeholder={t('canvasPickerSearchPlaceholder')}
              aria-label={t('canvasPickerSearchAria')}
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
          ) : null}
          {sources !== null && sourcesTotal > sources.length ? (
            <span className="muted u-fs-12">{t('canvasPickerTruncated', { shown: sources.length, total: sourcesTotal })}</span>
          ) : null}
          {sources === null ? (
            <Skeleton />
          ) : sources.length === 0 && pickerQuery ? (
            <StateCard
              icon={<CopyIcon size={20} />}
              title={t('canvasPickerNoMatchTitle')}
              body={t('canvasPickerNoMatchBody')}
              action={<Button variant="secondary" onClick={() => setPickerQuery('')}>{t('canvasPickerClearSearch')}</Button>}
            />
          ) : sourcesFailed ? (
            // Above the empty branch: below it, `[]` selects the instruction first.
            // Safe to announce alongside the templates failure card at ~:468: that one is
            // gated on `templatesFailed` in the TEMPLATE step, this on `sourcesFailed` in the
            // CANVAS step — different reads, mutually exclusive by construction, so this is
            // not the one-voice-per-failure clash (two callers of one region for ONE event).
            <StateCard announce icon={<CopyIcon size={20} />} title={tcom('loadFailedTitle')} body={tcom('loadFailedBody')} />
          ) : sources.length === 0 ? (
            <StateCard
              icon={<CopyIcon size={20} />}
              title={t('canvasPickerEmptyTitle')}
              body={t('canvasPickerEmptyBody')}
            />
          ) : (
            <div className="u-grid u-gap-2 doc-gallery__picker">
              {sources.map((c) => (
                <button
                  key={c.canvasId}
                  type="button"
                  className="surface-card u-flex u-items-center u-gap-2 u-text-left"
                  disabled={busy}
                  onClick={() => void importFromCanvas(c.canvasId)}
                >
                  <span className="u-flex-1 u-flex u-flex-col u-gap-1">
                    <strong className="u-fs-13">{c.name || c.canvasId}</strong>
                    <span className="muted u-fs-12">{formatDateTime(c.updatedAt)}</span>
                  </span>
                  <span className="chip chip--muted">{typeLabel(c.canvasTypeId)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="action-bar"><BackButton to="choose" /></div>
        </div>
      ) : null}

      {step === 'template' ? (
        <div className="u-grid u-gap-3">
          <div className="u-flex u-items-center u-gap-2">
            <h2 className="u-fs-16 u-m-0 u-flex-1">{t('newTemplateTitle')}</h2>
            <Button variant="quiet" size="sm" onClick={() => go('manage')}>
              <SettingsIcon size={14} aria-hidden /> {t('manageTemplates')}
            </Button>
          </div>
          {/* §4.5 rule 14 — the shared gallery BODY (not the Dialog): this
              picker is already a step inside this modal, and a modal inside a
              modal is never the answer. Adopting it is what gives the step
              search + a kind facet, which it lacked while the catalog was
              assumed small. `templates.length === 0` keeps its own action
              (Manage templates), so that copy rides in as `emptyTitle`/`emptyBody`
              with the action left on the step header below.

              A template with parameters needs the ASSEMBLE detour rather than a
              direct apply, so `onUse` routes on that — the gallery offers one
              CTA per card and the feature decides what it means. */}
          <TemplateGalleryBody
            items={templates === null ? null : templates.map((tmpl) => ({
              id: tmpl.templateId,
              label: tmpl.name,
              category: tmpl.kind,
              ...(hasParams(tmpl) ? { meta: [t('assemble')] } : {}),
            }))}
            failed={templatesFailed}
            busy={busy}
            emptyTitle={t('noTemplatesTitle')}
            emptyBody={t('noTemplatesBody')}
            onUse={(id) => {
              const tmpl = templates?.find((x) => x.templateId === id);
              if (!tmpl) return;
              if (hasParams(tmpl)) openAssemble(tmpl); else void applyTemplate(tmpl);
            }}
          />
          {templates !== null && !templatesFailed && templates.length === 0 ? (
            <div className="action-bar u-justify-center">
              <Button variant="secondary" onClick={() => go('manage')}>{t('manageTemplates')}</Button>
            </div>
          ) : null}
          <div className="action-bar"><BackButton to="choose" /></div>
        </div>
      ) : null}

      {step === 'assemble' && assembleFor ? (
        <div className="u-grid u-gap-3">
          <h2 className="u-fs-16 u-m-0">{t('assembleHeading', { name: assembleFor.name })}</h2>
          {Object.entries(assembleFor.parameters.properties ?? {}).map(([key, spec]) => (
            <label key={key} className="u-grid u-gap-1">
              <span className="u-label-sm">{key}{assembleFor.parameters.required.includes(key) ? t('paramRequiredSuffix') : ''}{spec.description ? t('paramDescriptionSuffix', { description: spec.description }) : ''}</span>
              <input value={assembleParams[key] ?? ''} onChange={(e) => setAssembleParams((p) => ({ ...p, [key]: e.target.value }))} placeholder={key} />
            </label>
          ))}
          {assembled ? (
            <div className="u-grid u-gap-1">
              <span className="u-label-sm">{t('assembledPromptLabel')}</span>
              <pre className="surface-card u-p-2 u-prewrap">{assembled}</pre>
            </div>
          ) : null}
          <div className="action-bar u-justify-between">
            <BackButton to="template" />
            <Button variant="primary" disabled={busy} onClick={() => void runAssemble()}>
              <SparklesIcon size={14} aria-hidden /> {t('assemble')}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'manage' ? (
        <div className="u-grid u-gap-3">
          <h2 className="u-fs-16 u-m-0">{t('manageTemplates')}</h2>
          <div className="u-grid u-gap-2">
            <span className="u-label-sm">{t('templatesHeading', { count: templates?.length ?? 0 })}</span>
            {templates === null ? <Skeleton /> : templates.length === 0 ? (
              <span className="u-label-sm muted">{t('noTemplates')}</span>
            ) : templates.map((tmpl) => (
              <div key={tmpl.templateId} className="u-flex u-items-center u-gap-2">
                <span className="u-flex-1">{tmpl.name} <span className="chip chip--muted">{tmpl.kind}</span></span>
                <Button variant="quiet" disabled={busy} aria-label={t('deleteTemplateAriaLabel')} onClick={() => void removeTemplate(tmpl.templateId)}><TrashIcon size={14} aria-hidden /></Button>
              </div>
            ))}
          </div>
          {catalog.length > 0 ? (
            <div className="u-grid u-gap-2">
              <span className="u-label-sm">{t('starterTemplates')}</span>
              {catalog.map((c) => (
                <div key={c.catalogId} className="u-flex u-items-center u-gap-2">
                  <span className="u-flex-1">{c.name} <span className="chip chip--muted">{c.kind}</span></span>
                  <Button variant="quiet" size="sm" disabled={busy} onClick={() => void seedStarter(c.catalogId)}><PlusIcon size={14} aria-hidden /> {t('use')}</Button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="action-bar"><BackButton to="template" /></div>
        </div>
      ) : null}
    </Modal>
  );
}
