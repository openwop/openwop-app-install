/**
 * ADR 0132 Phase 5 — the per-conversation tool-scope ENTRY (the chat-header button).
 *
 * `CapabilityScopeButton` self-gates on the `conversation-tools` feature (renders
 * nothing when off) and owns the modal, so it drops into the chat header without
 * threading callbacks. The heavier modal body is LAZY-loaded on first open
 * (`CapabilityScopeModal`) so only this small button is in the entry chunk
 * (bundle-budget; the EmbeddedChatPanel lazy precedent).
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 */
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsIcon } from '../ui/icons/index.js';

const CapabilityScopeModal = lazy(() => import('./CapabilityScopeModal.js'));

// conversation-tools is always-on (toggle removed); the button always renders.
// Rendered as a settings affordance in the composer toolbar next to the web/tools
// message-modifiers — it scopes the tools available to the next message.
export function CapabilityScopeButton({ sessionId }: { sessionId: string }): JSX.Element {
  const { t } = useTranslation('conversationTools');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="composer-modifier"
        onClick={() => setOpen(true)}
        aria-label={t('openTitle')}
        title={t('openTitle')}
      >
        <SettingsIcon size={13} />
      </button>
      {open && (
        <Suspense fallback={null}>
          <CapabilityScopeModal sessionId={sessionId} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
