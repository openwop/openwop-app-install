/**
 * canvas.slides inline renderer (ADR 0153 Phase 1). Renders a structured slide deck
 * — the `canvas.slides` artifact payload — inline in the chat artifact workbench, via
 * the Phase-0 renderer registry. The artifact content is the deck JSON (the producer
 * stringifies the typed payload, same as interactive.chart); we parse and render it
 * from a FIXED layout set — no executable code, no untrusted HTML (every field is
 * React-escaped text, images use a plain <img src>). Read-only in chat; a
 * provenance-carrying card offers "Open in editor" (ADR 0310 Phase B), which seeds
 * an editable `host.canvas` working copy — the artifact itself is never mutated.
 *
 * `SlidesContentView` is the ONE deck renderer (the one-renderer/all-mounts rule):
 * the chat card, the slides editor preview, and the interactive viewer all mount it.
 */

import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import { ChartRenderer } from './ChartRenderer.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

/** ART-3: untrusted model-provided image URL — allow only web/data/relative
 *  schemes (mirrors EventStreamView.resolveAssetUrl's posture). */
function safeImageSrc(u: string): string | null {
  return /^(https?:|data:image\/|\/(?!\/))/i.test(u.trim()) ? u : null;
}

type Layout = 'title' | 'title-bullets' | 'section' | 'quote' | 'image' | 'blank' | 'blocks';
/** ADR 0328 P5 — the magic-move CONTENT key: stable across a duplicated +
 *  rearranged slide (the Keynote model) with no schema ids; an edited text
 *  changes the key, so the element honestly crossfades instead of gliding. */
export function blockMotionKey(block: { type: string; props?: Record<string, unknown> }, seen: Map<string, number>): string {
  const p = block.props ?? {};
  const content = typeof p.text === 'string' ? p.text : typeof p.src === 'string' ? p.src : typeof p.label === 'string' ? p.label : typeof p.spec === 'string' ? p.spec : '';
  const base = `${block.type}:${content.slice(0, 60)}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}#${n}`;
}

/** ADR 0328 P3 — a slide block ({type, props, children?}); text React-escaped. */
interface Block { type: string; props?: Record<string, unknown>; children?: Block[]; hidden?: boolean }
interface Slide {
  layout: Layout;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  attribution?: string;
  imageUrl?: string;
  notes?: string;
  variant?: string;
  blocks?: Block[];
}
interface Deck {
  title?: string;
  theme?: string;
  slides: Slide[];
}

const LAYOUTS: ReadonlySet<string> = new Set(['title', 'title-bullets', 'section', 'quote', 'image', 'blank', 'blocks']);

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
      ...(typeof v.variant === 'string' ? { variant: v.variant } : {}),
      ...(Array.isArray(v.blocks) ? { blocks: (v.blocks as unknown[]).filter((b): b is Block => Boolean(b) && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string') } : {}),
    };
  });
  return {
    ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
    ...(typeof obj.theme === 'string' ? { theme: obj.theme } : {}),
    slides,
  };
}

/** R2 SL-SP-6 (UX_UPGRADE-slides) — an image the audience cannot see gets a
 *  WITNESS instead of a silent blank: a disallowed src (safeImageSrc null on
 *  authored input) or a load failure renders a labelled placeholder. An UNSET
 *  src still renders nothing — absence is the author's choice, not a failure. */
function SlideImg({ src, alt }: { src: string | null; alt: string }): JSX.Element {
  const { t } = useTranslation('chat');
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) {
    return <div className="canvas-slides__img-fallback">{t('slideImageUnavailable')}</div>;
  }
  return (
    // onError is a resource-load failure hook (the designed broken-media
    // fallback), not a user interaction on the image (AssetPreview precedent).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <img className="canvas-slides__img" src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  );
}

/** ADR 0328 P3 — one block, from the closed 12-type slide catalog. Unknown
 *  types render nothing (forward-compat with future catalog additions). All
 *  text is React-escaped; images go through safeImageSrc; chart specs reuse
 *  the shared ChartRenderer (no new chart code path). */
