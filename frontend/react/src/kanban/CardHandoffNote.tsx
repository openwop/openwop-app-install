/**
 * CardHandoffNote — ADR 0829 P4. The handoff note on a kanban card, behind a
 * small disclosure so a compact card stays compact. Renders through the shared
 * `HandoffNoteCard` (plain text; the note is untrusted) and renders nothing for
 * a card without a readable note.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { MessageSquareIcon } from '../ui/icons/index.js';
import { HANDOFF_KEY, readHandoffNote } from '../runs/handoffNote.js';
import { HandoffNoteCard } from '../runs/HandoffNoteCard.js';

export function CardHandoffNote({ handoff }: { handoff: unknown }): JSX.Element | null {
  const { t } = useTranslation('kanban');
  const [open, setOpen] = useState(false);
  const id = useId();
  const note = readHandoffNote({ [HANDOFF_KEY]: handoff });
  if (!note) return null;
  return (
    <div className="u-mt-1" onPointerDown={(e) => e.stopPropagation()}>
      <Button
        variant="quiet"
        size="sm"
        className="u-iflex u-items-center u-gap-1"
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <MessageSquareIcon size={12} /> {t(open ? 'handoffNoteHide' : 'handoffNoteShowCard')}
      </Button>
      {open ? <HandoffNoteCard id={id} note={note} title={t('handoffNoteCardTitle')} headingLevel={3} variant="inline" /> : null}
    </div>
  );
}
