/**
 * canvas.slides inline renderer (ADR 0153 Phase 1). Renders a structured slide deck
 * — the `canvas.slides` artifact payload — inline in the chat artifact workbench, via
 * the Phase-0 renderer registry. The artifact content is the deck JSON (the producer
 * stringifies the typed payload, same as interactive.chart); we parse and render it
 * from a FIXED layout set — no executable code, no untrusted HTML (every field is
 * React-escaped text, images use a plain <img src>). Read-only here; structured
 * editing is the full-screen editor's job (Phase 2), so this renderer is not editable.
 */

import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

type Layout = 'title' | 'title-bullets' | 'section' | 'quote' | 'image' | 'blank';
interface Slide {
  layout: Layout;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  attribution?: string;
  imageUrl?: string;
  notes?: string;
}
interface Deck {
  title?: string;
  theme?: string;
  slides: Slide[];
}

const LAYOUTS: ReadonlySet<string> = new Set(['title', 'title-bullets', 'section', 'quote', 'image', 'blank']);

/** Parse the artifact content into a Deck, tolerating an already-parsed object.
 *  Returns null when the content is not a usable deck (the renderer shows a Notice). */
function parseDeck(content: string): Deck | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.slides) || obj.slides.length === 0) return null;
  const slides: Slide[] = obj.slides.map((s) => {
    const v = (s ?? {}) as Record<string, unknown>;
    const layout = typeof v.layout === 'string' && LAYOUTS.has(v.layout) ? (v.layout as Layout) : 'title-bullets';
    return {
      layout,
      ...(typeof v.title === 'string' ? { title: v.title } : {}),
      ...(typeof v.subtitle === 'string' ? { subtitle: v.subtitle } : {}),
      ...(Array.isArray(v.bullets) ? { bullets: v.bullets.filter((b): b is string => typeof b === 'string') } : {}),
      ...(typeof v.attribution === 'string' ? { attribution: v.attribution } : {}),
      ...(typeof v.imageUrl === 'string' ? { imageUrl: v.imageUrl } : {}),
      ...(typeof v.notes === 'string' ? { notes: v.notes } : {}),
    };
  });
  return {
    ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
    ...(typeof obj.theme === 'string' ? { theme: obj.theme } : {}),
    slides,
  };
}

function SlideBody({ slide }: { slide: Slide }): JSX.Element {
  switch (slide.layout) {
    case 'title':
      return (
        <div className="canvas-slides__body canvas-slides__body--title">
          {slide.title ? <h4 className="canvas-slides__title">{slide.title}</h4> : null}
          {slide.subtitle ? <p className="canvas-slides__subtitle">{slide.subtitle}</p> : null}
        </div>
      );
    case 'section':
      return (
        <div className="canvas-slides__body canvas-slides__body--section">
          {slide.title ? <h4 className="canvas-slides__section">{slide.title}</h4> : null}
        </div>
      );
    case 'quote':
      return (
        <div className="canvas-slides__body canvas-slides__body--quote">
          {slide.title ? <blockquote className="canvas-slides__quote">{slide.title}</blockquote> : null}
          {slide.attribution ? <p className="canvas-slides__attribution">{slide.attribution}</p> : null}
        </div>
      );
    case 'image':
      return (
        <div className="canvas-slides__body canvas-slides__body--image">
          {slide.title ? <h4 className="canvas-slides__title">{slide.title}</h4> : null}
          {slide.imageUrl ? <img className="canvas-slides__img" src={slide.imageUrl} alt={slide.title ?? ''} loading="lazy" /> : null}
        </div>
      );
    case 'blank':
      return <div className="canvas-slides__body canvas-slides__body--blank" />;
    case 'title-bullets':
    default:
      return (
        <div className="canvas-slides__body">
          {slide.title ? <h4 className="canvas-slides__title">{slide.title}</h4> : null}
          {slide.bullets && slide.bullets.length ? (
            <ul className="canvas-slides__bullets">
              {slide.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          ) : null}
        </div>
      );
  }
}

export function SlidesPreview({ content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const deck = parseDeck(content);
  if (!deck) return <Notice variant="error">{t('slidesInvalid')}</Notice>;
  const theme = deck.theme && deck.theme.trim() ? deck.theme : 'default';
  return (
    <div className="canvas-slides" data-theme={theme}>
      {deck.title ? <h3 className="canvas-slides__deck-title">{deck.title}</h3> : null}
      <ol className="canvas-slides__list" aria-label={deck.title ?? t('slidesDeckLabel')}>
        {deck.slides.map((slide, i) => (
          <li key={i} className="canvas-slides__slide">
            <span className="canvas-slides__num" aria-hidden="true">{i + 1}</span>
            <div className="canvas-slides__frame">
              <SlideBody slide={slide} />
            </div>
            {slide.notes ? (
              <p className="canvas-slides__notes"><span className="canvas-slides__notes-label">{t('slidesNotesLabel')}</span> {slide.notes}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
