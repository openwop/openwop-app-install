/**
 * MemoryBrowser (ADR 0041) — ONE memory-browser component for every subject.
 *
 * A subject's curated memories (facts/notes) rendered as a list with add + delete.
 * Subject-agnostic: it takes `list`/`add`/`remove` callbacks, so the SAME UI
 * serves an agent's memory (Agent workspace → Memory tab) and a human's personal
 * memory (My Profile → Memory tab) — the visible counterpart of the one backend
 * seam. Trusted/untrusted chips mirror the per-agent Knowledge panel (ADR 0038 §C).
 *
 * PROVENANCE (MEM-UX-3 / ADR 0587 §1). Each row shows WHERE it came from and WHEN.
 * Before this, an auto-extracted model belief was stored `contentTrust:'trusted'`
 * and marked only by an English `[auto-extracted] ` prefix glued into the CONTENT
 * — so the "External · unverified" chip below was unreachable by construction, a
 * model's guess about you rendered byte-identical to a fact you typed, and the
 * marker could not be translated because it was content, not copy. `source` is now
 * a field, the chip is reachable, and `createdAt` (fetched all along and dropped
 * on the floor) is rendered.
 *
 * SCOPE HONESTY (MEM-UX-1). This list is the CURATED-NOTE store. The agent's
 * recall port reads the WHOLE scope, into which every completed turn also writes a
 * summary — so a memory can shape a reply without appearing here. `recallOnlyCount`
 * discloses how many such rows exist rather than letting the list imply it is
 * everything. Projecting them as first-class, deletable rows is the full fix and is
 * NOT done here (see ADR 0587 § Open questions).
 *
 * `ui/` cohesion: StateCard / Field / chip / Notice / icons; tokens only.
 */

import { Button } from '../ui/Button.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../i18n/format.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Field } from '../ui/Field.js';
import { SparklesIcon, PlusIcon, TrashIcon } from '../ui/icons/index.js';
import { confirm } from '../ui/confirm.js';

/** Localized short date for a memory's `createdAt`. Falls back to the raw ISO
 *  string rather than rendering "Invalid Date" if the value is unparseable. */
function formatMemoryDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

export interface SubjectMemoryNote {
  id: string;
  content: string;
  contentTrust: 'trusted' | 'untrusted';
  /** Provenance (ADR 0587). `'auto-extract'` = an LLM inferred it from a
   *  conversation; absent on rows that predate the field ⇒ treated as `'user'`. */
  source?: 'user' | 'auto-extract';
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
  /**
   * MEM-UX-1 — how many rows exist in this subject's RECALL scope that are not
   * curated notes and therefore are not in `list()` (turn summaries the dispatcher
   * writes). Rendered as a disclosure so the list cannot imply it is the whole of
   * what the subject remembers. Omit when the caller cannot determine it — the
   * component then says nothing rather than implying zero.
   */
  recallOnlyCount?: number;
}

