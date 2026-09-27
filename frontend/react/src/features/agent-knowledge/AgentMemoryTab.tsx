/**
 * Agent Memory tab (ADR 0041) — the visible per-agent memory browser. Lists the
 * agent's curated memories (facts it recalls each turn) with add + delete, via
 * the shared `MemoryBrowser`. Adding requires the agent's `memoryWritable` opt-in
 * (the same knob the Knowledge tab exposes); when off, the tab offers to enable it.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { MemoryBrowser } from '../../memory/MemoryBrowser.js';
import { Notice } from '../../ui/Notice.js';
import { getAgentKnowledge, listNotesWithRecall, deleteNote, addNote, setMemoryWritable } from './agentKnowledgeClient.js';

export function AgentMemoryTab({ rosterId, persona }: { rosterId: string; persona: string }): JSX.Element {
  const { t } = useTranslation('agent-knowledge');
  const [writable, setWritable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** MEM-UX-1 — rows the agent recalls that the list below does not show.
   *  `undefined` while unknown (or if the read failed), so the browser stays
   *  SILENT rather than implying zero. */
  const [recallOnly, setRecallOnly] = useState<number | undefined>(undefined);

  const loadWritable = useCallback(async () => {
    try { setWritable((await getAgentKnowledge(rosterId)).memoryWritable); }
    catch (e) { setError(e instanceof Error ? e.message : t('memoryFailedToLoadSettings')); }
  }, [rosterId, t]);

  useEffect(() => { void loadWritable(); }, [loadWritable]);

  /**
   * ONE request for both halves (review finding F5). A second effect used to
   * re-fetch this exact URL purely for `recallOnlyCount`, which the list response
   * already carries — doubling the request count on this tab, re-running a full
   * memory scan server-side, and allowing the disclosed count to describe a
   * DIFFERENT read than the list on screen.
   *
   * Recording the count here rather than in its own effect also keeps it correct
   * across `MemoryBrowser`'s own `refresh()` after an add or delete, which the
   * mount-once effect never did. A read failure surfaces through the browser's
   * own error state; `recallOnly` simply stays `undefined`, so the disclosure
   * says nothing rather than implying zero.
   */
  const list = useCallback(async () => {
    const { notes, recallOnlyCount } = await listNotesWithRecall(rosterId);
    setRecallOnly(recallOnlyCount);
    return notes;
  }, [rosterId]);
  const remove = useCallback((id: string) => deleteNote(rosterId, id), [rosterId]);
  // Re-reads through `list` rather than `listNotes` so the disclosure count is
  // refreshed by the same response that produced the new list — otherwise adding
  // a note leaves a count read at mount describing a list that has since changed.
  const add = useCallback(async (content: string) => {
    await addNote(rosterId, content);
    return list();
  }, [rosterId, list]);

  const enable = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try { await setMemoryWritable(rosterId, true); setWritable(true); }
    catch (e) { setError(e instanceof Error ? e.message : t('memoryFailedToEnable')); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <p className="muted u-fs-13 u-m-0">
        {t('memoryIntro', { persona })}
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {writable === false ? (
        <Notice variant="info">
          <Trans
            t={t}
            i18nKey="memoryCuratedOff"
            components={[<span key="0" />, <Button key="1" variant="link" disabled={busy} onClick={() => void enable()} />]}
          />
        </Notice>
      ) : null}
      <MemoryBrowser
        list={list}
        remove={remove}
        {...(writable ? { add } : {})}
        addPlaceholder={t('memoryAddPlaceholder')}
        emptyBody={t('memoryEmptyBody', { persona })}
        {...(recallOnly !== undefined ? { recallOnlyCount: recallOnly } : {})}
      />
    </div>
  );
}
