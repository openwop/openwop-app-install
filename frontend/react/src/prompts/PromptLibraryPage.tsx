/**
 * `/prompts` route. Lists prompt templates with kind/tag filters and a
 * CRUD surface for user-authored prompts (localStorage; merged with
 * bundled samples + any future BE store via listPrompts).
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listPrompts, renderLocal } from './promptsClient.js';
import type { PromptKind, PromptTemplate } from './types.js';
import { PageHeader } from '../ui/PageHeader.js';
import { TextField, SelectField, TextareaField } from '../ui/Field.js';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import {
  FileTextIcon,
  SettingsIcon,
  UserIcon,
  ListIcon,
  CodeIcon,
} from '../ui/icons/index.js';
import { refToString } from './types.js';
import { tierOneFindingsCount } from './tierOneLint.js';
import { getCapabilities } from '../client/runsClient.js';
import { KindGlyph, PromptCard, PromptRow } from './PromptViews.js';
import {
  deleteUserPrompt,
  suggestUserPromptId,
  upsertUserPrompt,
} from './userPrompts.js';

type TierOneCompliance = 'strict' | 'warn' | 'off' | undefined;

const KINDS: { value: PromptKind | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'kindAll' },
  { value: 'system', labelKey: 'kindSystem' },
  { value: 'user', labelKey: 'kindUser' },
  { value: 'few-shot', labelKey: 'kindFewShot' },
  { value: 'schema-hint', labelKey: 'kindSchemaHint' },
] as const;

const KIND_LABEL_KEY: Record<PromptKind, string> = {
  system: 'kindSystem',
  user: 'kindUser',
  'few-shot': 'kindFewShot',
  'schema-hint': 'kindSchemaHint',
} as const;

export function PromptLibraryPage() {
  const { t } = useTranslation('prompts');
  const [prompts, setPrompts] = useState<PromptTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<PromptKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useViewMode('prompts', 'grid');
  const [selected, setSelected] = useState<PromptTemplate | null>(null);
  // Editor modal state. When `editing` is non-null, the EditorModal
  // renders. `null` for the templateId field signals "new prompt"
  // (the editor will mint a fresh id from the name on save).
  const [editing, setEditing] = useState<PromptTemplate | 'new' | null>(null);
  // In-product delete confirm (replaces window.confirm so the destructive
  // flow stays inside the tokened surface language).
  const [pendingDelete, setPendingDelete] = useState<PromptTemplate | null>(null);
  // RFC 0030 §B — host's posture on the OpenAI ∩ Anthropic ∩ Gemini
  // schema subset. When `strict`, schema-hint prompts get a Tier-1 lint
  // chip; when `warn`, the lint runs but the banner copy is softer;
  // when `off` or absent, the lint stays silent.
  const [tierOneCompliance, setTierOneCompliance] = useState<TierOneCompliance>(undefined);

  // refreshNonce bumps after every CRUD mutation so the listPrompts()
  // effect below re-runs and surfaces the just-edited entries.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = () => setRefreshNonce((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    listPrompts({})
      .then((items) => {
        if (!cancelled) setPrompts(items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    // Capability discovery in parallel — don't gate the prompt list on it.
    getCapabilities()
      .then((c) => {
        if (cancelled) return;
        const caps = (c as { capabilities?: { envelopes?: { tierOneSubsetCompliance?: unknown } } }).capabilities;
        const v = caps?.envelopes?.tierOneSubsetCompliance;
        if (v === 'strict' || v === 'warn' || v === 'off') setTierOneCompliance(v);
      })
      .catch(() => { /* best-effort; absence is fine */ });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  // Run the Tier-1 lint once per prompt-list change, regardless of host
  // advertisement (so we can show a banner even when off). The banner
  // copy adapts to the compliance posture; per-row chips show in both
  // strict and warn modes.
  const tierOneActive = tierOneCompliance === 'strict' || tierOneCompliance === 'warn';
  const flaggedCount = useMemo(() => {
    if (!prompts) return 0;
    return tierOneFindingsCount(prompts);
  }, [prompts]);

  const filtered = useMemo(() => {
    if (!prompts) return [];
    const q = search.trim().toLowerCase();
    return prompts.filter((p) => {
      if (kindFilter !== 'all' && p.kind !== kindFilter) return false;
      if (!q) return true;
      const haystack = `${p.templateId} ${p.name ?? ''} ${p.description ?? ''} ${(p.tags ?? []).join(' ')}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [prompts, kindFilter, search]);

  // Stats-are-filters: the kind tiles both report the library's composition
  // and toggle the kind filter for the grid below.
  const figures = useMemo<KeyFigureItem[]>(() => {
    const all = prompts ?? [];
    const count = (k: PromptKind) => all.filter((p) => p.kind === k).length;
    return [
      { key: 'all', label: t('figureAllPrompts'), value: all.length, glyph: <FileTextIcon size={12} /> },
      { key: 'system', label: t('kindSystem'), value: count('system'), glyph: <SettingsIcon size={12} /> },
      { key: 'user', label: t('kindUser'), value: count('user'), glyph: <UserIcon size={12} /> },
      { key: 'few-shot', label: t('kindFewShot'), value: count('few-shot'), glyph: <ListIcon size={12} /> },
      { key: 'schema-hint', label: t('kindSchemaHint'), value: count('schema-hint'), glyph: <CodeIcon size={12} /> },
    ];
  }, [prompts, t]);

  const hasFilter = kindFilter !== 'all' || search.trim().length > 0;
  const clearFilters = () => { setKindFilter('all'); setSearch(''); };

  return (
    <section>
      <PageHeader
        eyebrow={t('pageEyebrow')}
        title={t('pageTitle')}
        lede={t('pageLede')}
        actions={<button type="button" onClick={() => setEditing('new')}>{t('newPrompt')}</button>}
      />

      <div className="page-stack">
        {error && <Notice variant="error">{error}</Notice>}

        {tierOneActive && flaggedCount > 0 && (
          <Notice variant={tierOneCompliance === 'strict' ? 'warning' : 'info'}>
            <strong>{t('tierOneStrong')}</strong> {t('tierOnePosture', { posture: tierOneCompliance })}{' '}
            <strong>{flaggedCount}</strong> {t('tierOneFlagged', { count: flaggedCount })}{' '}
            <a href="https://github.com/openwop/openwop/blob/main/spec/v1/structured-output-subset.md" target="_blank" rel="noopener">{t('tierOneLinkText')}</a>.
            {' '}{t('tierOneFindingHint')}
          </Notice>
        )}

        <KeyFigureBand
          figures={figures}
          activeKey={kindFilter}
          onToggle={(k) => setKindFilter(k as PromptKind | 'all')}
          ariaLabel={t('filterByKindAria')}
        />

        <div className="filterbar" role="group" aria-label={t('filterGroupAria')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchAria')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="ui-input filterbar-select"
            aria-label={t('filterByKindSelectAria')}
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as PromptKind | 'all')}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.value === 'all' ? t('kindAllKinds') : t(k.labelKey)}</option>
            ))}
          </select>
          {prompts !== null && (
            <span className="muted u-fs-13 u-nowrap">
              {t('countSummary', { count: prompts.length, filtered: filtered.length, total: prompts.length })}
            </span>
          )}
          <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
        </div>

        {prompts === null ? (
          <div className="card-grid" aria-busy="true" aria-label={t('loadingPromptsAria')}>
            {Array.from({ length: 6 }, (_, i) => (
              <div className="surface-card u-grid u-gap-2" key={i}>
                <Skeleton width="55%" height={16} />
                <Skeleton width="80%" />
                <Skeleton width="40%" height={20} radius={999} />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          hasFilter ? (
            <StateCard
              icon={<FileTextIcon size={26} />}
              title={t('noMatchTitle')}
              body={t('noMatchBody')}
              action={<button type="button" className="secondary" onClick={clearFilters}>{t('clearFilters')}</button>}
            />
          ) : (
            <StateCard
              icon={<FileTextIcon size={26} />}
              title={t('emptyTitle')}
              body={t('emptyBody')}
              action={<button type="button" onClick={() => setEditing('new')}>{t('newPrompt')}</button>}
            />
          )
        ) : viewMode === 'grid' ? (
          <div className="card-grid">
            {filtered.map((p) => (
              <PromptCard
                key={`${p.templateId}@${p.version}`}
                prompt={p}
                tierOneActive={tierOneActive}
                onSelect={setSelected}
                onEdit={setEditing}
                onDelete={setPendingDelete}
              />
            ))}
          </div>
        ) : (
          <div className="surface-card list-view">
            {filtered.map((p) => (
              <PromptRow
                key={`${p.templateId}@${p.version}`}
                prompt={p}
                tierOneActive={tierOneActive}
                onSelect={setSelected}
                onEdit={setEditing}
                onDelete={setPendingDelete}
              />
            ))}
          </div>
        )}
      </div>

      {selected && <PromptDetailModal prompt={selected} onClose={() => setSelected(null)} />}
      {editing && (
        <PromptEditorModal
          existing={editing === 'new' ? null : editing}
          allIds={(prompts ?? []).map((p) => p.templateId)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {pendingDelete && (
        <DeletePromptModal
          prompt={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => {
            deleteUserPrompt(pendingDelete.templateId);
            setPendingDelete(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

function DeletePromptModal({
  prompt,
  onClose,
  onConfirm,
}: {
  prompt: PromptTemplate;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('prompts');
  const name = prompt.name ?? prompt.templateId;
  return (
    <Modal label={t('deleteModalLabel', { name })} onClose={onClose}>
      <div className="modal-header">
        <h3>{t('deleteModalTitle')}</h3>
      </div>
      <div className="modal-body">
        <p>
          {t('deleteModalBodyPrefix')} <strong>{name}</strong>{t('deleteModalBodySuffix')}
        </p>
        <div className="action-bar u-gap-2 u-justify-end u-mt-4">
          <button type="button" className="secondary" onClick={onClose}>{t('common:cancel')}</button>
          <button type="button" className="secondary u-text-danger" onClick={onConfirm}>{t('deletePromptButton')}</button>
        </div>
      </div>
    </Modal>
  );
}

function PromptEditorModal({
  existing,
  allIds,
  onClose,
  onSaved,
}: {
  existing: PromptTemplate | null;
  allIds: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('prompts');
  const isEdit = existing !== null;
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<PromptKind>(existing?.kind ?? 'system');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [text, setText] = useState(existing?.text ?? '');
  const [tagsRaw, setTagsRaw] = useState((existing?.tags ?? []).join(', '));
  const [saveError, setSaveError] = useState<string | null>(null);

  function onSave() {
    setSaveError(null);
    if (!name.trim()) {
      setSaveError(t('errorNameRequired'));
      return;
    }
    if (!text.trim()) {
      setSaveError(t('errorTextRequired'));
      return;
    }
    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const templateId =
      existing?.templateId ??
      suggestUserPromptId(name, allIds);
    const prompt: PromptTemplate = {
      templateId,
      version: existing?.version ?? '1.0.0',
      kind,
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      text,
      ...(tags.length > 0 ? { tags } : {}),
      meta: { source: 'host', author: 'user' },
    };
    upsertUserPrompt(prompt);
    onSaved();
  }

  return (
    <Modal label={isEdit ? t('editModalTitle') : t('newModalTitle')} onClose={onClose}>
      <div className="modal-header">
        <h3>{isEdit ? t('editModalTitle') : t('newModalTitle')}</h3>
        <button type="button" className="secondary" onClick={onClose}>{t('common:cancel')}</button>
      </div>
      <div className="modal-body">
        {saveError && <Notice variant="error">{saveError}</Notice>}
        <TextField
          label={t('fieldName')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('namePlaceholder')}
          autoFocus
        />
        <SelectField label={t('fieldKind')} value={kind} onChange={(e) => setKind(e.target.value as PromptKind)}>
          <option value="system">{t('kindSystem')}</option>
          <option value="user">{t('kindUser')}</option>
          <option value="few-shot">{t('kindFewShot')}</option>
          <option value="schema-hint">{t('kindSchemaHint')}</option>
        </SelectField>
        <TextField
          label={t('fieldDescription')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('descriptionPlaceholder')}
        />
        <TextareaField
          label={t('fieldPromptText')}
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={
            kind === 'user'
              ? t('promptTextPlaceholderUser', { token: '{{variable}}' })
              : t('promptTextPlaceholderSystem')
          }
        />
        <TextField
          label={<>{t('fieldTags')} <span className="muted">{t('tagsHint')}</span></>}
          value={tagsRaw}
          onChange={(e) => setTagsRaw(e.target.value)}
          placeholder={t('tagsPlaceholder')}
        />
        {isEdit && existing && (
          <div className="form-row">
            <span className="builder-inspector-field-label">{t('templateIdLabel')}</span>
            <code className="builder-inspector-typeid">{existing.templateId}</code>
            <div className="muted builder-inspector-help">
              {t('templateIdHelp')}
            </div>
          </div>
        )}
        <div className="action-bar u-gap-2 u-justify-end u-mt-4">
          <button type="button" className="secondary" onClick={onClose}>{t('common:cancel')}</button>
          <button type="button" onClick={onSave}>{isEdit ? t('saveChanges') : t('createPrompt')}</button>
        </div>
      </div>
    </Modal>
  );
}

function PromptDetailModal({ prompt, onClose }: { prompt: PromptTemplate; onClose: () => void }) {
  const { t } = useTranslation('prompts');
  const [bindings, setBindings] = useState<Record<string, string>>({});

  const { rendered, missingRequired } = useMemo(() => {
    const typed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bindings)) {
      const decl = (prompt.variables ?? []).find((d) => d.name === k);
      if (decl?.type === 'number') {
        const n = Number(v);
        typed[k] = Number.isFinite(n) ? n : v;
      } else if (decl?.type === 'boolean') {
        typed[k] = v === 'true';
      } else {
        typed[k] = v;
      }
    }
    return renderLocal(prompt, typed);
  }, [prompt, bindings]);

  return (
    <Modal label={prompt.name ?? prompt.templateId} onClose={onClose}>
      <div className="modal-header">
        <h3>{prompt.name ?? prompt.templateId}</h3>
        <button type="button" className="secondary" onClick={onClose}>{t('common:close')}</button>
      </div>
      <div className="modal-body">
        <div className="form-row">
          <span className="builder-inspector-field-label">{t('detailRef')}</span>
          <code className="builder-inspector-typeid">{refToString(prompt)}</code>
        </div>
        <div className="form-row">
          <span className="builder-inspector-field-label">{t('detailKind')}</span>
          <span className="chip chip--muted u-nowrap">
            <KindGlyph kind={prompt.kind} /> {t(KIND_LABEL_KEY[prompt.kind])}
          </span>
        </div>
        {prompt.description && (
          <div className="form-row">
            <span className="builder-inspector-field-label">{t('detailDescription')}</span>
            <p className="muted">{prompt.description}</p>
          </div>
        )}
        {prompt.variables && prompt.variables.length > 0 && (
          <>
            <div className="builder-inspector-divider" />
            <div className="builder-inspector-section-label">{t('detailVariables')}</div>
            {prompt.variables.map((v) => (
              <TextField
                key={v.name}
                label={
                  <>
                    {v.name}
                    {v.required && <span className="builder-inspector-required" aria-hidden> *</span>}
                    {' '}
                    <span className="muted">
                      {v.source
                        ? t('variableMetaFromSource', { type: v.type, source: v.source })
                        : t('variableMeta', { type: v.type })}
                    </span>
                  </>
                }
                value={bindings[v.name] ?? ''}
                placeholder={v.defaultValue !== undefined ? t('variableDefault', { value: String(v.defaultValue) }) : ''}
                onChange={(e) => setBindings((prev) => ({ ...prev, [v.name]: e.target.value }))}
                {...(v.description ? { help: v.description } : {})}
              />
            ))}
          </>
        )}
        <div className="builder-inspector-divider" />
        <div className="builder-inspector-section-label">{t('previewLabel')}</div>
        {missingRequired.length > 0 && (
          <Notice variant="warning">
            {t('missingRequired', { vars: missingRequired.join(', ') })}
          </Notice>
        )}
        <pre className="prompt-preview">{rendered}</pre>
        <p className="muted">
          {t('localRenderNotePrefix')}{' '}
          <code>capabilities.prompts.supported</code>{t('localRenderNoteMiddle')}{' '}
          <code>POST /v1/prompts:render</code> {t('localRenderNoteSuffix')}
        </p>
      </div>
    </Modal>
  );
}
