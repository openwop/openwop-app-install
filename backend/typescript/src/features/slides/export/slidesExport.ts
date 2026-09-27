/**
 * Slides export (ADR 0328 Phase 0+1) — the REAL `canvas.slides` exporters the
 * `export: ['slides','pdf']` facets promise: pptx via pptxgenjs, pdf via
 * pdfkit, both driven by the ONE shared geometry/theme module so the formats
 * cannot drift. Speaker notes land as real PPTX notes (and a notes page is
 * deliberately NOT added to the PDF — the PDF is the audience artifact).
 *
 * Image policy (ADR 0328 §5, SSRF-free): bytes are embedded ONLY for
 * host-served media assets (resolved internally via `resolveMediaAsset` —
 * zero network); any other `imageUrl` renders as a visible, layout-preserving
 * "linked image" placeholder carrying the URL as text.
 */
import PptxGenJS from 'pptxgenjs';
import PDFDocument from 'pdfkit';
import { OpenwopError } from '../../../types.js';
import { resolveMediaAsset, storeMediaAsset } from '../../../host/inMemorySurfaces.js';
import { getAppBrand } from '../../../host/systemBrand.js';
import { SLIDE_GEOMETRY, themeOf, brandPalette, assetTokenFromUrl, type SlideLayoutId, type NormalizedBox, type SlideThemePalette } from './slideGeometry.js';

export const SLIDES_EXPORT_FORMATS = ['pptx', 'pdf'] as const;
export type SlidesExportFormat = (typeof SLIDES_EXPORT_FORMATS)[number];
export function isSlidesExportFormat(v: unknown): v is SlidesExportFormat {
  return typeof v === 'string' && (SLIDES_EXPORT_FORMATS as readonly string[]).includes(v);
}

interface DeckSlide {
  layout?: unknown; title?: unknown; subtitle?: unknown; bullets?: unknown;
  attribution?: unknown; imageUrl?: unknown; notes?: unknown; name?: unknown;
  variant?: unknown; blocks?: unknown; background?: unknown;
}

interface Block { type?: unknown; props?: Record<string, unknown>; children?: unknown; hidden?: unknown }

/** ADR 0328 P3 — flatten a blocks slide into stacked text lines for export
 *  (text fidelity; images embed per the asset policy; charts render an HONEST
 *  placeholder naming the chart — real chart imaging is a recorded follow-up). */
interface FlatItem { kind: 'heading1' | 'heading2' | 'text' | 'muted' | 'bullets' | 'quote' | 'code' | 'image' | 'gap'; text?: string; items?: string[]; src?: unknown }
function flattenBlocks(blocks: unknown): FlatItem[] {
  const out: FlatItem[] = [];
  const sstr = (v: unknown): string => (typeof v === 'string' ? v : '');
  for (const b of Array.isArray(blocks) ? (blocks as Block[]) : []) {
    if (b.hidden === true) continue; // ADR 0344 2b — hidden blocks never export
    const p = b.props ?? {};
    switch (b.type) {
      case 'heading': out.push({ kind: sstr(p.level) === '1' ? 'heading1' : 'heading2', text: sstr(p.text) }); break;
      case 'text': out.push({ kind: sstr(p.tone) === 'muted' ? 'muted' : 'text', text: sstr(p.text) }); break;
      case 'bullets': out.push({ kind: 'bullets', items: Array.isArray(p.items) ? p.items.filter((x): x is string => typeof x === 'string') : [] }); break;
      case 'quote': out.push({ kind: 'quote', text: `“${sstr(p.text)}”${sstr(p.attribution) ? ` — ${sstr(p.attribution)}` : ''}` }); break;
      case 'callout': out.push({ kind: 'text', text: sstr(p.text) }); break;
      case 'code': out.push({ kind: 'code', text: sstr(p.text) }); break;
      case 'statCard': out.push({ kind: 'heading2', text: `${sstr(p.value)}${sstr(p.delta) ? ` (${sstr(p.delta)})` : ''}` }, { kind: 'muted', text: sstr(p.label) }); break;
      case 'table': { const cols = sstr(p.columns); if (cols) out.push({ kind: 'muted', text: cols }); const rows = sstr(p.rows); for (const line of rows.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12)) out.push({ kind: 'text', text: line }); break; }
      case 'chart': { let title = 'Chart'; try { const spec = JSON.parse(sstr(p.spec)); if (typeof spec?.title === 'string') title = spec.title; } catch { /* placeholder keeps the generic name */ } out.push({ kind: 'muted', text: `[${title} — see the live deck]` }); break; }
      case 'image': out.push({ kind: 'image', src: p.src }); break;
      case 'divider': case 'spacer': out.push({ kind: 'gap' }); break;
      default: break; // unknown types were rejected by validation; be lenient here
    }
  }
  return out;
}
interface Deck { title?: unknown; theme?: unknown; slides?: DeckSlide[] }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const layoutOf = (s: DeckSlide): SlideLayoutId =>
  (['title', 'title-bullets', 'section', 'quote', 'image', 'blank', 'blocks'] as const).includes(s.layout as SlideLayoutId)
    ? (s.layout as SlideLayoutId)
    : 'title-bullets';

