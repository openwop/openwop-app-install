/**
 * Reading-progress bar for long-form public posts (UX_UPGRADE-site R3-G1 — the
 * "premium Ghost theme market" catalog row's reader-experience baseline).
 *
 * DECORATIVE by design: `aria-hidden` on the whole element. A percentage bar
 * duplicates what a screen-reader user already gets from the document scroll
 * position, and announcing a live-updating percentage on every scroll frame is
 * noise, not information.
 *
 * Motion posture: the bar's width IS the scroll position — state, not
 * animation — so there is deliberately NO transition on it. That makes it
 * `prefers-reduced-motion`-safe without a media query: nothing animates that
 * the user did not directly cause, which is the reduced-motion contract.
 *
 * Measurement rides ONE passive scroll/resize listener behind a rAF gate (at
 * most one style write per frame). Progress = how far the viewport BOTTOM has
 * advanced through the article's extent, so it reaches 100% when the END of
 * the post is visible — not when its top scrolls past — matching what a reader
 * means by "finished".
 */
import { useEffect, useRef } from 'react';

export function ReadingProgress({ targetRef }: { targetRef: React.RefObject<HTMLElement | null> }): JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    // grade-code R3 — resolved ONCE per mount, not per frame: the header is
    // part of the shell chrome and outlives the article; querying it inside
    // the rAF handler was a per-scroll-frame DOM search for a static answer.
    const header = document.querySelector('.public-shell-header');
    const update = (): void => {
      raf = 0;
      const el = targetRef.current;
      const bar = barRef.current;
      if (!el || !bar) return;
      const rect = el.getBoundingClientRect();
      const viewport = window.innerHeight;
      // Distance the viewport bottom has travelled into the article, over the
      // article's full height. Clamped: before the article → 0, past it → 1.
      const advanced = viewport - rect.top;
      const p = rect.height > 0 ? Math.min(1, Math.max(0, advanced / rect.height)) : 0;
      bar.style.transform = `scaleX(${p})`;
      // grade-ux R3 — the PublicShell header is STICKY at top:0 (z-index 20),
      // so a viewport-top bar would paint OVER its top edge. Sit at the
      // header's bottom edge instead, measured in the same rAF pass (the
      // header is translucent-blurred, so hiding beneath it is not an option
      // either). No header — a white-label shell without one — ⇒ top: 0.
      const top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
      const wrap = bar.parentElement;
      if (wrap) wrap.style.top = `${top}px`;
    };
    const schedule = (): void => { if (!raf) raf = requestAnimationFrame(update); };
    schedule(); // initial paint (a mid-page cold load starts part-read)
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [targetRef]);

  return (
    <div className="fp-post__progress" aria-hidden="true" data-testid="reading-progress">
      <div ref={barRef} className="fp-post__progress-bar" />
    </div>
  );
}
