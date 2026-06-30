/**
 * Agent Memory tab (ADR 0041) — the visible per-agent memory browser. Lists the
 * agent's curated memories (facts it recalls each turn) with add + delete, via
 * the shared `MemoryBrowser`. Adding requires the agent's `memoryWritable` opt-in
 * (the same knob the Knowledge tab exposes); when off, the tab offers to enable it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { MemoryBrowser } from '../../memory/MemoryBrowser.js';
import { Notice } from '../../ui/Notice.js';
import { getAgentKnowledge, listNotes, deleteNote, addNote, setMemoryWritable } from './agentKnowledgeClient.js';

export function AgentMemoryTab({ rosterId, persona }: { rosterId: string; persona: string }): JSX.Element {
  const { t } = useTranslation('agent-knowledge');
  const [writable, setWritable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWritable = useCallback(async () => {
    try { setWritable((await getAgentKnowledge(rosterId)).memoryWritable); }
    catch (e) { setError(e instanceof Error ? e.message : t('memoryFailedToLoadSettings')); }
  }, [rosterId, t]);

  useEffect(() => { void loadWritable(); }, [loadWritable]);

  const list = useCallback(() => listNotes(rosterId), [rosterId]);
  const remove = useCallback((id: string) => deleteNote(rosterId, id), [rosterId]);
  const add = useCallback(async (content: string) => {
    await addNote(rosterId, content);
    return listNotes(rosterId);
  }, [rosterId]);

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
            components={[<span key="0" />, <button key="1" type="button" className="btn-link" disabled={busy} onClick={() => void enable()} />]}
          />
        </Notice>
      ) : null}
      <MemoryBrowser
        list={list}
        remove={remove}
        {...(writable ? { add } : {})}
        addPlaceholder={t('memoryAddPlaceholder')}
        emptyBody={t('memoryEmptyBody', { persona })}
      />
    </div>
  );
}
