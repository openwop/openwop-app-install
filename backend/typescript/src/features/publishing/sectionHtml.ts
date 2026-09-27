/**
 * Server-side typed-section → SEMANTIC HTML renderer (ADR 0384 Phase 1).
 *
 * Renders the seven CMS `SectionType`s as crawler-facing semantic HTML —
 * headings, paragraphs, links, lists, `<img alt>` — NOT the designed `.fp-*`
 * layout (crawlers index content and meta, not CSS). The frontend
 * `SectionRenderer.tsx` remains the human renderer; the two CANNOT share code
 * (separate build targets), so drift is pinned by tests instead:
 *
 *   1. the SECTION_TYPES coverage test — every entry in the closed vocabulary
 *      MUST have a branch here (a new CMS section type without a server branch
 *      is a red build, the prompt-catalog-parity discipline);
 *   2. the golden fixture test — one page exercising every type + every
 *      safe-markdown token against an expected-HTML snapshot, so a semantic
 *      change to either renderer surfaces as a deliberate golden diff.
 *
 * Mirrored semantics (same grammar, same predicates as SectionRenderer.tsx):
 *   - inline markdown: `**bold**` `*italic*` `` `code` `` `[label](url)`;
 *   - link safety: http(s)/mailto external, single-leading-slash internal;
 *     an unsafe link degrades to its plain-text label;
 *   - every interpolated string is HTML-escaped — no raw HTML pass-through.
 *
 * Deliberate degradations (recorded, tested):
 *   - `productGrid` renders heading/eyebrow + a storefront link only. The SPA
 *     resolves product references live client-side (commerce public read);
 *     the server renderer does NOT import the commerce feature (feature→feature
 *     coupling) — crawlers get the section's own text + a followable link.
 *   - `form` renders its heading/eyebrow label stub only (interactive fill is
 *     JS-only; ADR 0384 table).
 *
 * An UNKNOWN/future section type returns null, and `pageBodyHtml` then returns
 * null — the prerender path falls back to serving the SPA shell (honest-off,
 * never a broken document).
 */
import type { Section } from '../cms/cmsService.js';
import type { ResolvedContentSection } from '../../host/contentDataSources.js';
import { vendorPublicBase } from '../featureRoute.js';

