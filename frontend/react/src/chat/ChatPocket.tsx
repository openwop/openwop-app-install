/**
 * ChatPocket — ADR 0768 P5, the "Pocket" density: a launcher pill that opens
 * the ONE embedded chat as a compact popover OVER a feature surface, so the
 * user keeps looking at their data while they ask about it.
 *
 * It is chrome only. The conversation is the shared <EmbeddedChatPanel>
 * (BYOK gate, agent scoping, ephemeral session, "Continue in full chat" — all
 * inherited), rendered at `density="pocket"`. No second chat.
 *
 * A NON-modal dialog: the page behind stays usable (that is the point). Esc
 * closes and returns focus to the launcher; opening moves focus into the
 * panel. Mod+J toggles it while the pocket is mounted.
 *
 * Import rule (CLAUDE.md): a feature that chat/ does not import back may
 * static-import this; the builder (and anything chat/ imports) must lazy-import.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { XIcon } from '../ui/icons/index.js';
import { EmbeddedChatPanel } from './EmbeddedChatPanel.js';

interface Props {
  agentId: string;
  /** The pocket's heading and the launcher's label (e.g. "Store Assistant"). */
  title: string;
  /** Launcher avatar letter; defaults to the title's first letter. */
  initial?: string;
  /** What the agent can see — forwarded to the panel's context strip. */
  contextLabel?: ReactNode;
  renderEmptyState?: (onPick: (text: string) => void) => ReactNode;
  /** Open on mount (e.g. an old `?tab=assistant` deep link). */
  defaultOpen?: boolean;
  onTurnSettled?: () => void;
}

export function ChatPocket({ agentId, title, initial, contextLabel, renderEmptyState, defaultOpen = false, onTurnSettled }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(defaultOpen);
  // Mounted once opened, then kept (hidden) so closing never discards the thread.
  const [everOpened, setEverOpened] = useState(defaultOpen);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const headingId = useId();

  const show = useCallback(() => { setEverOpened(true); setOpen(true); }, []);
  // Focus returns to the launcher AFTER the close renders (it is hidden while open).
  const returnFocus = useRef(false);
  const hide = useCallback(() => { returnFocus.current = true; setOpen(false); }, []);
  useEffect(() => {
    if (!open && returnFocus.current) { returnFocus.current = false; launcherRef.current?.focus(); }
  }, [open]);

  // Mod+J toggles. Scoped to this pocket's lifetime (unmounts with the page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (open) hide(); else show();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, show, hide]);

  // Move focus into the panel on open — to the composer when it is there.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const target = panel?.querySelector<HTMLElement>('textarea, [role="combobox"]') ?? panel;
    target?.focus({ preventScroll: true });
  }, [open]);

  // Esc closes — unless a picker inside handled it first (they stopPropagation /
  // preventDefault). A native listener on the dialog: the dialog container is
  // not itself an interactive control, so no React handler rides it.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); hide(); }
    };
    panel.addEventListener('keydown', onKey);
    return () => panel.removeEventListener('keydown', onKey);
  }, [open, hide]);

  return (
    <>
      {everOpened ? (
        <section
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          tabIndex={-1}
          hidden={!open}
          className="chat-pocket"
        >
          <header className="chat-pocket__head">
            <span className="chat-pocket__avatar" aria-hidden="true">{(initial ?? title.charAt(0)).toUpperCase()}</span>
            <h2 id={headingId} className="chat-pocket__title">{title}</h2>
            <Button variant="quiet" size="sm" className="chat-pocket__close" onClick={hide} aria-label={t('pocketClose', { name: title })}>
              <XIcon size={14} />
            </Button>
          </header>
          <div className="chat-pocket__body">
            <EmbeddedChatPanel
              agentId={agentId}
              density="pocket"
              {...(contextLabel !== undefined ? { contextLabel } : {})}
              {...(renderEmptyState ? { renderEmptyState } : {})}
              {...(onTurnSettled ? { onTurnSettled } : {})}
            />
          </div>
        </section>
      ) : null}
      {(
        <Button
          ref={launcherRef}
          variant="quiet"
          className="chat-pocket-launcher"
          onClick={show}
          aria-keyshortcuts="Control+J Meta+J"
          aria-expanded={open}
          hidden={open}
        >
          <span className="chat-pocket__avatar" aria-hidden="true">{(initial ?? title.charAt(0)).toUpperCase()}</span>
          <span>{t('pocketAsk', { name: title })}</span>
          <kbd className="chat-pocket-launcher__kbd" aria-hidden="true">⌘J</kbd>
        </Button>
      )}
    </>
  );
}
