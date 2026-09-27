/**
 * LazyMount (ADR 0375 Phase 2) — the fan-out guard. A dashboard composes N
 * independent feature reads; mounting all of them at once would fire N client
 * requests on load and risk the per-IP read budget (`middleware/rateLimit.ts`).
 * A tile's data-fetching body renders only once it scrolls near the viewport, so
 * a long dashboard loads incrementally. Tiles above the fold mount immediately.
 * `IntersectionObserver`-absent environments (jsdom/SSR) mount eagerly.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function LazyMount({ children, placeholder }: { children: ReactNode; placeholder: ReactNode }): JSX.Element {
  const [shown, setShown] = useState(() => typeof IntersectionObserver === 'undefined');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shown || typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShown(true); obs.disconnect(); }
    }, { rootMargin: '200px' }); // pre-load just before it scrolls in
    obs.observe(el);
    return () => obs.disconnect();
  }, [shown]);

  return <div ref={ref} className="dash-tile__mount">{shown ? children : placeholder}</div>;
}
