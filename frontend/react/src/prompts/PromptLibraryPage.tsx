/**
 * `/prompts` route. Lists prompt templates with kind/tag filters and a
 * CRUD surface for user-authored prompts (localStorage; merged with
 * bundled samples + any future BE store via listPrompts).
 */

import { useEffect, useMemo, useState } from 'react';
import { listPrompts, renderLocal } from './promptsClient.js';
import type { PromptKind, PromptTemplate } from './types.js';
import { PageHeader } from '../ui/PageHeader.js';
import { TextField, SelectField, TextareaField } from '../ui/Field.js';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { IconButton } from '../ui/IconButton.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import {
  FileTextIcon,
  SettingsIcon,
  UserIcon,
  ListIcon,
  CodeIcon,
  PencilIcon,
  TrashIcon,
  AlertIcon,
} from '../ui/icons/index.js';
import { refToString } from './types.js';
import { lintPromptForTierOne, tierOneFindingsCount } from './tierOneLint.js';
import { getCapabilities } from '../client/runsClient.js';
import {
  deleteUserPrompt,
  isUserPromptId,
  suggestUserPromptId,
  upsertUserPrompt,
} from './userPrompts.js';

type TierOneCompliance = 'strict' | 'warn' | 'off' | undefined;

const KINDS: { value: PromptKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'few-shot', label: 'Few-shot' },
  { value: 'schema-hint', label: 'Schema hint' },
];

const KIND_LABEL: Record<PromptKind, string> = {
  system: 'System',
  user: 'User',
  'few-shot': 'Few-shot',
  'schema-hint': 'Schema hint',
};

/** Kind is a category axis — differentiate by glyph + label, never by color. */
function KindGlyph({ kind, size = 12 }: { kind: PromptKind; size?: number }): JSX.Element {
  if (kind === 'system') return <SettingsIcon size={size} />;
  if (kind === 'user') return <UserIcon size={size} />;
  if (kind === 'few-shot') return <ListIcon size={size} />;
  return <CodeIcon size={size} />; // schema-hint
}

