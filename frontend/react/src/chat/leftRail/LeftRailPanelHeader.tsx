import { Button } from '../../ui/Button.js';
import type { ReactNode } from 'react';
import { XIcon } from '../../ui/icons/index.js';

/**
 * The ONE header for every left-rail panel (Conversations / Workflow / Reviews).
 * Each panel used to hand-roll its own header — or, for Reviews, none — so the
 * three tabs looked different and Reviews had no title or close control. This
 * gives them one shape: a title (the panel's `aria-labelledby` target), an
 * optional panel-specific actions slot, and a consistent close button.
 */
export function LeftRailPanelHeader({ titleId, title, onClose, closeLabel, actions }: {
  /** Element id the panel's `aria-labelledby` points at. */
  titleId: string;
  title: string;
  onClose: () => void;
  closeLabel: string;
  /** Panel-specific controls (e.g. the Conversations "Workspace" toggle),
   *  rendered between the title and the close button. */
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="leftrail-panel-head">
      <strong id={titleId} className="u-flex-1 u-fs-13">{title}</strong>
      {actions}
      <Button
        variant="secondary" className="sesshist-mini-btn"
        onClick={onClose}
        aria-label={closeLabel}
      >
        <XIcon size={14} />
      </Button>
    </header>
  );
}
