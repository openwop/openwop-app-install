/**
 * NeedsYouTray — ADR 0768 P1 ("what needs you never scrolls away").
 *
 * A compact bar pinned above the composer while any interrupt in the thread is
 * open. It is a POINTER, not a second resolver: the actionable card stays the
 * inline `InterruptCardStack` card (one resolve path, one focus-handoff), and
 * "Review" scrolls to it and moves focus there. The bar hides itself while
 * every open card is already on screen, so it never duplicates what the user
 * can see. Without IntersectionObserver (jsdom, very old engines) it stays
 * visible — the fail-safe direction for an approval prompt.
 *
 * Scope: the tray is rendered as a sibling of `MessageFeed` inside the same
 * conversation column, so its `parentElement` is the search scope for cards.
 * That keeps two keep-alive tabs (ADR 0140) from ever reaching into each other.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import type { ChatMessage } from './types.js';
import { collectOpenInterrupts, type OpenInterruptEntry } from './lib/openInterrupts.js';

const CARD_ATTR = 'data-interrupt-id';

function cardsIn(scope: Element | null | undefined): HTMLElement[] {
  if (!scope) return [];
  return Array.from(scope.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`));
}

export function NeedsYouTray({ messages }: { messages: readonly ChatMessage[] }): JSX.Element | null {
  const { t } = useTranslation('chat');
  const entries = useMemo(() => collectOpenInterrupts(messages), [messages]);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(() => new Set());
  const idsKey = entries.map((e) => e.interruptId).join('|');

  useEffect(() => {
    setOnScreen(new Set());
    if (!idsKey || typeof IntersectionObserver === 'undefined') return undefined;
    const scope = anchorRef.current?.parentElement;
    const seen = new Set<string>();
    const io = new IntersectionObserver((records) => {
      for (const r of records) {
        const id = r.target.getAttribute(CARD_ATTR);
        if (!id) continue;
        if (r.isIntersecting) seen.add(id); else seen.delete(id);
      }
      setOnScreen(new Set(seen));
    });
    for (const el of cardsIn(scope)) io.observe(el);
    return () => io.disconnect();
  }, [idsKey]);

  if (entries.length === 0) return null;

  const offScreen = entries.filter((e) => !onScreen.has(e.interruptId));
  const target: OpenInterruptEntry | undefined = offScreen[0];

  function review(entry: OpenInterruptEntry): void {
    const card = cardsIn(anchorRef.current?.parentElement).find((el) => el.getAttribute(CARD_ATTR) === entry.interruptId);
    if (!card) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    card.focus({ preventScroll: true });
  }

  return (
    <div ref={anchorRef} className="cv-spine needs-you-anchor">
      {target ? (
        <section className="needs-you-tray" aria-label={t('needsYouRegion')}>
          <div className="needs-you-body">
            <span className="needs-you-eyebrow">{t('needsYouEyebrow', { count: entries.length })}</span>
            <span className="needs-you-title u-truncate">{target.gateName}</span>
            {target.workflowName ? <span className="needs-you-sub u-truncate">{target.workflowName}</span> : null}
          </div>
          {offScreen.length > 1 ? (
            <span className="needs-you-more">{t('needsYouMore', { count: offScreen.length - 1 })}</span>
          ) : null}
          <Button variant="accent-solid" size="sm" className="needs-you-review" onClick={() => review(target)}>
            {t('needsYouReview')}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
