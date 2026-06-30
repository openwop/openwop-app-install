/**
 * ADR 0136 Phase 5 — the chat-header Intent Ledger button + lazy modal. Only this small
 * button lives in the entry chunk; the heavier modal (`IntentLedgerModal`) is fetched on
 * first open (the CapabilityScopeButton lazy precedent). ALWAYS-ON (toggle removed,
 * 2026-06-24) — the button always renders; it's a no-op until a user drafts a mission.
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlagIcon } from '../ui/icons/index.js';

const IntentLedgerModal = lazy(() => import('./IntentLedgerModal.js'));

export function IntentLedgerButton({ sessionId, lastUserMessage }: { sessionId: string; lastUserMessage?: string }): JSX.Element {
  const { t } = useTranslation('intentLedger');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary u-fs-11" onClick={() => setOpen(true)} aria-label={t('button', { defaultValue: 'Mission' })} title={t('title', { defaultValue: 'Mission contract' })}>
        <FlagIcon size={14} /> {t('button', { defaultValue: 'Mission' })}
      </button>
      {open && (
        <Suspense fallback={null}>
          <IntentLedgerModal sessionId={sessionId} onClose={() => setOpen(false)} {...(lastUserMessage ? { lastUserMessage } : {})} />
        </Suspense>
      )}
    </>
  );
}
