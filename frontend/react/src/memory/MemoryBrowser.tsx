/**
 * MemoryBrowser (ADR 0041) — ONE memory-browser component for every subject.
 *
 * A subject's curated memories (facts/notes) rendered as a list with add + delete.
 * Subject-agnostic: it takes `list`/`add`/`remove` callbacks, so the SAME UI
 * serves an agent's memory (Agent workspace → Memory tab) and a human's personal
 * memory (My Profile → Memory tab) — the visible counterpart of the one backend
 * seam. Trusted/untrusted chips mirror the per-agent Knowledge panel (ADR 0038 §C).
 *
 * `ui/` cohesion: StateCard / Field / chip / Notice / icons; tokens only.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../i18n/format.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Field } from '../ui/Field.js';
import { SparklesIcon, PlusIcon, TrashIcon } from '../ui/icons/index.js';

export interface SubjectMemoryNote {
  id: string;
  content: string;
  contentTrust: 'trusted' | 'untrusted';
  createdAt: string;
}

export interface MemoryBrowserProps {
  /** Load the subject's memories (newest first). */
  list: () => Promise<SubjectMemoryNote[]>;
  /** Add a memory, returning the refreshed list. Omit to render read-only. */
  add?: (content: string) => Promise<SubjectMemoryNote[]>;
  /** Remove a memory by id. */
  remove: (id: string) => Promise<void>;
  /** When `add` is omitted, the reason adding is unavailable (shown inline). */
  addDisabledReason?: string;
  /** Placeholder for the add box (subject-flavored). */
  addPlaceholder?: string;
  /** Empty-state body copy. */
  emptyBody?: React.ReactNode;
  /** ADR 0063 — render the list with NO write controls (no add form, no per-note
   *  delete). For a non-writer viewing a subject they can read but not edit. */
  readOnly?: boolean;
}

export function MemoryBrowser({ list, add, remove, addDisabledReason, addPlaceholder, emptyBody, readOnly = false }: MemoryBrowserProps): JSX.Element {
  const { t } = useTranslation('memory');
  const [notes, setNotes] = useState<SubjectMemoryNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try { const n = await list(); if (mounted.current) setNotes(n); }
      catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : t('loadError')); }
    })();
    return () => { mounted.current = false; };
    // `list` is memoized by callers (useCallback), so this runs once per mount /
    // when the subject changes. `t` is stable in react-i18next (used only in the
    // error fallback) so it adds no extra runs.
  }, [list, t]);

  const refresh = async (): Promise<void> => {
    try { setNotes(await list()); } catch (e) { setError(e instanceof Error ? e.message : t('loadError')); }
  };

  const onAdd = async (): Promise<void> => {
    if (!add || !draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await add(draft.trim());
      if (mounted.current) { setNotes(next); setDraft(''); }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t('addError'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const onRemove = async (id: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await remove(id); await refresh(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : t('removeError')); }
    finally { if (mounted.current) setBusy(false); }
  };

  return (
    <div className="surface-card u-flex u-flex-col u-gap-3">
      {error ? <Notice variant="error">{error}</Notice> : null}

      {add && !readOnly ? (
        <form
          onSubmit={(e) => { e.preventDefault(); void onAdd(); }}
          className="u-flex u-flex-col u-gap-2"
        >
          <Field label={t('addLabel')}>
            {(w) => (
              <textarea
                {...w}
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={addPlaceholder ?? t('addPlaceholderDefault')}
                maxLength={4000}
              />
            )}
          </Field>
          <div className="action-bar u-justify-between">
            <span className="muted u-fs-12">{t('storedCount', { count: notes?.length ?? 0, n: formatNumber(notes?.length ?? 0) })}</span>
            <button type="submit" className="primary" disabled={!draft.trim() || busy}><PlusIcon size={14} /> {t('addMemory')}</button>
          </div>
        </form>
      ) : addDisabledReason ? (
        <Notice variant="info">{addDisabledReason}</Notice>
      ) : null}

      {notes === null ? (
        <StateCard icon={<SparklesIcon size={20} />} title={t('loadingTitle')} loading />
      ) : notes.length === 0 ? (
        <StateCard
          icon={<SparklesIcon size={20} />}
          title={t('emptyTitle')}
          body={emptyBody ?? t('emptyBodyDefault')}
        />
      ) : (
        <ul className="u-flex u-flex-col u-gap-2 u-m-0 u-p-0" style={{ listStyle: 'none' }}>
          {notes.map((nNote) => (
            <li key={nNote.id} className="surface-card u-flex u-flex-row u-gap-2 u-justify-between u-items-start">
              <div className="u-flex u-flex-col u-gap-1">
                <span className="u-fs-14">{nNote.content}</span>
                {nNote.contentTrust === 'untrusted' ? (
                  <span className="chip chip--warning u-fs-12" title={t('externalUnverifiedTitle')}>{t('externalUnverified')}</span>
                ) : null}
              </div>
              {readOnly ? null : (
                <button
                  type="button"
                  className="ghost"
                  aria-label={t('removeMemory')}
                  title={t('removeMemory')}
                  disabled={busy}
                  onClick={() => void onRemove(nNote.id)}
                >
                  <TrashIcon size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