function BlockView({ block }: { block: Block }): JSX.Element | null {
  // ADR 0344 2b — hidden blocks never render (the slides renderer is read-only
  // everywhere; the editor outline still shows the dimmed row for un-hiding).
  if (block.hidden) return null;
  const p = block.props ?? {};
  const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
  switch (block.type) {
    case 'heading': {
      const level = str('level') === '1' || str('level') === '3' ? str('level') : '2';
      const cls = `canvas-slides__blk-heading canvas-slides__blk-heading--l${level}`;
      // Semantic level follows the block level (h4/h5/h6 under the deck's
      // h3 chrome) so a SR outline of a blocks slide isn't flat.
      const H = (level === '1' ? 'h4' : level === '2' ? 'h5' : 'h6') as 'h4' | 'h5' | 'h6';
      return str('text') ? <H className={cls}>{str('text')}</H> : null;
    }
    case 'text':
      return str('text') ? <p className={`canvas-slides__blk-text canvas-slides__blk-text--${str('size') || 'md'} canvas-slides__blk-tone--${str('tone') || 'default'}`}>{str('text')}</p> : null;
    case 'bullets': {
      const items = Array.isArray(p.items) ? (p.items as unknown[]).filter((b): b is string => typeof b === 'string') : [];
      return items.length ? <ul className="canvas-slides__bullets">{items.map((b, i) => <li key={i}>{b}</li>)}</ul> : null;
    }
    case 'quote':
      return str('text') ? (
        <div className="canvas-slides__body--quote">
          <blockquote className="canvas-slides__quote">{str('text')}</blockquote>
          {str('attribution') ? <p className="canvas-slides__attribution">{str('attribution')}</p> : null}
        </div>
      ) : null;
    case 'callout':
      return str('text') ? <p className={`canvas-slides__blk-callout canvas-slides__blk-callout--${str('tone') || 'info'}`}>{str('text')}</p> : null;
    case 'code':
      return str('text') ? <pre className="canvas-slides__blk-code"><code>{str('text')}</code></pre> : null;
    case 'image': {
      if (!str('src')) return null; // unset = the author's choice, not a failure
      return (
        <figure className={`canvas-slides__blk-img canvas-slides__blk-img--${str('fit') || 'cover'}`}>
          <SlideImg src={safeImageSrc(str('src'))} alt={str('caption')} />
          {str('caption') ? <figcaption className="canvas-slides__blk-caption">{str('caption')}</figcaption> : null}
        </figure>
      );
    }
    case 'chart':
      return str('spec') ? <div className="canvas-slides__blk-chart"><ChartRenderer content={str('spec')} /></div> : null;
    case 'table': {
      const cols = str('columns').split(',').map((c) => c.trim()).filter(Boolean);
      const rows = str('rows').split('\n').map((r) => r.trim()).filter(Boolean).slice(0, 12)
        .map((r) => r.split(',').map((c) => c.trim()));
      return cols.length ? (
        <div className="canvas-slides__blk-table-wrap">
          <table className="canvas-slides__blk-table">
            <thead><tr>{cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : null;
    }
    case 'statCard':
      return str('value') || str('label') ? (
        <div className={`canvas-slides__blk-stat canvas-slides__blk-stat--${str('tone') || 'default'}`}>
          <span className="canvas-slides__blk-stat-value">{str('value')}</span>
          {str('delta') ? <span className="canvas-slides__blk-stat-delta">{str('delta')}</span> : null}
          <span className="canvas-slides__blk-stat-label">{str('label')}</span>
        </div>
      ) : null;
    case 'divider':
      return <hr className="canvas-slides__blk-divider" />;
    case 'spacer':
      return <div className={`canvas-slides__blk-spacer canvas-slides__blk-spacer--${str('size') || 'md'}`} aria-hidden="true" />;
    default:
      return null;
  }
}

function SlideBody({ slide, visibleBlocks }: { slide: Slide; visibleBlocks?: number }): JSX.Element {
  switch (slide.layout) {
    case 'blocks': {
      const variant = slide.variant && ['full', 'hero', 'split', 'two-col'].includes(slide.variant) ? slide.variant : 'full';
      const seen = new Map<string, number>();
      return (
        <div className={`canvas-slides__body canvas-slides__body--blocks canvas-slides__body--v-${variant}`}>
          {(slide.blocks ?? []).map((b, i) => (
            // P5 wrapper: the magic-move measurement target + the build gate
            // (visibility keeps layout — a build never reflows the slide).
            <div
              key={i}
              className={`canvas-slides__blk canvas-slides__blk--${b.type}${visibleBlocks !== undefined && i >= visibleBlocks ? ' canvas-slides__blk--pending' : ''}`}
              data-mm={blockMotionKey(b, seen)}
            >
              <BlockView block={b} />
            </div>
          ))}
        </div>
      );
    }
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
          {slide.imageUrl ? <SlideImg src={safeImageSrc(slide.imageUrl)} alt={slide.title ?? ''} /> : null}
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

/** ONE slide frame (the 16:9 stage), shared by the deck listing and present
 *  mode (ADR 0328 P4). Renders the slide CONTENT only — never the speaker
 *  notes, so the present path cannot leak them (S7). */
export function SlideFrame({ slide, theme, visibleBlocks }: { slide: Slide; theme?: string; visibleBlocks?: number }): JSX.Element {
  const frame = (
    <div className={`canvas-slides__frame${(slide as { background?: string }).background === 'accent' ? ' canvas-slides__frame--accent' : ''}`}>
      <SlideBody slide={slide} {...(visibleBlocks !== undefined ? { visibleBlocks } : {})} />
    </div>
  );
  // Standalone mounts (present mode) need the theme-scoping wrapper; the deck
  // listing already provides it and passes no theme.
  return theme === undefined ? frame : <div className="canvas-slides canvas-slides--frame-only" data-theme={theme && theme.trim() ? theme : 'default'}>{frame}</div>;
}

/** The shared deck renderer — chat card, editor preview, and viewer all mount
 *  this (the canvas framework's `Renderer` contract; slides have no on-canvas
 *  selection, so `editPaths` is accepted but unused). */
export function SlidesContentView({ content }: { content: string; editPaths?: boolean }): JSX.Element {
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
            <SlideFrame slide={slide} />
            {slide.notes ? (
              <p className="canvas-slides__notes"><span className="canvas-slides__notes-label">{t('slidesNotesLabel')}</span> {slide.notes}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The chat artifact card: the shared renderer + an "Open in editor" bar when
 *  the artifact carries run provenance (the AppBuilderPreview precedent — the
 *  editor route + backend are the toggle-gated surface). */
export function SlidesPreview({ artifact, content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { runId, nodeId } = artifact.provenance ?? {};
  const canEdit = Boolean(runId && nodeId);
  return (
    <div className="canvas-slides-card">
      {canEdit ? (
        <div className="canvas-slides-card__bar">
          <Button
            variant="secondary" size="sm"
            onClick={() => navigate(`/slides/new?fromArtifact=${encodeURIComponent(`${runId}:${nodeId}`)}`)}
          >
            {t('slidesOpenEditor')}
          </Button>
        </div>
      ) : null}
      <SlidesContentView content={content} />
    </div>
  );
}
