/**
 * UX_UPGRADE-docs R2-D12 — the section→MARKDOWN projection behind the
 * `GET …/pages/:slug.md` read and the docs "Copy page as Markdown" affordance.
 * 2026 table stakes: agents are the majority docs consumer, and every leader
 * ships a per-page markdown door (Vercel/Stripe append-`.md`, Mintlify/GitBook
 * page menus).
 *
 * Mirrors `sectionHtml.ts`: one branch per SECTION_TYPES entry (the same
 * coverage drift-gate discipline — a new CMS type without a markdown branch is
 * a red build), live-data sections degrade to their own chrome + a followable
 * link (never fabricated data), unknown type ⇒ null ⇒ the caller 404s rather
 * than serving a partial document. Output is plain CommonMark: authored text is
 * emitted verbatim (the CMS stores plain text/markdown-subset — no HTML to
 * escape), never wrapped in invented formatting.
 */
import type { Section } from '../cms/cmsService.js';
import { vendorPublicBase } from '../featureRoute.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One section → markdown, or null for an unknown/future type. */
export function sectionMarkdown(section: Section, baseUrl: string): string | null {
  const d = section.data as Record<string, unknown>;
  const eyebrow = str(d.eyebrow);
  const heading = str(d.heading);
  const head = (level = 2): string =>
    (heading ? `${'#'.repeat(level)} ${heading}\n\n` : '') +
    (eyebrow ? `*${eyebrow}*\n\n` : '');

  switch (section.type) {
    case 'hero': {
      const parts: string[] = [];
      // `##`, not `#` — pageMarkdown owns the document's single H1 (R2R-6).
      if (heading) parts.push(`## ${heading}`);
      if (eyebrow) parts.push(`*${eyebrow}*`);
      const sub = str(d.subheading);
      if (sub) parts.push(sub);
      const ctas = [
        str(d.ctaLabel) && str(d.ctaUrl) ? `[${str(d.ctaLabel)}](${str(d.ctaUrl)})` : '',
        str(d.ctaLabel2) && str(d.ctaUrl2) ? `[${str(d.ctaLabel2)}](${str(d.ctaUrl2)})` : '',
      ].filter(Boolean);
      if (ctas.length > 0) parts.push(ctas.join(' · '));
      return parts.join('\n\n');
    }
    case 'richText':
      return `${head()}${str(d.text)}`;
    case 'image': {
      const token = str(d.token);
      if (!token) return head().trim();
      const url = `${vendorPublicBase(baseUrl)}/assets/${encodeURIComponent(token)}`;
      const caption = str(d.caption);
      return `![${str(d.alt)}](${url})${caption ? `\n\n*${caption}*` : ''}`;
    }
    case 'cta': {
      const label = str(d.label);
      const url = str(d.url);
      return `${head()}${str(d.subheading) ? `${str(d.subheading)}\n\n` : ''}${label && url ? `[${label}](${url})` : ''}`.trim();
    }
    case 'columns': {
      const cols = Array.isArray(d.columns) ? d.columns : [];
      const ordered = str(d.layout) === 'steps';
      const items = cols.map((c, i) => {
        const cc = c as { title?: unknown; text?: unknown };
        const title = str(cc.title);
        const text = str(cc.text);
        const bullet = ordered ? `${i + 1}.` : '-';
        return `${bullet} ${title ? `**${title}** — ` : ''}${text}`;
      });
      return `${head()}${items.join('\n')}`;
    }
    // Live-data sections: the markdown carries the section's own chrome and a
    // followable pointer — the data resolves client-side and is never baked
    // (the sectionHtml degradation rule).
    case 'productGrid':
      return `${head()}${str(d.storeOrgId) ? `[Shop](${baseUrl}/store/${encodeURIComponent(str(d.storeOrgId))})` : ''}`.trim();
    case 'form':
      return head().trim();
    case 'pricing': {
      const blurb = str(d.blurb);
      const cta = str(d.ctaLabel) && str(d.ctaUrl) ? `[${str(d.ctaLabel)}](${str(d.ctaUrl)})` : '';
      return `${head()}${blurb ? `${blurb}\n\n` : ''}${cta}`.trim();
    }
    case 'entityList':
    case 'entityDetail':
      return head().trim();
    case 'comparison': {
      const columns = (Array.isArray(d.columns) ? d.columns : []).filter((x): x is string => typeof x === 'string');
      const rows = (Array.isArray(d.rows) ? d.rows : []).map((r) => {
        const rr = r as { label?: unknown; cells?: unknown };
        return { label: str(rr.label), cells: Array.isArray(rr.cells) ? (rr.cells as unknown[]).map(str) : [] };
      }).filter((r) => r.label.length > 0);
      if (columns.length === 0 || rows.length === 0) return head().trim();
      const headerRow = `| | ${columns.join(' | ')} |`;
      const sepRow = `|---|${columns.map(() => '---').join('|')}|`;
      const bodyRows = rows.map((r) => `| ${r.label} | ${columns.map((_, ci) => r.cells[ci] ?? '').join(' | ')} |`);
      const legend = str(d.legend);
      const note = str(d.note);
      return `${head()}${[headerRow, sepRow, ...bodyRows].join('\n')}${legend ? `\n\n${legend}` : ''}${note ? `\n\n${note}` : ''}`;
    }
    case 'faq': {
      const items = (Array.isArray(d.items) ? d.items : []).map((it) => {
        const ii = it as { q?: unknown; a?: unknown };
        return { q: str(ii.q), a: str(ii.a) };
      }).filter((it) => it.q && it.a);
      return `${head()}${items.map((it) => `### ${it.q}\n\n${it.a}`).join('\n\n')}`;
    }
    case 'quotes': {
      const items = (Array.isArray(d.items) ? d.items : []).map((it) => {
        const ii = it as { quote?: unknown; name?: unknown; role?: unknown };
        return { quote: str(ii.quote), name: str(ii.name), role: str(ii.role) };
      }).filter((it) => it.quote);
      return `${head()}${items.map((it) => {
        const byline = [it.name, it.role].filter(Boolean).join(', ');
        return `> ${it.quote}${byline ? `\n>\n> — ${byline}` : ''}`;
      }).join('\n\n')}`;
    }
    case 'fields': {
      // ADR 0748 — flat named scalars (a protocol-authored section).
      const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
      return Object.entries(d).map(([k, v]) => [k, text(v)] as const).filter(([, v]) => v).map(([k, v]) => `- **${k}**: ${v}`).join('\n');
    }
    default:
      return null;
  }
}

/**
 * A whole public page → one markdown document: title, freshness, sections.
 * Null when ANY section is unrenderable (never a partial document).
 */
export function pageMarkdown(
  page: { title: string; updatedAt: string; sections: Section[] },
  baseUrl: string,
): string | null {
  const parts: string[] = [`# ${page.title}`, '', `*Updated ${page.updatedAt.slice(0, 10)}*`];
  for (const s of page.sections) {
    const md = sectionMarkdown(s, baseUrl);
    if (md === null) return null;
    if (md.trim().length > 0) parts.push('', md.trim());
  }
  return parts.join('\n') + '\n';
}