type EmbeddableImage = { data: Buffer; contentType: string } | null;
/** Per-export resolve cache (GC-SL-4): the pre-flight estimate resolves each
 *  unique token ONCE; the renderers reuse the same entries — no double I/O. */
type ImageCache = Map<string, EmbeddableImage>;

/** Resolve an image to embeddable bytes (host assets only) or null. */
async function resolveEmbeddableImage(url: unknown, cache?: ImageCache): Promise<EmbeddableImage> {
  const token = assetTokenFromUrl(url);
  if (!token) return null;
  const hit = cache?.get(token);
  if (hit !== undefined) return hit;
  const entry = await resolveMediaAsset(token);
  const resolved: EmbeddableImage = entry && /^image\/(png|jpeg|gif|webp)$/.test(entry.contentType)
    ? { data: Buffer.from(entry.contentBase64, 'base64'), contentType: entry.contentType }
    : null;
  cache?.set(token, resolved);
  return resolved;
}

/** GC-SL-4 (grade pass 2026-07-10) — pre-flight size estimate, BEFORE the
 *  CPU/memory-heavy render commits the full buffer: embedded media dominate
 *  export size (slide text is schema-capped), so the estimate = the sum of
 *  every unique embeddable image's bytes + a per-slide overhead allowance.
 *  Rejecting here spends only row reads (which the render would spend
 *  anyway — the cache carries them forward). The post-render check remains
 *  the authoritative belt. */
const PER_SLIDE_OVERHEAD_BYTES = 64 * 1024;
async function estimateExportBytes(deck: Deck, cache: ImageCache): Promise<number> {
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  let imageBytes = 0;
  // Count per REFERENCE (the renderers embed one copy per addImage call, so a
  // deck referencing one asset 50 times produces ~50 embedded copies); the
  // cache still makes each unique token a single row read.
  const tally = async (url: unknown): Promise<void> => {
    const img = await resolveEmbeddableImage(url, cache);
    if (img) imageBytes += img.data.byteLength;
  };
  for (const s of slides) {
    await tally(s.imageUrl);
    for (const item of flattenBlocks(s.blocks)) {
      if (item.kind === 'image') await tally(item.src);
    }
  }
  return imageBytes + slides.length * PER_SLIDE_OVERHEAD_BYTES;
}

/* ── pptx ──────────────────────────────────────────────────────────────── */

const PPTX_W = 10; // inches (16:9)
const PPTX_H = 5.625;
const inch = (b: NormalizedBox): { x: number; y: number; w: number; h: number } =>
  ({ x: b.x * PPTX_W, y: b.y * PPTX_H, w: b.w * PPTX_W, h: b.h * PPTX_H });

