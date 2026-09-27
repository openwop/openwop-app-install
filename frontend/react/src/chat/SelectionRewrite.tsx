/**
 * Selection-scoped rewrite affordance (ADR 0565 Phase 1).
 *
 * Select a span inside a COMPLETED assistant message → a small floating
 * toolbar (Rewrite / Shorter / Longer) appears above the selection. A verb
 * composes a NEW user turn — the selected span as a blockquote plus a
 * localized instruction — into the already-mounted composer via the
 * `composerSeed` live lane. Nothing is modified in place: the reply is an
 * ordinary new assistant turn, so RFC 0005 §195's append-only turn log and
 * replay/fork safety are untouched, and the model sees exactly what the
 * user sees (no hidden scaffolding).
 *
 * Desktop-first by decision: hidden while `(pointer: coarse)` matches —
 * the touch affordance ships only after a live verify (selection handles
 * and this toolbar fight for the same space on touch).
 */
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery } from '../ui/useMediaQuery.js';
import { seedLiveComposer } from './composerSeed.js';

interface Anchor {
  top: number;
  left: number;
  text: string;
}

/** The completed-assistant bubble containing `node`, or null. */
function assistantBoxOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node instanceof Element ? node : node.parentElement;
  const box = el?.closest<HTMLElement>('.msgbubble-box[data-role="assistant"]') ?? null;
  // Streaming bubbles are excluded — quoting a half-written span invites a
  // rewrite of text that is about to change under the user.
  if (box?.dataset.streaming === 'true') return null;
  return box;
}

const VERBS = [
  { labelKey: 'selRewrite', instructionKey: 'selRewriteInstruction' },
  { labelKey: 'selShorter', instructionKey: 'selShorterInstruction' },
  { labelKey: 'selLonger', instructionKey: 'selLongerInstruction' },
] as const;

export function SelectionRewriteOverlay({ containerRef }: {
  /** The feed root — selections outside it (other panes, the composer) never anchor the toolbar. */
  containerRef: RefObject<HTMLElement | null>;
}): JSX.Element | null {
  const { t } = useTranslation('chat');
  const coarsePointer = useMediaQuery('(pointer: coarse)');
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    if (coarsePointer) return undefined;
    const compute = (): void => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setAnchor(null); return; }
      const text = sel.toString().trim();
      if (!text) { setAnchor(null); return; }
      const range = sel.getRangeAt(0);
      // Both endpoints must sit inside the SAME completed assistant bubble,
      // and that bubble inside this feed — a cross-bubble or user-bubble
      // selection gets no affordance.
      const box = assistantBoxOf(range.startContainer);
      if (!box || box !== assistantBoxOf(range.endContainer)) { setAnchor(null); return; }
      if (!containerRef.current?.contains(box)) { setAnchor(null); return; }
      // jsdom's Range ships no getBoundingClientRect (the useMediaQuery
      // precedent) — anchor at the viewport origin there; browsers always
      // have it.
      const rect = typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : { top: 0, left: 0, width: 0 };
      setAnchor({ top: rect.top, left: rect.left + rect.width / 2, text });
    };
    document.addEventListener('selectionchange', compute);
    // Reposition (fixed coords go stale) as the feed or page scrolls/resizes.
    document.addEventListener('scroll', compute, { capture: true, passive: true });
    window.addEventListener('resize', compute);
    return () => {
      document.removeEventListener('selectionchange', compute);
      document.removeEventListener('scroll', compute, { capture: true });
      window.removeEventListener('resize', compute);
    };
  }, [coarsePointer, containerRef]);

  if (coarsePointer || !anchor) return null;

  const apply = (instructionKey: string): void => {
    const quoted = anchor.text.split('\n').map((line) => `> ${line}`).join('\n');
    seedLiveComposer(`${quoted}\n\n${t(instructionKey)}`);
    document.getSelection()?.removeAllRanges();
    setAnchor(null);
  };

  return (
    <div
      role="toolbar"
      aria-label={t('selRewriteToolbarAria')}
      className="chat-selrewrite"
      style={{ top: Math.max(8, anchor.top - 40), left: anchor.left }}
      // Keep the selection alive: a mousedown on the toolbar must not
      // collapse it (which would hide the toolbar before click fires).
      onMouseDown={(e) => e.preventDefault()}
    >
      {VERBS.map((v) => (
        <button key={v.labelKey} type="button" className="msgbubble-action-btn" onClick={() => apply(v.instructionKey)}>
          {t(v.labelKey)}
        </button>
      ))}
    </div>
  );
}
