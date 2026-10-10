/**
 * ADR 0132 Phase 5 + ADR 0834 D6 — the per-conversation tool control in the composer
 * row: the scope/approvals button, which ALSO says when the agent is waiting on you.
 *
 * In `safe` mode the agent's tool loop HOLDS a sensitive call and records it in the
 * conversation's approval ledger; the model is told it is awaiting approval. ADR 0150
 * said "the existing `interrupt.approval` card" would show it — no such card exists for
 * chat tool calls, and the only place to approve was this button as a bare gear icon
 * with no pending indicator. It now reads the ledger after every completed agent turn
 * (`refreshKey` — the reply text is model output and cannot be trusted to announce a
 * hold) and, while something is pending, carries the count in words and the warning
 * style. The dialog shows each held call's arguments and what an approval covers.
 *
 * It also reports what this viewer may do (ADR 0834 D3), so the composer stops offering
 * a bypass the server would ignore.
 *
 * Default-exported and LAZY-loaded by the composer hook, together with the client it
 * needs — the entry chunk has no room for either (it used to hold this button statically).
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertIcon, SettingsIcon } from '../ui/icons/index.js';
import { getCapabilityScope, type CapabilityScopeView } from './capabilityScopeClient.js';

const CapabilityScopeModal = lazy(() => import('./CapabilityScopeModal.js'));

export interface ConversationToolsControlProps {
  sessionId: string;
  /** Changes after each completed turn — triggers a re-read. */
  refreshKey: number;
  onViewer?: (viewer: { mayApprove: boolean; mayBypass: boolean }) => void;
  onContinue?: (text: string) => void;
}

export default function ConversationToolsControl({ sessionId, refreshKey, onViewer, onContinue }: ConversationToolsControlProps): JSX.Element {
  const { t } = useTranslation('conversationTools');
  const [view, setView] = useState<CapabilityScopeView | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await getCapabilityScope(sessionId);
      setView(v);
      if (v.viewer) onViewer?.(v.viewer);
    } catch { setView(null); /* a not-yet-persisted chat 404s — nothing is pending there */ }
  }, [sessionId, onViewer]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const pending = (view?.approvals ?? []).filter((a) => a.status === 'pending').length;
  const label = pending > 0 ? t('pendingChip', { count: pending }) : t('openTitle');
  return (
    <>
      <button
        type="button"
        className={pending > 0 ? 'composer-modifier is-pending' : 'composer-modifier'}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        // The chip says what it is ("Tool access") instead of a bare gear; the
        // accessible name STARTS with that visible text (WCAG 2.5.3).
        aria-label={pending > 0 ? `${label} — ${t('pendingChipAria')}` : `${t('chipLabel')} — ${label}`}
        title={label}
        data-testid="conversation-tools-control"
      >
        {pending > 0 ? <><AlertIcon size={13} /> {label}</> : <><SettingsIcon size={13} /> {t('chipLabel')}</>}
      </button>
      {open && (
        <Suspense fallback={null}>
          <CapabilityScopeModal
            sessionId={sessionId}
            onClose={() => { setOpen(false); void load(); }}
            onChanged={() => { void load(); }}
            {...(onContinue ? { onContinue } : {})}
          />
        </Suspense>
      )}
    </>
  );
}
