/**
 * Server-side typed-section → SEMANTIC HTML renderer (ADR 0384 Phase 1).
 *
 * Renders the CMS `SectionType`s as crawler-facing semantic HTML —
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
 *   - prose blocks (ADR 0813): `### ` subheading, `- `/`1. ` lists, `> ` quote;
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
import { isFragmentHref, isInternalHref } from '../../host/internalHref.js';
import type { Section } from '../cms/cmsService.js';
import type { ResolvedContentSection } from '../../host/contentDataSources.js';
import { vendorPublicBase } from '../featureRoute.js';
import { headingEmphasisHtml, stripHeadingEmphasis } from './headingEmphasis.js';

/** HTML-escape an untrusted string for text/attribute positions. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Same predicates as SectionRenderer.tsx — keep in lockstep (golden-pinned).
 *  ADR 0836 D7 — `isInternal` is the ONE shared predicate (`host/internalHref.ts`),
 *  re-checked at this exit: a stored `"/\t/evil.com"` passed the old regex. */
const isSafeHref = (url: string): boolean => /^(https?:|mailto:)/i.test(url.trim());
const isInternal = (url: string): boolean => isInternalHref(url.trim());
/** ADR 0920 D6 — a same-page fragment (`#faq`), the write-time `safeLink` grammar re-checked here. */
const isFragment = (url: string): boolean => isFragmentHref(url.trim());

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

const HEADING_RE = /^###\s+/;
const BULLET_RE = /^[-*]\s+/;
const NUMBERED_RE = /^\d{1,3}[.)]\s+/;
const QUOTE_RE = /^>\s?/;

/** ADR 0813 — blank-line-separated prose blocks with inline markdown. The same
 *  block grammar as the frontend `proseBlocks.ts`: a lone `### ` line → `<h3>`;
 *  every line `- `/`* ` → `<ul>`, `1. `/`1) ` → `<ol>`, `> ` → `<blockquote>`;
 *  anything else → `<p>`. */
function paragraphsHtml(text: string): string {
  const items = (lines: string[], re: RegExp): string =>
    lines.map((l) => `<li>${inlineMarkdownHtml(l.replace(re, ''))}</li>`).join('');
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 1 && HEADING_RE.test(block)) return `<h3>${inlineMarkdownHtml(block.replace(HEADING_RE, ''))}</h3>`;
      if (lines.every((l) => BULLET_RE.test(l))) return `<ul>${items(lines, BULLET_RE)}</ul>`;
      if (lines.every((l) => NUMBERED_RE.test(l))) return `<ol>${items(lines, NUMBERED_RE)}</ol>`;
      if (lines.every((l) => QUOTE_RE.test(l))) return `<blockquote>${inlineMarkdownHtml(lines.map((l) => l.replace(QUOTE_RE, '')).join(' '))}</blockquote>`;
      return `<p>${inlineMarkdownHtml(block)}</p>`;
    })
    .join('\n');
}

/** A guarded anchor, or the escaped label when the URL is unusable. */
function anchorHtml(label: string, url: string): string {
  if (!label) return '';
  if (isFragment(url)) return `<a href="${escapeHtml(url.trim())}">${escapeHtml(label)}</a>`;
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

/** ADR 0920 D3 — the hero's example plan card as crawler text. Every string
 *  the human card shows renders here (escaped), in reading order; the progress
 *  bar itself is presentation, its `progressNote` is the text. The `bubble` is
 *  the figure's caption (the SPA folds it into the figure's name). '' when absent. */
function planFigureHtml(v: unknown): string {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return '';
  const p = v as Record<string, unknown>;
  const para = (x: unknown, strong = false): string => (str(x) ? `<p>${strong ? `<strong>${escapeHtml(str(x))}</strong>` : escapeHtml(str(x))}</p>` : '');
  const lines = (Array.isArray(p.lines) ? (p.lines as unknown[]) : [])
    .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>) : {}))
    .filter((l) => str(l.label) || str(l.text))
    .map((l) => `<li>${str(l.label) ? `<strong>${escapeHtml(str(l.label))}</strong> ` : ''}${escapeHtml(str(l.text))}</li>`);
  const chips = (Array.isArray(p.chips) ? (p.chips as unknown[]) : []).map(str).filter(Boolean).map((c) => `<li>${escapeHtml(c)}</li>`);
  const body = [
    para(p.eyebrow), para(p.title, true), para(p.meta), para(p.progressNote),
    para(p.stepEyebrow), para(p.stepTitle, true),
    lines.length > 0 ? `<ul>${lines.join('')}</ul>` : '',
    para(p.action),
    chips.length > 0 ? `<ul>${chips.join('')}</ul>` : '',
    para(p.note), para(p.initial),
  ].filter(Boolean);
  const bubble = str(p.bubble);
  if (body.length === 0 && !bubble) return '';
  return `<figure>\n${body.join('\n')}${bubble ? `\n<figcaption>${escapeHtml(bubble)}</figcaption>` : ''}\n</figure>`;
}

