/**
 * Shared CMS section renderer (ADR 0027). ONE renderer for two modes:
 *   - `mode="editor"` — a rough live preview inside the CMS / Front-page editor.
 *   - `mode="public"` — the designed marketing front page (the "engineering
 *     broadsheet": serif display, mono numerals, the node-glyph motif, the
 *     cards / steps / stats layouts). Styled in styles/global.css (`.fp-*`).
 *
 * Content-safety posture (ADR 0009): NO `dangerouslySetInnerHTML`. Prose runs
 * through a tiny SAFE markdown subset — paragraphs + `**bold**` / `*italic*` /
 * `` `code` `` / `[label](url)` with an http(s)/mailto / internal-path guard.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Section } from './cmsClient.js';
import { assetUrl } from './cmsClient.js';

/** A node-supplied string field, or '' when absent/non-string. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const pad2 = (n: number): string => String(n).padStart(2, '0');

export type SectionRenderMode = 'editor' | 'public';

/** An http(s)/mailto URL is safe as an external link; anything else is not. */
const isSafeHref = (url: string): boolean => /^(https?:|mailto:)/i.test(url.trim());
/** An internal app path (`/agents`) — single leading slash, NOT `//` or `/\`
 *  (both normalize to a protocol-relative EXTERNAL URL → open-redirect shape). */
const isInternal = (url: string): boolean => /^\/(?![/\\])/.test(url.trim());

/** Inline markdown → React nodes: `**bold**`, `*italic*`, `` `code` ``,
 *  `[label](url)`. No raw HTML; an unsafe link degrades to plain text. */
function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={key} className="fp-code">{m[3]}</code>);
    else if (m[4] !== undefined && m[5] !== undefined) {
      const label = m[4]; const url = m[5];
      out.push(isSafeHref(url)
        ? <a key={key} href={url} rel="noopener noreferrer">{label}</a>
        : isInternal(url) ? <Link key={key} to={url}>{label}</Link> : label);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render `text` as paragraphs (blank-line separated), inline-formatted. */
function RichText({ text, className = 'cms-richtext' }: { text: string; className?: string }): JSX.Element {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length === 0) return <p className={className} />;
  return <>{paras.map((p, i) => <p key={i} className={className}>{inlineMarkdown(p, `p${i}`)}</p>)}</>;
}

// ── Public (front-page) building blocks ─────────────────────────────────────