export async function renderDeckToPptx(deck: Deck, palette?: SlideThemePalette, cache?: ImageCache): Promise<Buffer> {
  const theme = palette ?? themeOf(deck.theme);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: PPTX_W, height: PPTX_H });
  pptx.layout = 'WIDE';
  pptx.title = str(deck.title) || 'Deck';
  const fontFace = theme.font === 'times' ? 'Georgia' : 'Helvetica';

  for (const s of deck.slides ?? []) {
    const layout = layoutOf(s);
    const g = SLIDE_GEOMETRY[layout];
    const slide = pptx.addSlide();
    // ADR 0328 Phase 2 — the closed per-slide background accent: bg/ink swap.
    const accented = (s as { background?: unknown }).background === 'accent';
    const bg = accented ? theme.accent : theme.bg;
    const ink = accented ? theme.bg : theme.ink;
    slide.background = { color: bg };

    if (layout === 'blocks') {
      // ADR 0328 P3 — stacked flow: walk the flattened blocks down the slide.
      let y = 0.07 * PPTX_H;
      const x = 0.07 * PPTX_W, w = 0.86 * PPTX_W;
      for (const item of flattenBlocks(s.blocks)) {
        if (y > PPTX_H * 0.92) break; // overflow: clip honestly
        if (item.kind === 'gap') { y += 0.2; continue; }
        if (item.kind === 'image') {
          const img = await resolveEmbeddableImage(item.src, cache);
          const h = 1.6;
          if (img) slide.addImage({ data: `data:${img.contentType};base64,${img.data.toString('base64')}`, x, y, w, h });
          else if (typeof item.src === 'string' && item.src) slide.addText(`Linked image:\n${item.src.slice(0, 160)}`, { x, y, w, h, fontSize: 11, color: theme.muted, align: 'center', valign: 'middle', fontFace, line: { color: theme.muted, width: 1, dashType: 'dash' } });
          y += 1.7; continue;
        }
        if (item.kind === 'bullets') {
          const items = item.items ?? [];
          slide.addText(items.map((t2) => ({ text: t2, options: { bullet: { code: '2022' }, color: ink, fontSize: 16, fontFace, breakLine: true } })), { x, y, w, h: Math.min(0.32 * items.length, PPTX_H - y - 0.2), valign: 'top' });
          y += 0.32 * items.length + 0.1; continue;
        }
        const style = item.kind === 'heading1' ? { fontSize: 34, bold: true, color: ink }
          : item.kind === 'heading2' ? { fontSize: 24, bold: true, color: ink }
          : item.kind === 'quote' ? { fontSize: 20, italic: true, color: theme.accent }
          : item.kind === 'code' ? { fontSize: 13, color: ink, fontFace: 'Courier New' }
          : item.kind === 'muted' ? { fontSize: 13, color: theme.muted }
          : { fontSize: 16, color: ink };
        const lines = Math.max(1, Math.ceil((item.text ?? '').length / 90));
        const h = 0.05 + 0.028 * (style.fontSize as number) * 0.35 * lines;
        slide.addText(item.text ?? '', { x, y, w, h, fontFace: (style as { fontFace?: string }).fontFace ?? fontFace, valign: 'top', ...style });
        y += h + 0.08;
      }
      if (str(s.notes)) slide.addNotes(str(s.notes));
      continue;
    }
    if (g.title && str(s.title)) {
      slide.addText(str(s.title), {
        ...inch(g.title), fontSize: g.title.size, bold: g.title.bold ?? false,
        color: ink, align: g.title.align ?? 'left', fontFace, valign: 'top',
      });
    }
    if (g.secondary) {
      const secondaryText = layout === 'quote' ? str(s.attribution) : str(s.subtitle);
      if (secondaryText) {
        slide.addText(layout === 'quote' ? `— ${secondaryText}` : secondaryText, {
          ...inch(g.secondary), fontSize: g.secondary.size, color: theme.muted,
          align: g.secondary.align ?? 'left', italic: g.secondary.italic ?? false, fontFace, valign: 'top',
        });
      }
    }
    if (g.bullets && Array.isArray(s.bullets) && s.bullets.length) {
      slide.addText(
        s.bullets.filter((b): b is string => typeof b === 'string').map((b) => ({
          text: b, options: { bullet: { code: '2022' }, color: ink, fontSize: g.bullets!.size, fontFace, breakLine: true },
        })),
        { ...inch(g.bullets), valign: 'top' },
      );
    }
    if (g.quote && str(s.title)) {
      slide.addText(`“${str(s.title)}”`, {
        ...inch(g.quote), fontSize: g.quote.size, color: theme.accent, italic: true, fontFace, valign: 'top',
      });
    }
    if (g.image) {
      const img = await resolveEmbeddableImage(s.imageUrl, cache);
      if (img) {
        slide.addImage({ data: `data:${img.contentType};base64,${img.data.toString('base64')}`, ...inch(g.image) });
      } else if (str(s.imageUrl)) {
        // Layout-preserving linked-image placeholder (never fetched).
        slide.addText(`Linked image:\n${str(s.imageUrl).slice(0, 200)}`, {
          ...inch(g.image), fontSize: 12, color: theme.muted, align: 'center', valign: 'middle', fontFace,
          fill: { color: theme.bg }, line: { color: theme.muted, width: 1, dashType: 'dash' },
        });
      }
    }
    if (str(s.notes)) slide.addNotes(str(s.notes));
  }

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return out;
}

