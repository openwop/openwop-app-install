/**
 * Flow-trait outline pane (ADR 0334 Phase 3) — a live document map projected from
 * `def.flow.headings(doc)`. Each row scrolls the rendered content to the Nth
 * heading (semantic `h1`–`h6` within the editor content ref — no coupling to the
 * document type's CSS). Rendered by the chassis only when the type has a `flow`
 * trait AND the document has headings (a progressive enhancement, like Docs).
 */
import { useCallback } from 'react';
import type { RefObject } from 'react';
import { scrollBehavior } from '../ui/motion.js';

export interface FlowHeading {
  id: string;
  text: string;
  level: number;
}

export interface FlowOutlineProps {
  headings: FlowHeading[];
  /** The rendered-content container the headings live in (for scroll targeting). */
  contentRef: RefObject<HTMLElement | null>;
  label: string;
}

export function FlowOutline({ headings, contentRef, label }: FlowOutlineProps): JSX.Element {
  const scrollTo = useCallback((order: number) => {
    const root = contentRef.current;
    if (!root) return;
    const hs = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
    hs[order]?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }, [contentRef]);

  return (
    <nav className="cv-outline" aria-label={label}>
      <h2 className="cv-editor__panel-title">{label}</h2>
      <ul className="cv-outline__list">
        {headings.map((h, i) => (
          <li key={h.id}>
            <button type="button" className="cv-outline__item" data-level={h.level} onClick={() => scrollTo(i)}>
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