/** ADR 0920 D5 — a `richText` conversation picture as crawler text: the title
 *  as the caption, then every message, the proposal and its two (inert) choices.
 *  '' when absent. */
function chatFigureHtml(v: unknown): string {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return '';
  const c = v as Record<string, unknown>;
  const para = (x: unknown): string => (str(x) ? `<p>${escapeHtml(str(x))}</p>` : '');
  const messages = (Array.isArray(c.messages) ? (c.messages as unknown[]) : [])
    .map((m) => (m && typeof m === 'object' ? str((m as Record<string, unknown>).text) : ''))
    .filter(Boolean)
    .map((t) => `<li>${escapeHtml(t)}</li>`);
  const pr = c.proposal && typeof c.proposal === 'object' && !Array.isArray(c.proposal) ? (c.proposal as Record<string, unknown>) : {};
  const choices = [str(pr.accept), str(pr.decline)].filter(Boolean).map(escapeHtml);
  const proposal = [
    str(pr.label) || str(pr.text)
      ? `<p>${str(pr.label) ? `<strong>${escapeHtml(str(pr.label))}</strong>` : ''}${str(pr.label) && str(pr.text) ? ' ' : ''}${escapeHtml(str(pr.text))}</p>`
      : '',
    choices.length > 0 ? `<p>${choices.join(' · ')}</p>` : '',
  ].filter(Boolean);
  const body = [
    para(c.subtitle), para(c.badge),
    messages.length > 0 ? `<ol>${messages.join('')}</ol>` : '',
    ...proposal,
    para(c.placeholder),
  ].filter(Boolean);
  const title = str(c.title);
  if (body.length === 0 && !title) return '';
  return `<figure>\n${title ? `<figcaption>${escapeHtml(title)}</figcaption>\n` : ''}${body.join('\n')}\n</figure>`;
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
    (heading ? `<h${level} id="${escapeHtml(headingSlug(stripHeadingEmphasis(heading)))}">${headingEmphasisHtml(heading)}</h${level}>\n` : '');

  switch (section.type) {
    case 'hero': {
      const parts: string[] = ['<header>'];
      if (eyebrow) parts.push(`<p>${escapeHtml(eyebrow)}</p>`);
      parts.push(`<h1>${headingEmphasisHtml(heading)}</h1>`);
      const sub = str(d.subheading);
      if (sub) parts.push(`<p>${inlineMarkdownHtml(sub)}</p>`);
      const ctas = [anchorHtml(str(d.ctaLabel), str(d.ctaUrl)), anchorHtml(str(d.ctaLabel2), str(d.ctaUrl2))].filter(Boolean);
      if (ctas.length > 0) parts.push(`<p>${ctas.join(' ')}</p>`);
      // ADR 0920 D3 — fine print, then the example plan card as real text.
      const note = str(d.note);
      if (note) parts.push(`<p><small>${escapeHtml(note)}</small></p>`);
      const plan = planFigureHtml(d.plan);
      if (plan) parts.push(plan);
      parts.push('</header>');
      return parts.join('\n');
    }

    case 'richText': {
      // ADR 0920 D5 — the conversation picture renders as text after the copy.
      const chat = chatFigureHtml(d.chat);
      return `<section>\n${head()}${paragraphsHtml(str(d.text))}\n${chat ? `${chat}\n` : ''}</section>`;
    }

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
      // ADR 0920 D4 — a footnote under the grid (any layout).
      const colNote = str(d.note) ? `<p><small>${escapeHtml(str(d.note))}</small></p>\n` : '';
      if (layout === 'stats') {
        const items = cols
          .map((c) => `<div><dt>${escapeHtml(str(c.title))}</dt><dd>${escapeHtml(str(c.text))}</dd></div>`)
          .join('\n');
        return `<section>\n<dl>\n${items}\n</dl>\n${colNote}</section>`;
      }
      if (layout === 'steps') {
        const items = cols
          .map((c, i) => {
            const title = str(c.title);
            return `<li>${pad2(i + 1)}. ${title ? `<h3>${escapeHtml(title)}</h3>` : ''}<p>${inlineMarkdownHtml(str(c.text))}</p></li>`;
          })
          .join('\n');
        return `<section>\n${head()}<ol>\n${items}\n</ol>\n${colNote}</section>`;
      }
      // cards (default layout) — also `showcase`, `rows` and the ADR 0920
      // `ruled`/`progress`/`list`/`tiles`/`panels`, whose difference from cards
      // is visual only: a list of titled items either way. Item `eyebrow`,
      // `badge` and `list` rows are text and render; `progress`, `future` and
      // `art` are presentation and add nothing.
      const lede = str(d.lede);
      const items = cols
        .map((c) => {
          const cc = c as { eyebrow?: unknown; badge?: unknown; items?: unknown };
          const title = str(c.title);
          const eyebrowP = str(cc.eyebrow) ? `<p>${escapeHtml(str(cc.eyebrow))}</p>` : '';
          const badgeP = str(cc.badge) ? `<p>${escapeHtml(str(cc.badge))}</p>` : '';
          const text = `<p>${inlineMarkdownHtml(str(c.text))}</p>`;
          const rows = (Array.isArray(cc.items) ? (cc.items as unknown[]) : [])
            .map((it) => it as { label?: unknown; meta?: unknown })
            .filter((it) => str(it.label).length > 0)
            .map((it) => `<li>${escapeHtml(str(it.label))}${str(it.meta) ? ` <small>${escapeHtml(str(it.meta))}</small>` : ''}</li>`);
          const rowsUl = rows.length > 0 ? `<ul>${rows.join('')}</ul>` : '';
          const href = str(c.href);
          const inner = `${eyebrowP}${title ? `<h3>${escapeHtml(title)}</h3>` : ''}${badgeP}${text}${rowsUl}`;
          if (href && isFragment(href)) return `<li><a href="${escapeHtml(href.trim())}">${inner}</a></li>`;
          if (href && (isInternal(href) || isSafeHref(href))) {
            return `<li><a href="${escapeHtml(href)}"${isSafeHref(href) ? ' rel="noopener noreferrer"' : ''}>${inner}</a></li>`;
          }
          return `<li>${inner}</li>`;
        })
        .join('\n');
      return `<section>\n${head()}${lede ? `<p>${inlineMarkdownHtml(lede)}</p>\n` : ''}<ul>\n${items}\n</ul>\n${colNote}</section>`;
    }

    // Deliberate degradation: the SPA resolves product references live via the
    // commerce public read; the server renderer must not import commerce
    // (feature→feature coupling), so crawlers get the section text + a
    // followable storefront link (read-only, no cart — ADR 0384 table).
    case 'productGrid': {
      const storeOrgId = str(d.storeOrgId);
      const link = storeOrgId ? `<p><a href="/store/${encodeURIComponent(storeOrgId)}">${escapeHtml(stripHeadingEmphasis(heading) || 'Store')}</a></p>\n` : '';
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

    // ADR 0843 — a narrated film. Crawlers cannot play a <video>, so the
    // section renders what they CAN index: the poster as an <img>, the title,
    // the description, and followable links to the file (plus YouTube and the
    // captions track when authored). URLs were https-checked at write time and
    // are re-checked at this exit (the ADR 0836 D7 rule); one that fails is
    // simply not linked. The VideoObject JSON-LD rides jsonLdBlocks.
    case 'video': {
      const https = (v: unknown): string => (/^https:\/\//i.test(str(v).trim()) ? str(v).trim() : '');
      const src = https(d.src);
      const poster = https(d.poster);
      const captions = https(d.captions);
      const youtube = https(d.youtubeUrl);
      const title = str(d.title);
      const description = str(d.description);
      const length = str(d.length);
      const lede = str(d.lede);
      const links = [
        src ? `<a href="${escapeHtml(src)}" rel="noopener noreferrer">Watch the video${length ? ` (${escapeHtml(length)})` : ''}</a>` : '',
        youtube ? `<a href="${escapeHtml(youtube)}" rel="noopener noreferrer">Watch on YouTube</a>` : '',
        captions ? `<a href="${escapeHtml(captions)}" rel="noopener noreferrer">Captions (WebVTT)</a>` : '',
      ].filter(Boolean);
      const cap = [
        title ? `<p><strong>${escapeHtml(title)}</strong></p>` : '',
        description ? `<p>${escapeHtml(description)}</p>` : '',
        links.length > 0 ? `<p>${links.join(' ')}</p>` : '',
      ].filter(Boolean).join('\n');
      const img = poster ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(title)}" width="1920" height="1080">\n` : '';
      return `<section>\n${head()}${lede ? `<p>${inlineMarkdownHtml(lede)}</p>\n` : ''}<figure>\n${img}${cap ? `<figcaption>\n${cap}\n</figcaption>\n` : ''}</figure>\n</section>`;
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
