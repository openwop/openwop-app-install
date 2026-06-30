/**
 * ADR 0133 Phase 4 — the task-deck ENTRY (the chat-header button).
 *
 * `TaskDeckButton` self-gates on the `task-deck` feature (renders nothing when off)
 * and LAZY-loads the modal body so only this small button is in the entry chunk
 * (bundle-budget; the 0132-P5 lazy precedent).
 *
 * @see docs/adr/0133-run-task-deck.md
 */
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ColumnsIcon } from '../ui/icons/index.js';

const TaskDeckModal = lazy(() => import('./TaskDeckModal.js'));

// task-deck is always-on (toggle removed); the button always renders.
export function TaskDeckButton({ conversationRunId }: { conversationRunId?: string }): JSX.Element {
  const { t } = useTranslation('taskDeck');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary u-fs-11" onClick={() => setOpen(true)} aria-label={t('openTitle')} title={t('openTitle')}>
        <ColumnsIcon size={14} /> {t('button')}
      </button>
      {open && (
        <Suspense fallback={null}>
          <TaskDeckModal {...(conversationRunId ? { conversationRunId } : {})} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