export function MemoryBrowser({ list, add, remove, addDisabledReason, addPlaceholder, emptyBody, readOnly = false, recallOnlyCount }: MemoryBrowserProps): JSX.Element {
  const { t, i18n } = useTranslation('memory');
  const [notes, setNotes] = useState<SubjectMemoryNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * MEM-G1 — the read FAILED, as distinct from `notes === null` meaning "still
   * loading". They were the same value, so a failed read left the list showing a
   * loading StateCard FOREVER while the counter beside the composer said
   * "0 stored" — a page simultaneously loading, empty, and errored.
   */
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try { const n = await list(); if (mounted.current) { setNotes(n); setFailed(false); } }
      catch (e) { if (mounted.current) { setFailed(true); setError(e instanceof Error ? e.message : t('loadError')); } }
    })();
    return () => { mounted.current = false; };
    // `list` is memoized by callers (useCallback), so this runs once per mount /
    // when the subject changes. `t` is stable in react-i18next (used only in the
    // error fallback) so it adds no extra runs.
  }, [list, t]);

  const refresh = async (): Promise<void> => {
    try { setNotes(await list()); setFailed(false); setError(null); } catch (e) { setFailed(true); setError(e instanceof Error ? e.message : t('loadError')); }
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
            <span className="muted u-fs-12">{notes === null
              ? t('storedUnknown')
              : t('storedCount', { count: notes.length, n: formatNumber(notes.length) })}</span>
            <Button variant="primary" type="submit" disabled={!draft.trim() || busy}><PlusIcon size={14} /> {t('addMemory')}</Button>
          </div>
        </form>
      ) : addDisabledReason ? (
        <Notice variant="info">{addDisabledReason}</Notice>
      ) : null}

      {recallOnlyCount !== undefined && recallOnlyCount > 0 ? (
        <Notice variant="info">{t('recallOnlyDisclosure', { count: recallOnlyCount, n: formatNumber(recallOnlyCount) })}</Notice>
      ) : null}

      {notes === null && failed ? (
        <StateCard announce
          icon={<SparklesIcon size={20} />}
          title={t('loadFailedTitle')}
          body={t('loadFailedBody')}
          // TWIN-UX-16 / MEM-UX-6 — disabled during its own fetch, like the
          // AgentTwinPanel retry. `refresh` never throws (it catches inside).
          action={<Button variant="secondary" size="sm" disabled={busy} onClick={() => { setBusy(true); void refresh().finally(() => setBusy(false)); }}>{t('retry')}</Button>}
        />
      ) : notes === null ? (
        <StateCard icon={<SparklesIcon size={20} />} title={t('loadingTitle')} loading />
      ) : notes.length === 0 ? (
        <StateCard
          icon={<SparklesIcon size={20} />}
          title={t('emptyTitle')}
          body={emptyBody ?? t('emptyBodyDefault')}
        />
      ) : (
        <ul className="u-flex u-flex-col u-gap-2 u-m-0 u-p-0 u-list-none">
          {notes.map((nNote) => (
            <li key={nNote.id} className="surface-card u-flex u-flex-row u-gap-2 u-justify-between u-items-start">
              <div className="u-flex u-flex-col u-gap-1">
                <span className="u-fs-14">{nNote.content}</span>
                <span className="u-flex u-flex-row u-gap-1 u-items-center u-flex-wrap">
                  {/* TWIN-UX-9 — `chip--info` was UNDEFINED: this was its only use in the
                      repo, and the defined modifiers are accent, ai, danger, muted, pulse,
                      success and warning. It fell back to bare `.chip`, i.e.
                      pixel-identical to the `chip--muted` used for "no scopes" — so of the
                      two provenance signals ADR 0587 shipped to be visually PARALLEL, the
                      one flagging "a model guessed this about you" was the one that lost
                      its colour. `chip--ai` is DESIGN.md §5.3's model-provenance token.
                      Invisible to the build gate by design: `check-classnames.mjs`
                      restricts its token regex to utility classes and sr-only. */}
                  {nNote.source === 'auto-extract' ? (
                    <span className="chip chip--ai u-fs-12" title={t('autoLearnedTitle')}>{t('autoLearned')}</span>
                  ) : null}
                  {nNote.contentTrust === 'untrusted' ? (
                    <span className="chip chip--warning u-fs-12" title={t('externalUnverifiedTitle')}>{t('externalUnverified')}</span>
                  ) : null}
                  <span className="muted u-fs-12">{t('learnedOn', { date: formatMemoryDate(nNote.createdAt, i18n.language) })}</span>
                </span>
              </div>
              {readOnly ? null : (
                <Button
                  variant="quiet"
                  aria-label={t('removeMemory')}
                  title={t('removeMemory')}
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      if (await confirm({ title: t('removeMemory'), body: t('removeMemoryConfirmBody'), danger: true })) await onRemove(nNote.id);
                    })();
                  }}
                >
                  <TrashIcon size={14} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