/** HTML-escape an untrusted string for text/attribute positions. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Same predicates as SectionRenderer.tsx — keep in lockstep (golden-pinned). */
const isSafeHref = (url: string): boolean => /^(https?:|mailto:)/i.test(url.trim());
const isInternal = (url: string): boolean => /^\/(?![/\\])/.test(url.trim());

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Inline markdown → HTML (same grammar/regex as the frontend renderer). */
export function inlineMarkdownHtml(text: string): string {
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    if (m[1] !== undefined) out += `<strong>${escapeHtml(m[1])}</strong>`;
    else if (m[2] !== undefined) out += `<em>${escapeHtml(m[2])}</em>`;
    else if (m[3] !== undefined) out += `<code>${escapeHtml(m[3])}</code>`;
    else if (m[4] !== undefined && m[5] !== undefined) {
      const label = m[4];
      const url = m[5];
      // Safe external or internal link; anything else degrades to plain text.
      if (isSafeHref(url) || isInternal(url)) {
        out += `<a href="${escapeHtml(url)}"${isSafeHref(url) ? ' rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>`;
      } else {
        out += escapeHtml(label);
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) out += escapeHtml(text.slice(last));
  return out;
}

/** Blank-line-separated text → `<p>` paragraphs with inline markdown. */
function paragraphsHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${inlineMarkdownHtml(p)}</p>`)
    .join('\n');
}

/** A guarded anchor, or the escaped label when the URL is unusable. */
function anchorHtml(label: string, url: string): string {
  if (!label) return '';
  if (isInternal(url)) return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  if (url && isSafeHref(url)) return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  return escapeHtml(label);
}

export interface SectionHtmlOptions {
  /** Base for media-token asset URLs (the existing public assets route). */
  assetBase: string;
  /** ADR 0407 D3 — server-resolved content for referenced sections
   *  (entityList/entityDetail), keyed by sectionId. Populated by the
   *  prerenderer via the core content-section registry (published + public +
   *  live rows only — no cloaking). Absent ⇒ the section renders its chrome
   *  only (the honest degradation; the existing golden/coverage tests pass no
   *  map, so they stay unchanged). */
  resolvedSections?: Record<string, ResolvedContentSection>;
}

const assetUrl = (base: string, token: string): string =>
  `${vendorPublicBase(base)}/assets/${encodeURIComponent(token)}`;

/** R2-D10 (UX_UPGRADE-docs) — stable anchor id from the heading text. MUST stay
 *  byte-equal to `frontend/react/src/features/cms/headingSlug.ts` (the SPA
 *  emits the same ids; the docs TOC derives them; both suites pin the same
 *  fixture cases so a drift in either goes red). */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'section';
}

/**
 * One section → semantic HTML, or null for an unknown/future type (the page
 * then falls back to the SPA shell — never a partial document).
 */
export function sectionHtml(section: Section, opts: SectionHtmlOptions): string | null {
  const d = section.data as Record<string, unknown>;
  const eyebrow = str(d.eyebrow);
  const heading = str(d.heading);
  // R2-D10 — section headings carry the same stable anchor id the SPA emits,
  // so fragment links work in the prerendered document too. Duplicate headings
  // collide first-wins on both sides — identical behaviour, documented.
  const head = (level: 2 | 3 = 2): string =>
    (eyebrow ? `<p>${escapeHtml(eyebrow)}</p>\n` : '') +
    (heading ? `<h${level} id="${escapeHtml(headingSlug(heading))}">${escapeHtml(heading)}</h${level}>\n` : '');

  switch (section.type) {
    case 'hero': {
      const parts: string[] = ['<header>'];
      if (eyebrow) parts.push(`<p>${escapeHtml(eyebrow)}</p>`);
      parts.push(`<h1>${escapeHtml(heading)}</h1>`);
      const sub = str(d.subheading);
      if (sub) parts.push(`<p>${inlineMarkdownHtml(sub)}</p>`);
      const ctas = [anchorHtml(str(d.ctaLabel), str(d.ctaUrl)), anchorHtml(str(d.ctaLabel2), str(d.ctaUrl2))].filter(Boolean);
      if (ctas.length > 0) parts.push(`<p>${ctas.join(' ')}</p>`);
      parts.push('</header>');
      return parts.join('\n');
    }

    case 'richText':
      return `<section>\n${head()}${paragraphsHtml(str(d.text))}\n</section>`;

    case 'image': {
      const token = str(d.token);
      const caption = str(d.caption);
      const img = token
        ? `<img src="${escapeHtml(assetUrl(opts.assetBase, token))}" alt="${escapeHtml(str(d.alt))}">`
        : '';
      return `<figure>\n${img}${caption ? `\n<figcaption>${escapeHtml(caption)}</figcaption>` : ''}\n</figure>`;
    }

    case 'cta': {
      const sub = str(d.subheading);
      return `<section>\n${head()}${sub ? `<p>${escapeHtml(sub)}</p>\n` : ''}<p>${anchorHtml(str(d.label), str(d.url))}</p>\n</section>`;
    }

    case 'columns': {
      const cols: { title?: unknown; text?: unknown; href?: unknown }[] = Array.isArray(d.columns) ? (d.columns as never[]) : [];
      const layout = str(d.layout) || 'cards';
      if (layout === 'stats') {
        const items = cols
          .map((c) => `<div><dt>${escapeHtml(str(c.title))}</dt><dd>${escapeHtml(str(c.text))}</dd></div>`)
          .join('\n');
        return `<section>\n<dl>\n${items}\n</dl>\n</section>`;
      }
      if (layout === 'steps') {
        const items = cols
          .map((c, i) => {
            const title = str(c.title);
            return `<li>${pad2(i + 1)}. ${title ? `<h3>${escapeHtml(title)}</h3>` : ''}<p>${inlineMarkdownHtml(str(c.text))}</p></li>`;
          })
          .join('\n');
        return `<section>\n${head()}<ol>\n${items}\n</ol>\n</section>`;
      }
      // cards (default layout) — also `showcase` and `rows`, whose difference
      // from cards is visual only: a list of titled items either way.
      const lede = str(d.lede);
      const items = cols
        .map((c) => {
          const title = str(c.title);
          const text = `<p>${inlineMarkdownHtml(str(c.text))}</p>`;
          const href = str(c.href);
          const inner = `${title ? `<h3>${escapeHtml(title)}</h3>` : ''}${text}`;
          if (href && (isInternal(href) || isSafeHref(href))) {
            return `<li><a href="${escapeHtml(href)}"${isSafeHref(href) ? ' rel="noopener noreferrer"' : ''}>${inner}</a></li>`;
          }
          return `<li>${inner}</li>`;
        })
        .join('\n');
      return `<section>\n${head()}${lede ? `<p>${inlineMarkdownHtml(lede)}</p>\n` : ''}<ul>\n${items}\n</ul>\n</section>`;
    }

    // Deliberate degradation: the SPA resolves product references live via the
    // commerce public read; the server renderer must not import commerce
    // (feature→feature coupling), so crawlers get the section text + a
    // followable storefront link (read-only, no cart — ADR 0384 table).
    case 'productGrid': {
      const storeOrgId = str(d.storeOrgId);
      const link = storeOrgId ? `<p><a href="/store/${encodeURIComponent(storeOrgId)}">${escapeHtml(heading || 'Store')}</a></p>\n` : '';
      return `<section>\n${head()}${link}</section>`;
    }

    // Interactive fill is JS-only; a label stub keeps the section noscript-safe.
    case 'form':
      return `<section>\n${head()}</section>`;

    // ADR 0407 D3 — entity-backed sections resolve SERVER-SIDE for crawlers via
    // the core content-section registry (opts.resolvedSections, populated by the
    // prerenderer through the SAME public-read gate humans hit — no cloaking).
    // No feature→feature import: publishing consumes core, entities registers
    // into core. When unresolved (no registry / no rows / not prerendering) the
    // section degrades to its chrome — the honest fallback.
    case 'entityList': {
      const resolved = opts.resolvedSections?.[section.sectionId];
      if (!resolved || resolved.items.length === 0) return `<section>\n${head()}</section>`;
      const items = resolved.items
        .map((it) => `<li>\n<article>\n<h3>${escapeHtml(it.title)}</h3>\n${it.body ? `<p>${escapeHtml(it.body)}</p>\n` : ''}</article>\n</li>`)
        .join('\n');
      return `<section>\n${head()}<ul>\n${items}\n</ul>\n</section>`;
    }
    case 'entityDetail': {
      const item = opts.resolvedSections?.[section.sectionId]?.items[0];
      if (!item) return `<section>\n${head()}</section>`;
      return `<section>\n${head()}<article>\n<h3>${escapeHtml(item.title)}</h3>\n${item.body ? `<p>${escapeHtml(item.body)}</p>\n` : ''}</article>\n</section>`;
    }

    // Deliberate degradation (same class as productGrid/form): the tier grid is a
    // CLIENT-SIDE billing read — the SPA resolves the display-safe tier catalog
    // live from the `/public/pricing` read. The server renderer does NOT import
    // billing (feature→feature coupling), so crawlers get the section's own
    // heading/blurb + a followable CTA, never server-rendered tier/price data.
    case 'pricing': {
      const blurb = str(d.blurb);
      const cta = anchorHtml(str(d.ctaLabel), str(d.ctaUrl));
      return `<section>\n${head()}${blurb ? `<p>${inlineMarkdownHtml(blurb)}</p>\n` : ''}${cta ? `<p>${cta}</p>\n` : ''}</section>`;
    }

    // ADR 0485 — a capability comparison MATRIX renders as a real semantic
    // <table> (crawler-indexable): capabilities are row headers, products are
    // column headers, cells are the authored status tokens (escaped text). An
    // empty matrix degrades to its chrome (the honest fallback).
    case 'comparison': {
      const columns: string[] = Array.isArray(d.columns)
        ? (d.columns as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      const rows: { label: string; cells: string[] }[] = Array.isArray(d.rows)
        ? (d.rows as unknown[]).map((r) => {
          const rr = r as { label?: unknown; cells?: unknown };
          return { label: str(rr.label), cells: Array.isArray(rr.cells) ? (rr.cells as unknown[]).map(str) : [] };
        }).filter((r) => r.label.length > 0)
        : [];
      if (columns.length === 0 || rows.length === 0) return `<section>\n${head()}</section>`;
      const thead = `<tr><td></td>${columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('')}</tr>`;
      const tbody = rows.map((row) =>
        `<tr><th scope="row">${escapeHtml(row.label)}</th>${columns.map((_, ci) => `<td>${escapeHtml(row.cells[ci] ?? '')}</td>`).join('')}</tr>`,
      ).join('\n');
      const legend = str(d.legend);
      const note = str(d.note);
      return `<section>\n${head()}<table>\n<thead>${thead}</thead>\n<tbody>\n${tbody}\n</tbody>\n</table>${legend ? `\n<p>${escapeHtml(legend)}</p>` : ''}${note ? `\n<p>${escapeHtml(note)}</p>` : ''}\n</section>`;
    }

    // R2-G10 — an authored Q/A block renders as native <details>/<summary>
    // (semantic, crawler-indexable; the FAQPage JSON-LD rides jsonLdBlocks from
    // the same validated data).
    case 'faq': {
      const items: { q: string; a: string }[] = Array.isArray(d.items)
        ? (d.items as unknown[]).map((it) => {
          const ii = it as { q?: unknown; a?: unknown };
          return { q: str(ii.q), a: str(ii.a) };
        }).filter((it) => it.q.length > 0 && it.a.length > 0)
        : [];
      if (items.length === 0) return `<section>\n${head()}</section>`;
      const body = items.map((it) =>
        `<details><summary>${escapeHtml(it.q)}</summary><p>${escapeHtml(it.a)}</p></details>`,
      ).join('\n');
      return `<section>\n${head()}${body}\n</section>`;
    }

    // R2-G10 — attributed social proof: real <figure>/<blockquote>/<figcaption>
    // semantics; an unattributed quote renders without a byline, never an
    // invented one.
    case 'quotes': {
      const items: { quote: string; name: string; role: string }[] = Array.isArray(d.items)
        ? (d.items as unknown[]).map((it) => {
          const ii = it as { quote?: unknown; name?: unknown; role?: unknown };
          return { quote: str(ii.quote), name: str(ii.name), role: str(ii.role) };
        }).filter((it) => it.quote.length > 0)
        : [];
      if (items.length === 0) return `<section>\n${head()}</section>`;
      const body = items.map((it) => {
        const byline = [it.name, it.role].filter((x) => x.length > 0).join(', ');
        return `<figure><blockquote><p>${escapeHtml(it.quote)}</p></blockquote>${byline ? `<figcaption>${escapeHtml(byline)}</figcaption>` : ''}</figure>`;
      }).join('\n');
      return `<section>\n${head()}${body}\n</section>`;
    }

    // ADR 0748 — a protocol-authored `fields` section: flat named scalars, every
    // key and value escaped text (a definition list, no heading semantics —
    // `heading` here is just a field the author named).
    case 'fields': {
      const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
      const rows = Object.entries(d).map(([k, v]) => [k, text(v)] as const).filter(([, v]) => v.length > 0);
      if (rows.length === 0) return '<section></section>';
      return `<section>\n<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>\n</section>`;
    }

    default:
      // Unknown/future type: signal page-level fallback to the SPA shell.
      return null;
  }
}

/**
 * All sections → the prerender `<body>` inner HTML, or null when ANY section
 * is unrenderable (the caller then serves the SPA shell — honest-off).
 */
export function pageBodyHtml(sections: Section[], opts: SectionHtmlOptions): string | null {
  const parts: string[] = [];
  for (const s of sections) {
    const html = sectionHtml(s, opts);
    if (html === null) return null;
    parts.push(html);
  }
  return `<main>\n${parts.join('\n')}\n</main>`;
}
