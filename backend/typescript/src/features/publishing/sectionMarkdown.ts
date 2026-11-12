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
import { designSectionMarkdown } from '../cms/designSections.js';
import { pricingPlans } from '../cms/pricingPlans.js';
import { isFragmentHref, isInternalHref } from '../../host/internalHref.js';
import type { Section } from '../cms/cmsService.js';
import { vendorPublicBase } from '../featureRoute.js';
import { parseHeadingEmphasis } from './headingEmphasis.js';
import { heroArtMarkdown } from './heroArtText.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** ADR 0920 D3 — the hero's example plan card, every string in reading order. */
function planMarkdown(v: unknown): string {
  const p = obj(v);
  const lines = arr(p.lines).map(obj).filter((l) => str(l.label) || str(l.text))
    .map((l) => `- ${str(l.label) ? `**${str(l.label)}** ` : ''}${str(l.text)}`.trimEnd());
  const chips = arr(p.chips).map(str).filter(Boolean);
  return [
    str(p.eyebrow) ? `*${str(p.eyebrow)}*` : '',
    str(p.title) ? `**${str(p.title)}**` : '',
    str(p.meta), str(p.progressNote), str(p.stepEyebrow),
    str(p.stepTitle) ? `**${str(p.stepTitle)}**` : '',
    lines.join('\n'), str(p.action), chips.join(' · '), str(p.note), str(p.initial), str(p.bubble),
  ].filter(Boolean).join('\n\n');
}

/** ADR 1047 — the hero's hub picture: the centre, then one line per place. */
function hubMarkdown(v: unknown, baseUrl: string): string {
  const h = obj(v);
  const c = obj(h.center);
  const spokes = arr(h.spokes).map(obj).filter((sp) => str(sp.label))
    .map((sp) => `- ${str(sp.index) ? `${str(sp.index)} ` : ''}${str(sp.label)}`);
  if (!str(c.label) || spokes.length === 0) return '';
  const img = str(c.imageToken) ? `![${str(c.alt)}](${vendorPublicBase(baseUrl)}/assets/${encodeURIComponent(str(c.imageToken))})\n\n` : '';
  return `${img}**${str(c.eyebrow) ? `${str(c.eyebrow)} ` : ''}${str(c.label)}**\n\n${spokes.join('\n')}`;
}

/** ADR 1038 D8 — a flow's steps as a numbered list: label, status, text. */
function flowStepsMarkdown(nodes: Record<string, unknown>[]): string {
  return nodes.slice(0, 6).filter((n) => str(n.label))
    .map((n, i) => `${i + 1}. **${str(n.label)}**${str(n.status) ? ` (${str(n.status)})` : ''}${str(n.text) ? ` — ${str(n.text)}` : ''}`)
    .join('\n');
}

/** ADR 1029 D5 — the hero's activity card: the title, then one line per row,
 *  then the ADR 1038 `result` line. */
function activityMarkdown(v: unknown): string {
  const a = obj(v);
  const rows = arr(a.items).map(obj).filter((i) => str(i.action))
    .map((i) => `- ${str(i.actor) ? `**${str(i.actor)}** ` : ''}${str(i.action)}${str(i.status) ? ` — ${str(i.status)}` : ''}${str(i.meta) ? ` (${str(i.meta)})` : ''}`);
  if (rows.length === 0) return '';
  return [str(a.barLabel), str(a.title) ? `**${str(a.title)}**` : '', rows.join('\n'), str(a.result)].filter(Boolean).join('\n\n'); // ADR 1067 D3 — + barLabel
}

