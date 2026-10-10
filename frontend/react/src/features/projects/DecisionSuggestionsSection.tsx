/**
 * ADR 0853 D1 — "Possible decisions" on the Ledger tab: what an automatic source
 * (the suggester, an inbound message, a resolved approval, meeting notes, a drift
 * finding) thinks MIGHT be a decision. Nothing here is a decision until a person
 * presses Record (the shared record dialog, prefilled and linked back to the
 * source) — or Dismiss, saying why. A drift finding can also be SENT BACK to the
 * person who started the run (ADR 0855 D2). Readers see the list; writers act on it.
 *
 * Renders nothing when there are none; a failed read is said.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { useLiveRegion } from '../../ui/announce.js';
import { formatRelativeTime } from '../../i18n/format.js';
import { RecordDecisionDialog } from '../../chat/decisions/useRecordDecision.js';
import { dismissDecisionSuggestion, listDecisionSuggestions, sendBackDriftSuggestion, type DecisionSuggestion } from './teamLedgerClient.js';

export function DecisionSuggestionsSection({ projectId, canWrite, isOwner, onRecorded }: {
  projectId: string; canWrite: boolean; isOwner: boolean; onRecorded: () => void;
}): JSX.Element | null {
  const { t } = useTranslation('projects');
  const [items, setItems] = useState<DecisionSuggestion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [recording, setRecording] = useState<DecisionSuggestion | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ id: string; mode: 'dismiss' | 'send-back' } | null>(null);
  const [note, setNote] = useState('');
  const [actionFailed, setActionFailed] = useLiveRegion();

  const refresh = useCallback(async () => {
    try { setItems(await listDecisionSuggestions(projectId)); setFailed(false); }
    catch { setFailed(true); }
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const open = (s: DecisionSuggestion, mode: 'dismiss' | 'send-back'): void => { setClosing({ id: s.suggestionId, mode }); setNote(''); setActionFailed(''); };
  const confirm = async (s: DecisionSuggestion, mode: 'dismiss' | 'send-back'): Promise<void> => {
    setBusy(s.suggestionId);
    setActionFailed('');
    try {
      if (mode === 'send-back') await sendBackDriftSuggestion(projectId, s.suggestionId, note.trim());
      else await dismissDecisionSuggestion(projectId, s.suggestionId, note.trim() || undefined);
      setClosing(null);
      await refresh();
    } catch { setActionFailed(mode === 'send-back' ? t('ledgerSuggestionSendBackFailed') : t('ledgerSuggestionDismissFailed')); }
    finally { setBusy(null); }
  };

  if (failed) return <section className="surface-card" aria-label={t('ledgerSuggestionsTitle')}><p className="muted u-fs-12" role="status">{t('ledgerSuggestionsFailed')}</p></section>;
  if (!items || items.length === 0) return null;
  return (
    <section className="surface-card" aria-labelledby="ledger-suggestions">
      <h2 id="ledger-suggestions" className="u-fs-14">{t('ledgerSuggestionsTitle', { count: items.length })}</h2>
      <p className="muted u-fs-12">{t('ledgerSuggestionsLede')}</p>
      <ul className="u-list-none u-p-0">
        {items.map((s) => (
          <li key={s.suggestionId} className="u-mb-3">
            <div className="u-fw-600">{s.title}</div>
            <div className="u-fs-13">{s.text}</div>
            <div className="muted u-fs-12">
              {t(`ledgerSuggestionFrom_${s.source.kind}`)} · {formatRelativeTime(s.createdAt)}
              {s.source.link ? <> · <a href={s.source.link}>{t('ledgerSuggestionSource')}</a></> : null}
            </div>
            {canWrite && closing?.id !== s.suggestionId ? (
              <div className="action-bar u-mt-1">
                <Button variant="accent-solid" size="sm" disabled={busy !== null} onClick={() => setRecording(s)}>{t('ledgerSuggestionRecord')}</Button>
                {s.source.kind === 'drift' ? <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => open(s, 'send-back')}>{t('ledgerSuggestionSendBack')}</Button> : null}
                <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => open(s, 'dismiss')}>{t('ledgerSuggestionDismiss')}</Button>
              </div>
            ) : null}
            {canWrite && closing?.id === s.suggestionId ? (
              <div className="u-mt-1">
                <label className="u-fs-12" htmlFor={`sugg-note-${s.suggestionId}`}>{closing.mode === 'send-back' ? t('ledgerSuggestionSendBackNote') : t('ledgerSuggestionDismissReason')}</label>
                <textarea id={`sugg-note-${s.suggestionId}`} className="input u-w-full" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                <p className="muted u-fs-12" role="status" aria-live="polite" aria-atomic="true">{actionFailed}</p>
                <div className="action-bar u-mt-1">
                  <Button variant="accent-solid" size="sm" disabled={busy !== null} onClick={() => void confirm(s, closing.mode)}>{closing.mode === 'send-back' ? t('ledgerSuggestionSendBack') : t('ledgerSuggestionDismiss')}</Button>
                  <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setClosing(null)}>{t('ledgerSuggestionCancel')}</Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {recording ? (
        <RecordDecisionDialog
          projectId={projectId}
          isOwner={isOwner}
          prefill={{ title: recording.title, text: recording.text }}
          source={recording.source}
          suggestionId={recording.suggestionId}
          onClose={() => setRecording(null)}
          onDone={() => { void refresh(); onRecorded(); }}
        />
      ) : null}
    </section>
  );
}
