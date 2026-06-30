/**
 * NewDocumentModal — the on-demand document-creation flow (replaces the four
 * always-on create/template/starter sections that used to clutter the page).
 *
 * Follows the blank-first, templates-on-demand pattern the incumbents converge
 * on (Word's "New" Start screen, Google Drive's "+ New → Blank / From a
 * template"): the modal first ASKS how to start — Blank or From a template —
 * then progressively discloses the relevant form. Template MANAGEMENT (seed
 * from the starter catalog, delete) lives behind a "Manage templates" step, so
 * template chrome is never forced onto the main page. Templates + catalog load
 * lazily on first need, so a visit that only reads documents fetches neither.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { ArrowLeftIcon, BookOpenIcon, FileTextIcon, PlusIcon, SettingsIcon, SparklesIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  createDocument, listTemplates, deleteTemplate, assembleTemplate, listCatalog, instantiateFromCatalog,
  materializeFromCanvas, SEEDED_KINDS,
  type DocumentRecord, type DocumentTemplate, type SeedTemplate,
} from './documentsClient.js';

type Step = 'choose' | 'blank' | 'canvas' | 'template' | 'assemble' | 'manage';

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
  const [step, setStep] = useState<Step>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string>('sow');
  const [canvasId, setCanvasId] = useState('');

  // Loaded lazily the first time the template/manage steps are opened.
  const [templates, setTemplates] = useState<DocumentTemplate[] | null>(null);
  const [catalog, setCatalog] = useState<SeedTemplate[]>([]);

  const [assembleFor, setAssembleFor] = useState<DocumentTemplate | null>(null);
  const [assembleParams, setAssembleParams] = useState<Record<string, string>>({});
  const [assembled, setAssembled] = useState('');

  async function loadTemplates(): Promise<void> {
    try {
      const [tmpls, cat] = await Promise.all([listTemplates(orgId), listCatalog(orgId)]);
      setTemplates(tmpls);
      setCatalog(cat);
    } catch (e) { setError((e as Error).message); setTemplates([]); }
  }

  function go(next: Step): void {
    setError('');
    if ((next === 'template' || next === 'manage') && templates === null) void loadTemplates();
    setStep(next);
  }

  async function createBlank(): Promise<void> {
    if (!title.trim()) return;
    setBusy(true); setError('');
    try {
      const doc = await createDocument(orgId, { title: title.trim(), kind });
      await onCreated(doc);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function importFromCanvas(): Promise<void> {
    if (!canvasId.trim()) return;
    setBusy(true); setError('');
    try {
      const r = await materializeFromCanvas(orgId, canvasId.trim());
      await onCreated({ documentId: r.documentId } as DocumentRecord);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function useTemplate(tmpl: DocumentTemplate): Promise<void> {
    setBusy(true); setError('');
    try {
      const doc = await createDocument(orgId, { title: tmpl.name, kind: tmpl.kind, format: tmpl.outputFormat });
      await onCreated(doc);
    } catch (e) { setError((e as Error).message); setBusy(false); }
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
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function seedStarter(catalogId: string): Promise<void> {
    setBusy(true); setError('');
    try {
      await instantiateFromCatalog(orgId, catalogId);
      setTemplates(await listTemplates(orgId));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function removeTemplate(templateId: string): Promise<void> {
    setBusy(true); setError('');
    try {
      await deleteTemplate(orgId, templateId);
      setTemplates(await listTemplates(orgId));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const BackButton = ({ to }: { to: Step }): JSX.Element => (
    <button type="button" className="btn-ghost btn-sm" onClick={() => go(to)}>
      <ArrowLeftIcon size={14} aria-hidden /> {t('common:back')}
    </button>
  );

  return (
    <Modal label={t('newDocumentButton')} onClose={onClose} error={error || undefined}>
      {step === 'choose' ? (
        <div className="u-grid u-gap-3">
          <h2 className="u-fs-16 u-m-0">{t('newDocumentButton')}</h2>
          <p className="muted u-m-0">{t('newChoosePrompt')}</p>
          <div className="u-flex u-gap-3 u-wrap">
            <button type="button" className="surface-card u-flex-1 u-flex u-flex-col u-items-center u-gap-2 u-text-center" onClick={() => go('blank')}>
              <FileTextIcon size={26} aria-hidden />
              <strong>{t('newBlankTitle')}</strong>
              <span className="muted u-fs-12">{t('newBlankHint')}</span>
            </button>
            <button type="button" className="surface-card u-flex-1 u-flex u-flex-col u-items-center u-gap-2 u-text-center" onClick={() => go('template')}>
              <BookOpenIcon size={26} aria-hidden />
              <strong>{t('newTemplateTitle')}</strong>
              <span className="muted u-fs-12">{t('newTemplateHint')}</span>
            </button>
          </div>
          <div className="action-bar u-justify-between">
            <button type="button" className="btn-ghost btn-sm" onClick={() => go('canvas')}>{t('fromCanvasButton')}</button>
            <button type="button" className="secondary btn-sm" onClick={onClose}>{t('common:cancel')}</button>
          </div>
        </div>
      ) : null}

      {step === 'blank' ? (
        <div className="u-grid u-gap-3">
          <h2 className="u-fs-16 u-m-0">{t('newBlankTitle')}</h2>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('newDocumentLabel')}</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('newDocumentPlaceholder')} />
          </label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('kindLabel')}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="u-w-auto">
              {SEEDED_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <div className="action-bar u-justify-between">
            <BackButton to="choose" />
            <button type="button" className="btn-primary" disabled={busy || !title.trim()} onClick={() => void createBlank()}>
              <PlusIcon size={14} aria-hidden /> {t('newDocumentButton')}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'canvas' ? (
        <div className="u-grid u-gap-3">
          <h2 className="u-fs-16 u-m-0">{t('fromCanvasButton')}</h2>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('fromCanvasLabel')}</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus value={canvasId} onChange={(e) => setCanvasId(e.target.value)} placeholder={t('fromCanvasPlaceholder')} aria-label={t('fromCanvasAriaLabel')} />
          </label>
          <div className="action-bar u-justify-between">
            <BackButton to="choose" />
            <button type="button" className="btn-primary" disabled={busy || !canvasId.trim()} onClick={() => void importFromCanvas()}>
              <PlusIcon size={14} aria-hidden /> {t('fromCanvasButton')}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'template' ? (
        <div className="u-grid u-gap-3">
          <div className="u-flex u-items-center u-gap-2">
            <h2 className="u-fs-16 u-m-0 u-flex-1">{t('newTemplateTitle')}</h2>
            <button type="button" className="btn-ghost btn-sm" onClick={() => go('manage')}>
              <SettingsIcon size={14} aria-hidden /> {t('manageTemplates')}
            </button>
          </div>
          {templates === null ? (
            <Skeleton />
          ) : templates.length === 0 ? (
            <StateCard
              icon={<BookOpenIcon size={20} />}
              title={t('noTemplatesTitle')}
              body={t('noTemplatesBody')}
              action={<button type="button" className="secondary" onClick={() => go('manage')}>{t('manageTemplates')}</button>}
            />
          ) : (
            <div className="card-grid">
              {templates.map((tmpl) => (
                <article key={tmpl.templateId} className="surface-card u-flex u-flex-col u-gap-2">
                  <span className="u-flex u-items-center u-gap-2 u-wrap">
                    <strong className="u-fs-14">{tmpl.name}</strong>
                    <span className="chip chip--muted">{tmpl.kind}</span>
                  </span>
                  <div className="action-bar u-justify-end u-mt-auto">
                    {hasParams(tmpl) ? (
                      <button type="button" className="secondary btn-sm" onClick={() => openAssemble(tmpl)}>
                        <SparklesIcon size={14} aria-hidden /> {t('assemble')}
                      </button>
                    ) : null}
                    <button type="button" className="btn-accent btn-sm" disabled={busy} onClick={() => void useTemplate(tmpl)}>{t('useTemplate')}</button>
                  </div>
                </article>
              ))}
            </div>
          )}
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
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void runAssemble()}>
              <SparklesIcon size={14} aria-hidden /> {t('assemble')}
            </button>
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
                <button type="button" className="btn-ghost" disabled={busy} aria-label={t('deleteTemplateAriaLabel')} onClick={() => void removeTemplate(tmpl.templateId)}><TrashIcon size={14} aria-hidden /></button>
              </div>
            ))}
          </div>
          {catalog.length > 0 ? (
            <div className="u-grid u-gap-2">
              <span className="u-label-sm">{t('starterTemplates')}</span>
              {catalog.map((c) => (
                <div key={c.catalogId} className="u-flex u-items-center u-gap-2">
                  <span className="u-flex-1">{c.name} <span className="chip chip--muted">{c.kind}</span></span>
                  <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void seedStarter(c.catalogId)}><PlusIcon size={14} aria-hidden /> {t('use')}</button>
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