/** ADR 0920 D5 — a `richText` conversation picture as a quoted exchange. */
function chatMarkdown(v: unknown): string {
  const c = obj(v);
  const pr = obj(c.proposal);
  const proposal = [str(pr.label) ? `**${str(pr.label)}**` : '', str(pr.text)].filter(Boolean).join(' ');
  return [
    str(c.title) ? `**${str(c.title)}**` : '',
    str(c.subtitle), str(c.badge),
    ...arr(c.messages).map(obj).map((m) => str(m.text)).filter(Boolean).map((t) => `> ${t}`),
    proposal,
    [str(pr.accept), str(pr.decline)].filter(Boolean).join(' · '),
    str(c.placeholder),
  ].filter(Boolean).join('\n\n');
}

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
      // ADR 1038 D2 — a struck hero's marked words export as ~~struck~~, the meaning the visitor sees.
      if (heading) parts.push(`## ${d.emphasis === 'strike' ? parseHeadingEmphasis(heading).map((p) => (p.em ? `~~${p.text}~~` : p.text)).join('') : heading}`);
      if (eyebrow) parts.push(`*${eyebrow}*`);
      const sub = str(d.subheading);
      if (sub) parts.push(sub);
      if (str(d.body)) parts.push(str(d.body)); // ADR 1066 D2
      const ctas = [
        str(d.ctaLabel) && str(d.ctaUrl) ? `[${str(d.ctaLabel)}](${str(d.ctaUrl)})` : '',
        str(d.ctaLabel2) && str(d.ctaUrl2) ? `[${str(d.ctaLabel2)}](${str(d.ctaUrl2)})` : '',
      ].filter(Boolean);
      if (ctas.length > 0) parts.push(ctas.join(' · '));
      if (str(d.note)) parts.push(str(d.note));
      // ADR 0593 §C9 — only the picture visitors see (a hero keeps the data of a
      // visual the author switched away from).
      const visual = str(d.visual);
      const plan = visual === 'plan' ? planMarkdown(d.plan) : '';
      if (plan) parts.push(plan);
      const activity = visual === 'activity' ? activityMarkdown(d.activity) : '';
      if (activity) parts.push(activity);
      const hub = visual === 'hub' ? hubMarkdown(d.hub, baseUrl) : '';
      if (hub) parts.push(hub);
      // ADR 1038 D8 — the flow picture: its caption, then the steps.
      const fl = obj(d.flow);
      const flowSteps = visual === 'flow' ? flowStepsMarkdown(arr(fl.nodes).map(obj)) : '';
      if (flowSteps) parts.push([str(fl.label) ? `**${str(fl.label)}**` : '', flowSteps].filter(Boolean).join('\n\n'));
      // ADR 1060 — the illustrated visuals (receipt, …).
      const art = heroArtMarkdown(d);
      if (art) parts.push(art);
      return parts.join('\n\n');
    }
    case 'richText': {
      const chat = chatMarkdown(d.chat);
      const quote = str(d.quote) ? `> ${str(d.quote)}\n\n` : ''; // ADR 1073 D1
      // ADR 1074 D1 — the screenshot, only when it is the visual shown.
      const caption = str(d.caption);
      const shot = d.visual === 'image' && str(d.imageToken)
        ? `\n\n![${str(d.alt)}](${vendorPublicBase(baseUrl)}/assets/${encodeURIComponent(str(d.imageToken))})${caption ? `\n\n*${caption}*` : ''}`
        : '';
      return `${head()}${quote}${str(d.text)}${chat ? `\n\n${chat}` : ''}${shot}`;
    }
    case 'image': {
      const token = str(d.token);
      if (!token) return head().trim();
      const url = `${vendorPublicBase(baseUrl)}/assets/${encodeURIComponent(token)}`;
      const caption = str(d.caption);
      // ADR 1032 — an optional head and lede over the figure.
      const lede = str(d.lede);
      return `${head()}${lede ? `${lede}\n\n` : ''}![${str(d.alt)}](${url})${caption ? `\n\n*${caption}*` : ''}`;
    }
    case 'cta': {
      const label = str(d.label);
      // ADR 0836 D7 — re-checked at this exit too (it relied on the write-time
      // `safeLink` alone), with the same predicates as the HTML renderer.
      const raw = str(d.url).trim();
      const url = isInternalHref(raw) || isFragmentHref(raw) || /^(https?:|mailto:)/i.test(raw) ? raw : '';
      const note = str(d.note) ? `\n\n${str(d.note)}` : ''; // ADR 1062 D4
      return `${head()}${str(d.subheading) ? `${str(d.subheading)}\n\n` : ''}${label && url ? `[${label}](${url})` : ''}${note}`.trim();
    }
    case 'columns': {
      const cols = Array.isArray(d.columns) ? d.columns : [];
      if (str(d.layout) === 'flow') {
        const steps = flowStepsMarkdown(cols.map(obj).map((c) => ({ label: c.title, status: c.status, text: c.text })));
        return `${head()}${steps}${str(d.note) ? `\n\n${str(d.note)}` : ''}`;
      }
      const ordered = str(d.layout) === 'steps' || str(d.layout) === 'timeline' || str(d.layout) === 'incidents'; // ADR 1063 D3
      const items = cols.map((c, i) => {
        const cc = c as { title?: unknown; text?: unknown; eyebrow?: unknown; badge?: unknown; gauge?: unknown; items?: unknown; imageToken?: unknown; alt?: unknown; unit?: unknown; ctaLabel?: unknown; ctaUrl?: unknown; count?: unknown; countLabel?: unknown };
        // ADR 1069 D1 — a plan's price reads with its unit; its button is a link under it.
        const title = [str(cc.title), str(cc.unit)].filter(Boolean).join(' ');
        const cta = str(cc.ctaLabel) && str(cc.ctaUrl) ? `\n   [${str(cc.ctaLabel)}](${str(cc.ctaUrl)})` : '';
        const text = str(cc.text);
        const bullet = ordered ? `${i + 1}.` : '-';
        // ADR 0920 D4 — item label line + badge, and `list` rows nested under the item.
        const pre = [str(cc.eyebrow), str(cc.badge), str(cc.gauge)].filter(Boolean).map((x) => `*${x}* `).join(''); // ADR 1064 P3d — + gauge
        const rows = arr(cc.items).map(obj).filter((it) => str(it.label))
          .map((it) => `\n   - ${str(it.label)}${str(it.meta) ? ` (${str(it.meta)})` : ''}${str(it.aside) ? ` (${str(it.aside)})` : ''}`).join(''); // ADR 1071 D3 — + aside
        // ADR 1037 — an item's picture, nested under it.
        const img = str(cc.imageToken)
          ? `\n   ![${str(cc.alt)}](${vendorPublicBase(baseUrl)}/assets/${encodeURIComponent(str(cc.imageToken))})`
          : '';
        // ADR 1047 — a feature card's callout, pills (with their legend words)
        // and the folded disclosure, nested under the item.
        if (str(d.layout) === 'features') {
          const fx = cc as { callout?: unknown; tags?: unknown; more?: unknown };
          const co = obj(fx.callout);
          const lg = obj(d.tagLegend);
          const callout = str(co.text) ? `\n   ${str(co.label) ? `*${str(co.label)}* ` : ''}${str(co.text)}` : '';
          const pills = arr(fx.tags).map(obj).filter((tg) => str(tg.label)).map((tg) => {
            const w = str(tg.state) === 'now' ? str(lg.now) : str(tg.state) === 'soon' ? str(lg.soon) : '';
            return `\n   - ${str(tg.label)}${w ? ` (${w})` : ''}`;
          }).join('');
          const mo = obj(fx.more);
          const more = str(mo.text) ? `\n   ${str(mo.label) ? `*${str(mo.label)}* ` : ''}${str(mo.text).replace(/\n+/g, ' ')}` : '';
          return `${bullet} ${pre}${title ? `**${title}** — ` : ''}${text}${img}${callout}${pills}${more}`;
        }
        // ADR 1070 D2 — a labelled headline number, nested under the item.
        const stat = typeof cc.count === 'number' && str(cc.countLabel) ? `\n   ${cc.count} ${str(cc.countLabel)}` : '';
        return `${bullet} ${pre}${title ? `**${title}** — ` : ''}${text}${stat}${rows}${img}${cta}`;
      });
      const note = str(d.note);
      // ADR 1032 — a rows section's try-it switches, as the list they start as.
      const tg = obj(d.toggles);
      const tgItems = arr(tg.items).map(obj).filter((it) => str(it.label));
      const toggles = tgItems.length > 0
        ? `${str(tg.title) ? `*${str(tg.title)}*\n\n` : ''}${tgItems.map((it) => `- ${str(it.label)}`).join('\n')}\n\n`
        : '';
      // ADR 1068 D2 — the workflow diagram, as its ordered steps.
      const dg = obj(d.diagram);
      const dgNodes = arr(dg.nodes).map(obj).filter((n) => str(n.label));
      const diagram = dgNodes.length > 0
        ? `${dgNodes.map((n, i) => `${i + 1}. **${str(n.label)}**${str(n.text) ? ` ${str(n.text)}` : ''}`).join('\n')}\n\n${str(dg.caption) ? `*${str(dg.caption)}*\n\n` : ''}`
        : '';
      // ADR 1071 D1 — a feature head's headline number, as its words.
      const st = obj(d.stat);
      const stat = typeof st.value === 'number' && str(st.label) ? `${st.value} ${str(st.label)}\n\n` : '';
      return `${head()}${stat}${diagram}${toggles}${items.join('\n')}${note ? `\n\n${note}` : ''}`;
    }
    // Live-data sections: the markdown carries the section's own chrome and a
    // followable pointer — the data resolves client-side and is never baked
    // (the sectionHtml degradation rule).
    case 'productGrid':
      return `${head()}${str(d.storeOrgId) ? `[Shop](${baseUrl}/store/${encodeURIComponent(str(d.storeOrgId))})` : ''}`.trim();
    case 'form':
      // ADR 1068 D3 — the card's note under the form.
      return `${head()}${str(d.note)}`.trim();
    case 'pricing': {
      const blurb = str(d.blurb);
      const cta = str(d.ctaLabel) && str(d.ctaUrl) ? `[${str(d.ctaLabel)}](${str(d.ctaUrl)})` : '';
      // ADR 1069 D4 — authored plans: one `###` per plan, status, blurb, link.
      const plans = pricingPlans(d).map((p) => [
        `### ${p.name}`,
        ...(p.status ? [`*${p.status}*`] : []),
        ...(p.blurb ? [p.blurb] : []),
        ...(p.ctaLabel && p.ctaUrl ? [`[${p.ctaLabel}](${p.ctaUrl})`] : []),
      ].join('\n\n')).join('\n\n');
      return `${head()}${blurb ? `${blurb}\n\n` : ''}${plans ? `${plans}\n\n` : ''}${cta}`.trim();
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
    case 'video': {
      // ADR 0843 — the film's title + length, its description, and followable
      // links (the file, YouTube when authored). https-only, re-checked here.
      const https = (v: unknown): string => (/^https:\/\//i.test(str(v).trim()) ? str(v).trim() : '');
      const title = str(d.title);
      const length = str(d.length);
      const lede = str(d.lede);
      const links = [
        https(d.src) ? `[Watch the video](${https(d.src)})` : '',
        https(d.youtubeUrl) ? `[Watch on YouTube](${https(d.youtubeUrl)})` : '',
      ].filter(Boolean);
      // ADR 1032 — the second film, the same way, then the footnote.
      const f2 = obj(d.film2);
      const links2 = [
        https(f2.src) ? `[Watch the video](${https(f2.src)})` : '',
        https(f2.youtubeUrl) ? `[Watch on YouTube](${https(f2.youtubeUrl)})` : '',
      ].filter(Boolean);
      return [
        head().trim(),
        lede,
        title ? `**${title}**${length ? ` (${length})` : ''}` : '',
        str(d.caption), // ADR 1068 D1 — the visible caption
        str(d.description),
        links.join(' · '),
        str(f2.title) ? `**${str(f2.title)}**${str(f2.length) ? ` (${str(f2.length)})` : ''}` : '',
        str(f2.caption),
        str(f2.description),
        links2.join(' · '),
        str(d.note),
      ].filter(Boolean).join('\n\n');
    }
    case 'fields': {
      // ADR 0748 — flat named scalars (a protocol-authored section).
      const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
      return Object.entries(d).map(([k, v]) => [k, text(v)] as const).filter(([, v]) => v).map(([k, v]) => `- **${k}**: ${v}`).join('\n');
    }
    default:
      // ADR 1080 — the design section types; null for any other unknown type.
      return designSectionMarkdown(section.type, d, head());
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