/* ── pdf ───────────────────────────────────────────────────────────────── */

const PDF_W = 960; // points (16:9)
const PDF_H = 540;
const pts = (b: NormalizedBox): { x: number; y: number; w: number; h: number } =>
  ({ x: b.x * PDF_W, y: b.y * PDF_H, w: b.w * PDF_W, h: b.h * PDF_H });
const hex = (c: string): string => `#${c}`;

export async function renderDeckToPdf(deck: Deck, palette?: SlideThemePalette, cache?: ImageCache): Promise<Buffer> {
  const theme = palette ?? themeOf(deck.theme);
  const font = theme.font === 'times' ? 'Times-Roman' : 'Helvetica';
  const fontBold = theme.font === 'times' ? 'Times-Bold' : 'Helvetica-Bold';
  const fontItalic = theme.font === 'times' ? 'Times-Italic' : 'Helvetica-Oblique';

  const doc = new PDFDocument({ size: [PDF_W, PDF_H], margin: 0, autoFirstPage: false, info: { Title: str(deck.title) || 'Deck' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  for (const s of deck.slides ?? []) {
    const layout = layoutOf(s);
    const g = SLIDE_GEOMETRY[layout];
    doc.addPage({ size: [PDF_W, PDF_H], margin: 0 });
    const accented = (s as { background?: unknown }).background === 'accent';
    const bg = accented ? theme.accent : theme.bg;
    const ink = accented ? theme.bg : theme.ink;
    doc.rect(0, 0, PDF_W, PDF_H).fill(hex(bg));

    if (layout === 'blocks') {
      let y = 40;
      const x = 64, w = PDF_W - 128;
      for (const item of flattenBlocks(s.blocks)) {
        if (y > PDF_H - 50) break;
        if (item.kind === 'gap') { y += 18; continue; }
        if (item.kind === 'image') {
          const img = await resolveEmbeddableImage(item.src, cache);
          const h = 150;
          if (img && /^image\/(png|jpeg)$/.test(img.contentType)) { try { doc.image(img.data, x, y, { fit: [w, h], align: 'center' }); } catch { drawImagePlaceholder(doc, { x, y, w, h }, String(item.src ?? ''), theme.muted, font); } }
          else if (typeof item.src === 'string' && item.src) drawImagePlaceholder(doc, { x, y, w, h }, item.src, theme.muted, font);
          y += h + 12; continue;
        }
        if (item.kind === 'bullets') {
          const items = item.items ?? [];
          doc.font(font).fontSize(15).fillColor(hex(ink)).list(items, x, y, { width: w, bulletRadius: 2.5, textIndent: 16 });
          y = doc.y + 8; continue;
        }
        const st = item.kind === 'heading1' ? { size: 32, f: fontBold, c: ink }
          : item.kind === 'heading2' ? { size: 22, f: fontBold, c: ink }
          : item.kind === 'quote' ? { size: 19, f: fontItalic, c: theme.accent }
          : item.kind === 'code' ? { size: 12, f: 'Courier', c: ink }
          : item.kind === 'muted' ? { size: 12, f: font, c: theme.muted }
          : { size: 15, f: font, c: ink };
        doc.font(st.f).fontSize(st.size).fillColor(hex(st.c)).text(item.text ?? '', x, y, { width: w });
        y = doc.y + 8;
      }
      continue;
    }
    if (g.title && str(s.title)) {
      const b = pts(g.title);
      doc.font(g.title.bold ? fontBold : font).fontSize(g.title.size).fillColor(hex(ink))
        .text(str(s.title), b.x, b.y, { width: b.w, height: b.h, align: g.title.align ?? 'left', ellipsis: true });
    }
    if (g.secondary) {
      const secondaryText = layout === 'quote' ? str(s.attribution) : str(s.subtitle);
      if (secondaryText) {
        const b = pts(g.secondary);
        doc.font(g.secondary.italic ? fontItalic : font).fontSize(g.secondary.size).fillColor(hex(theme.muted))
          .text(layout === 'quote' ? `— ${secondaryText}` : secondaryText, b.x, b.y, { width: b.w, height: b.h, align: g.secondary.align ?? 'left', ellipsis: true });
      }
    }
    if (g.bullets && Array.isArray(s.bullets) && s.bullets.length) {
      const b = pts(g.bullets);
      const items = s.bullets.filter((x): x is string => typeof x === 'string');
      doc.font(font).fontSize(g.bullets.size).fillColor(hex(ink))
        .list(items, b.x, b.y, { width: b.w, bulletRadius: 2.5, textIndent: 18 });
    }
    if (g.quote && str(s.title)) {
      const b = pts(g.quote);
      doc.font(fontItalic).fontSize(g.quote.size).fillColor(hex(theme.accent))
        .text(`“${str(s.title)}”`, b.x, b.y, { width: b.w, height: b.h, ellipsis: true });
    }
    if (g.image) {
      const b = pts(g.image);
      const img = await resolveEmbeddableImage(s.imageUrl, cache);
      if (img && /^image\/(png|jpeg)$/.test(img.contentType)) {
        try {
          doc.image(img.data, b.x, b.y, { fit: [b.w, b.h], align: 'center', valign: 'center' });
        } catch {
          drawImagePlaceholder(doc, b, str(s.imageUrl), theme.muted, font);
        }
      } else if (str(s.imageUrl)) {
        drawImagePlaceholder(doc, b, str(s.imageUrl), theme.muted, font);
      }
    }
  }

  doc.end();
  return done;
}

function drawImagePlaceholder(doc: PDFKit.PDFDocument, b: { x: number; y: number; w: number; h: number }, url: string, mutedHex: string, font: string): void {
  doc.save().rect(b.x, b.y, b.w, b.h).dash(6, { space: 4 }).stroke(hex(mutedHex)).undash().restore();
  doc.font(font).fontSize(12).fillColor(hex(mutedHex))
    .text(`Linked image:\n${url.slice(0, 200)}`, b.x + 12, b.y + b.h / 2 - 16, { width: b.w - 24, align: 'center' });
}

/* ── the export verb's storage step ────────────────────────────────────── */

const EXPORT_TTL_SECONDS = 60 * 60; // 1 hour — same posture as code-export
const MAX_EXPORT_BYTES = 25 * 1024 * 1024;

export interface SlidesExportResult {
  assetToken: string;
  serveUrl: string;
  fileName: string;
  sizeBytes: number;
}

const slug = (s: string): string => (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck').slice(0, 60);

async function effectivePalette(deck: Deck): Promise<SlideThemePalette> {
  if (deck.theme !== 'brand') return themeOf(deck.theme);
  // ADR 0328 Phase 2 — 'brand' resolves the HOST app identity server-side
  // (hex-validated per channel; the renderer's CSS inherits app tokens).
  try {
    const brand = await getAppBrand();
    return brandPalette(brand.identity?.colors);
  } catch {
    return themeOf('default');
  }
}

export async function exportSlides(tenantId: string, state: unknown, format: SlidesExportFormat): Promise<SlidesExportResult> {
  const deck = (state ?? {}) as Deck;
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
    throw new OpenwopError('validation_error', 'This canvas is not an exportable deck (needs at least one slide).', 422);
  }
  const palette = await effectivePalette(deck);
  // GC-SL-4 — reject an over-cap deck BEFORE the render commits CPU + the
  // full output buffer; the resolve cache carries the image reads forward.
  const imageCache: ImageCache = new Map();
  const estimated = await estimateExportBytes(deck, imageCache);
  if (estimated > MAX_EXPORT_BYTES) {
    throw new OpenwopError('validation_error', `Export would exceed the ${Math.floor(MAX_EXPORT_BYTES / (1024 * 1024))} MiB cap (estimated ${Math.ceil(estimated / (1024 * 1024))} MiB of embedded media).`, 413);
  }
  const buffer = format === 'pptx' ? await renderDeckToPptx(deck, palette, imageCache) : await renderDeckToPdf(deck, palette, imageCache);
  if (buffer.byteLength > MAX_EXPORT_BYTES) {
    throw new OpenwopError('validation_error', `Export exceeds the ${Math.floor(MAX_EXPORT_BYTES / (1024 * 1024))} MiB cap.`, 413);
  }
  const contentType = format === 'pptx'
    ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    : 'application/pdf';
  const stored = await storeMediaAsset(tenantId, { contentBase64: buffer.toString('base64'), contentType, ttlSeconds: EXPORT_TTL_SECONDS });
  return {
    assetToken: stored.token,
    serveUrl: stored.url,
    fileName: `${slug(str(deck.title))}.${format}`,
    sizeBytes: stored.bytes,
  };
}