export function PromptLibraryPage() {
  const [prompts, setPrompts] = useState<PromptTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<PromptKind | 'all'>('all');
  const [search, setSearch] = useState('');
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
      { key: 'all', label: 'All prompts', value: all.length, glyph: <FileTextIcon size={12} /> },
      { key: 'system', label: 'System', value: count('system'), glyph: <SettingsIcon size={12} /> },
      { key: 'user', label: 'User', value: count('user'), glyph: <UserIcon size={12} /> },
      { key: 'few-shot', label: 'Few-shot', value: count('few-shot'), glyph: <ListIcon size={12} /> },
      { key: 'schema-hint', label: 'Schema hint', value: count('schema-hint'), glyph: <CodeIcon size={12} /> },
    ];
  }, [prompts]);

  const hasFilter = kindFilter !== 'all' || search.trim().length > 0;
  const clearFilters = () => { setKindFilter('all'); setSearch(''); };

  return (
    <section>
      <PageHeader
        eyebrow="Build"
        title="Prompt library"
        lede="Reusable prompts your workflow's AI nodes can pick from. Edit one in a single place and every node that uses it updates the next time it runs — no copy-paste, no drift. System prompts set the AI's role and tone; user prompts shape what you ask of it."
        actions={<button onClick={() => setEditing('new')}>+ New prompt</button>}
      />

      <div className="page-stack">
        {error && <Notice variant="error">{error}</Notice>}

        {tierOneActive && flaggedCount > 0 && (
          <Notice variant={tierOneCompliance === 'strict' ? 'warning' : 'info'}>
            <strong>Tier-1 subset</strong> ({tierOneCompliance}):{' '}
            <strong>{flaggedCount}</strong> schema-hint prompt{flaggedCount === 1 ? '' : 's'} flagged against{' '}
            <a href="https://github.com/openwop/openwop/blob/main/spec/v1/structured-output-subset.md" target="_blank" rel="noopener">structured-output-subset.md</a>.
            Inline chips on each offender point to the specific finding.
          </Notice>
        )}

        <KeyFigureBand
          figures={figures}
          activeKey={kindFilter}
          onToggle={(k) => setKindFilter(k as PromptKind | 'all')}
          ariaLabel="Filter prompts by kind"
        />

        <div className="filterbar" role="group" aria-label="Filter prompts">
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder="templateId, name, description, tag…"
            aria-label="Search prompts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="ui-input filterbar-select"
            aria-label="Filter by kind"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as PromptKind | 'all')}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label === 'All' ? 'All kinds' : k.label}</option>
            ))}
          </select>
          {prompts !== null && (
            <span className="muted u-fs-13 u-nowrap">
              {filtered.length} of {prompts.length} prompt{prompts.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {prompts === null ? (
          <div className="card-grid" aria-busy="true" aria-label="Loading prompts">
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
              title="No prompts match"
              body="Try clearing the search or kind filter."
              action={<button type="button" className="secondary" onClick={clearFilters}>Clear filters</button>}
            />
          ) : (
            <StateCard
              icon={<FileTextIcon size={26} />}
              title="No prompts yet"
              body="Author a reusable prompt your workflow's AI nodes can pick from."
              action={<button type="button" onClick={() => setEditing('new')}>+ New prompt</button>}
            />
          )
        ) : (
          <div className="card-grid">
            {filtered.map((p) => {
              const findings = tierOneActive ? lintPromptForTierOne(p) : [];
              const isUser = isUserPromptId(p.templateId);
              return (
                <div key={`${p.templateId}@${p.version}`} className="surface-card surface-card--interactive u-grid u-gap-2">
                  <button
                    type="button"
                    className="u-button-bare u-grid u-gap-2 u-w-full u-text-left"
                    onClick={() => setSelected(p)}
                  >
                    <div className="action-bar u-justify-between u-items-baseline u-gap-2">
                      <code className="prompt-list-item-id">{refToString(p)}</code>
                      <span className="chip chip--muted u-nowrap">
                        <KindGlyph kind={p.kind} /> {KIND_LABEL[p.kind]}
                      </span>
                    </div>
                    {p.name && <div className="prompt-list-item-name">{p.name}</div>}
                    {p.description && <div className="muted prompt-list-item-desc">{p.description}</div>}
                    {p.tags && p.tags.length > 0 && (
                      <div className="action-bar u-gap-2 u-wrap">
                        {p.tags.map((t) => (
                          <span key={t} className="chip chip--muted">{t}</span>
                        ))}
                      </div>
                    )}
                    {findings.length > 0 && (
                      <div className="action-bar u-gap-2 u-wrap">
                        {findings.map((f) => (
                          <span key={f.rule} className="chip chip--warning" title="Tier-1 subset finding — see structured-output-subset.md">
                            <AlertIcon size={12} /> {f.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                  {isUser && (
                    <div className="action-bar u-gap-2 u-justify-end">
                      <IconButton
                        label={`Edit ${p.name ?? p.templateId}`}
                        icon={<PencilIcon size={15} />}
                        onClick={() => setEditing(p)}
                      />
                      <IconButton
                        label={`Delete ${p.name ?? p.templateId}`}
                        className="icon-button u-text-danger"
                        icon={<TrashIcon size={15} />}
                        onClick={() => setPendingDelete(p)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
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
  const name = prompt.name ?? prompt.templateId;
  return (
    <Modal label={`Delete ${name}`} onClose={onClose}>
      <div className="modal-header">
        <h3>Delete prompt</h3>
      </div>
      <div className="modal-body">
        <p>
          Delete <strong>{name}</strong>? This can&apos;t be undone — any workflow
          node still referencing it will fall back to its inline default.
        </p>
        <div className="action-bar u-gap-2 u-justify-end u-mt-4">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="secondary u-text-danger" onClick={onConfirm}>Delete prompt</button>
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
      setSaveError('Name is required.');
      return;
    }
    if (!text.trim()) {
      setSaveError('Prompt text is required.');
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
    <Modal label={isEdit ? 'Edit prompt' : 'New prompt'} onClose={onClose}>
      <div className="modal-header">
        <h3>{isEdit ? 'Edit prompt' : 'New prompt'}</h3>
        <button className="secondary" onClick={onClose}>Cancel</button>
      </div>
      <div className="modal-body">
        {saveError && <Notice variant="error">{saveError}</Notice>}
        <TextField
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Tone-of-voice editor"
          autoFocus
        />
        <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as PromptKind)}>
          <option value="system">System</option>
          <option value="user">User</option>
          <option value="few-shot">Few-shot</option>
          <option value="schema-hint">Schema hint</option>
        </SelectField>
        <TextField
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this prompt does and when to use it."
        />
        <TextareaField
          label="Prompt text"
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={
            kind === 'user'
              ? 'Mustache-style template. Use {{variable}} for inputs.'
              : 'The system instruction. Set role, tone, output shape.'
          }
          style={{ fontFamily: 'var(--mono, monospace)', fontSize: 13 }}
        />
        <TextField
          label={<>Tags <span className="muted">(comma-separated)</span></>}
          value={tagsRaw}
          onChange={(e) => setTagsRaw(e.target.value)}
          placeholder="editorial, writing"
        />
        {isEdit && existing && (
          <div className="form-row">
            <span className="builder-inspector-field-label">Template ID</span>
            <code className="builder-inspector-typeid">{existing.templateId}</code>
            <div className="muted builder-inspector-help">
              IDs are immutable once created so existing references don&apos;t break.
            </div>
          </div>
        )}
        <div className="action-bar u-gap-2 u-justify-end u-mt-4">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button onClick={onSave}>{isEdit ? 'Save changes' : 'Create prompt'}</button>
        </div>
      </div>
    </Modal>
  );
}

function PromptDetailModal({ prompt, onClose }: { prompt: PromptTemplate; onClose: () => void }) {
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
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
      <div className="modal-body">
        <div className="form-row">
          <span className="builder-inspector-field-label">Ref</span>
          <code className="builder-inspector-typeid">{refToString(prompt)}</code>
        </div>
        <div className="form-row">
          <span className="builder-inspector-field-label">Kind</span>
          <span className="chip chip--muted u-nowrap">
            <KindGlyph kind={prompt.kind} /> {KIND_LABEL[prompt.kind]}
          </span>
        </div>
        {prompt.description && (
          <div className="form-row">
            <span className="builder-inspector-field-label">Description</span>
            <p className="muted">{prompt.description}</p>
          </div>
        )}
        {prompt.variables && prompt.variables.length > 0 && (
          <>
            <div className="builder-inspector-divider" />
            <div className="builder-inspector-section-label">Variables</div>
            {prompt.variables.map((v) => (
              <TextField
                key={v.name}
                label={
                  <>
                    {v.name}
                    {v.required && <span className="builder-inspector-required" aria-hidden> *</span>}
                    {' '}
                    <span className="muted">({v.type}{v.source ? ` from ${v.source}` : ''})</span>
                  </>
                }
                value={bindings[v.name] ?? ''}
                placeholder={v.defaultValue !== undefined ? `default: ${String(v.defaultValue)}` : ''}
                onChange={(e) => setBindings((prev) => ({ ...prev, [v.name]: e.target.value }))}
                {...(v.description ? { help: v.description } : {})}
              />
            ))}
          </>
        )}
        <div className="builder-inspector-divider" />
        <div className="builder-inspector-section-label">Preview (local render)</div>
        {missingRequired.length > 0 && (
          <Notice variant="warning">
            Missing required: {missingRequired.join(', ')}
          </Notice>
        )}
        <pre className="prompt-preview">{rendered}</pre>
        <p className="muted">
          This is a local Mustache-style render. Once the host advertises{' '}
          <code>capabilities.prompts.supported</code>, the preview will route through{' '}
          <code>POST /v1/prompts:render</code> for the deterministic-hash invariant per RFC 0028 §A.
        </p>
      </div>
    </Modal>
  );
}
