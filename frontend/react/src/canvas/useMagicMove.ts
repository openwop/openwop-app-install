/**
 * ADR 0328 Phase 5 — the Magic Move player: FLIP-animate elements whose
 * `data-mm` content key survives a frame change (position/size glide), fade
 * the unmatched in. Runs ONLY when the incoming frame's transition is
 * 'magic' and the viewer has no reduced-motion preference — otherwise it
 * just records geometry so the next magic entry has a baseline.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from '../ui/motion.js';

const DURATION_MS = 350;
const EASE = 'cubic-bezier(0.2, 0, 0.2, 1)';

export function useMagicMove(stageRef: RefObject<HTMLElement | null>, frameKey: number, kind: string | undefined): void {
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  const lastKey = useRef(frameKey);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const els = Array.from(stage.querySelectorAll('[data-mm]'));
    const frameChanged = lastKey.current !== frameKey;
    lastKey.current = frameKey;

    const reduce = prefersReducedMotion();
    if (frameChanged && kind === 'magic' && !reduce && typeof (Element.prototype as { animate?: unknown }).animate === 'function') {
      for (const el of els) {
        const key = el.getAttribute('data-mm') ?? '';
        const prev = prevRects.current.get(key);
        const now = el.getBoundingClientRect();
        if (prev && now.width > 0 && (Math.abs(prev.x - now.x) > 0.5 || Math.abs(prev.y - now.y) > 0.5 || Math.abs(prev.width - now.width) > 0.5)) {
          el.animate(
            [
              { transform: `translate(${prev.x - now.x}px, ${prev.y - now.y}px) scale(${prev.width / (now.width || 1)}, ${prev.height / (now.height || 1)})`, transformOrigin: 'top left' },
              { transform: 'none', transformOrigin: 'top left' },
            ],
            { duration: DURATION_MS, easing: EASE },
          );
        } else if (!prev) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION_MS - 100, easing: EASE });
        }
      }
    }

    // Record geometry for the NEXT frame entry. Gated on the frame key —
    // running per render forced a getBoundingClientRect reflow every second
    // under the presenter timer (grade pass 2026-07-10). Build-step renders
    // only toggle visibility (no geometry change for the measured elements).
    const map = new Map<string, DOMRect>();
    for (const el of els) map.set(el.getAttribute('data-mm') ?? '', el.getBoundingClientRect());
    prevRects.current = map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stageRef is a stable ref; kind is read fresh per frame entry
  }, [frameKey]);
}