/** Mono eyebrow + serif heading — the recurring section header. */
function SectionHead({ eyebrow, heading }: { eyebrow?: string | undefined; heading?: string | undefined }): JSX.Element | null {
  if (!eyebrow && !heading) return null;
  return (
    <header className="fp-head">
      {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
      {heading ? <h2 className="fp-head__title">{heading}</h2> : null}
    </header>
  );
}

/** The openwop node motif — square / circle / diamond, cycled per index. */
function NodeGlyph({ i }: { i: number }): JSX.Element {
  const shape = i % 3;
  return (
    <span className="fp-glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20">
        {shape === 0 ? <rect x="5" y="5" width="14" height="14" rx="2.5" />
          : shape === 1 ? <circle cx="12" cy="12" r="8" />
            : <path d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z" />}
      </svg>
    </span>
  );
}

/** Faint schematic backdrop for the hero — nodes wired into a small graph. */
function HeroSchematic(): JSX.Element {
  return (
    <svg className="fp-hero__schematic" viewBox="0 0 420 260" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
      <path className="fp-wire" d="M70 60 H170 M170 60 V130 M170 130 H300 M170 130 V200 M170 200 H300 M300 130 H360" />
      <rect className="fp-node" x="50" y="48" width="24" height="24" rx="4" />
      <circle className="fp-node" cx="170" cy="60" r="13" />
      <rect className="fp-node" x="158" y="118" width="24" height="24" rx="4" />
      <circle className="fp-node fp-node--accent" cx="300" cy="130" r="13" />
      <path className="fp-node" d="M300 188 L314 202 L300 216 L286 202 Z" />
      <circle className="fp-node" cx="360" cy="130" r="9" />
    </svg>
  );
}

function CtaLink({ label, url, primary }: { label: string; url: string; primary?: boolean }): JSX.Element | null {
  if (!label) return null;
  const cls = `fp-btn ${primary ? 'fp-btn--primary' : 'fp-btn--ghost'}`;
  if (isInternal(url)) return <Link className={cls} to={url}>{label}</Link>;
  if (url && isSafeHref(url)) return <a className={cls} href={url} rel="noopener noreferrer">{label}</a>;
  return <span className={cls}>{label}</span>;
}

/** Render one section's PUBLIC (front-page) markup. */
function PublicSection({ section }: { section: Section }): JSX.Element {
  const d = section.data;
  const eyebrow = str(d.eyebrow) || undefined;
  const heading = str(d.heading) || undefined;

  switch (section.type) {
    case 'hero':
      return (
        <section className="cms-public-section fp-hero">
          <HeroSchematic />
          <div className="fp-shell fp-hero__inner">
            {eyebrow ? <p className="fp-eyebrow fp-eyebrow--accent">{eyebrow}</p> : null}
            <h1 className="fp-hero__title">{str(d.heading)}</h1>
            {str(d.subheading) ? <p className="fp-hero__lede">{inlineMarkdown(str(d.subheading), 'hl')}</p> : null}
            {str(d.ctaLabel) || str(d.ctaLabel2) ? (
              <div className="fp-hero__cta">
                <CtaLink label={str(d.ctaLabel)} url={str(d.ctaUrl)} primary />
                <CtaLink label={str(d.ctaLabel2)} url={str(d.ctaUrl2)} />
              </div>
            ) : null}
          </div>
        </section>
      );

    case 'richText':
      return (
        <section className="cms-public-section fp-section fp-prose">
          <div className="fp-shell fp-shell--narrow">
            <SectionHead eyebrow={eyebrow} heading={heading} />
            <div className="fp-prose__body"><RichText text={str(d.text)} className="fp-prose__p" /></div>
          </div>
        </section>
      );

    case 'image':
      return (
        <section className="cms-public-section fp-section fp-figure">
          <div className="fp-shell">
            {str(d.token) ? <img className="fp-figure__img" src={assetUrl(str(d.token))} alt={str(d.alt)} /> : null}
            {str(d.caption) ? <p className="fp-figure__cap">{str(d.caption)}</p> : null}
          </div>
        </section>
      );

    case 'cta':
      return (
        <section className="cms-public-section fp-section fp-cta">
          <div className="fp-shell fp-cta__inner">
            {eyebrow ? <p className="fp-eyebrow fp-eyebrow--accent">{eyebrow}</p> : null}
            {heading ? <h2 className="fp-cta__title">{heading}</h2> : null}
            {str(d.subheading) ? <p className="fp-cta__lede">{str(d.subheading)}</p> : null}
            <div className="fp-cta__actions"><CtaLink label={str(d.label)} url={str(d.url)} primary /></div>
          </div>
        </section>
      );

    case 'columns': {
      const cols: { title?: string; text?: string }[] = Array.isArray(d.columns) ? d.columns : [];
      const layout = str(d.layout) || 'cards';

      if (layout === 'stats') {
        return (
          <section className="cms-public-section fp-section fp-stats">
            <div className="fp-shell">
              <dl className="fp-stats__grid">
                {cols.map((c, i) => (
                  <div key={i} className="fp-stat">
                    <dt className="fp-stat__value">{str(c.title)}</dt>
                    <dd className="fp-stat__label">{str(c.text)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        );
      }
      if (layout === 'steps') {
        return (
          <section className="cms-public-section fp-section fp-steps">
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} />
              <ol className="fp-steps__list">
                {cols.map((c, i) => (
                  <li key={i} className="fp-step">
                    <span className="fp-step__num">{pad2(i + 1)}</span>
                    <div className="fp-step__body">
                      {str(c.title) ? <h3 className="fp-step__title">{str(c.title)}</h3> : null}
                      <p className="fp-step__text">{str(c.text)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        );
      }
      return (
        <section className="cms-public-section fp-section fp-cards">
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} />
            <div className="fp-cards__grid">
              {cols.map((c, i) => (
                <article key={i} className="fp-card">
                  <NodeGlyph i={i} />
                  {str(c.title) ? <h3 className="fp-card__title">{str(c.title)}</h3> : null}
                  <p className="fp-card__text">{str(c.text)}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      );
    }

    default:
      return <section className="cms-public-section" />;
  }
}

/** The simple editor preview (markup kept rough — the public page is `.fp-*`). */
function EditorPreview({ section }: { section: Section }): JSX.Element {
  const d = section.data;
  switch (section.type) {
    case 'hero':
      return (
        <div className="cms-hero-preview">
          {str(d.imageToken) ? <img src={assetUrl(str(d.imageToken))} alt="" className="cms-hero-img" /> : null}
          {str(d.eyebrow) ? <span className="u-label-sm">{str(d.eyebrow)}</span> : null}
          <strong className="cms-hero-heading">{str(d.heading)}</strong>
          {str(d.subheading) ? <span className="u-label-sm">{str(d.subheading)}</span> : null}
        </div>
      );
    case 'richText':
      return <RichText text={str(d.text)} />;
    case 'image':
      return str(d.token)
        ? <img src={assetUrl(str(d.token))} alt={str(d.alt)} className="cms-img" />
        : <span className="u-label-sm">(no image)</span>;
    case 'cta':
      return <span className="chip chip--accent">{str(d.heading) || str(d.label)}</span>;
    case 'columns': {
      const cols: { title?: string; text?: string }[] = Array.isArray(d.columns) ? d.columns : [];
      return (
        <div className="cms-columns" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols.length)}, 1fr)` }}>
          {cols.map((c, i) => <div key={i} className="cms-column-cell">{str(c.title) ? <strong>{str(c.title)} · </strong> : null}{str(c.text)}</div>)}
        </div>
      );
    }
    default:
      return <span className="u-label-sm">Unknown section.</span>;
  }
}

/** Render one typed section in editor or public mode. */
export function RenderSection({ section, mode = 'editor' }: { section: Section; mode?: SectionRenderMode }): JSX.Element {
  return mode === 'public' ? <PublicSection section={section} /> : <EditorPreview section={section} />;
}

/** Render an ordered list of sections. */
export function RenderSections({ sections, mode = 'editor' }: { sections: Section[]; mode?: SectionRenderMode }): JSX.Element {
  return <>{sections.map((s) => <RenderSection key={s.sectionId} section={s} mode={mode} />)}</>;
}
