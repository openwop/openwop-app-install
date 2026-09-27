/**
 * Slides export — the ONE per-layout geometry + theme-palette source shared by
 * the pptx (pptxgenjs) and pdf (pdfkit) renderers, so the two formats cannot
 * drift (ADR 0328 §3). All boxes are NORMALIZED (0..1 of a 16:9 slide); each
 * renderer scales to its native units (pptx: 10×5.625 in, pdf: 960×540 pt).
 *
 * Text-fidelity contract for the CURRENT 6-layout model: title/subtitle/
 * bullets/quote/attribution/notes + one image region on the `image` layout.
 * The Phase-3 block model will extend this module, not fork it.
 */

export type SlideLayoutId = 'title' | 'title-bullets' | 'section' | 'quote' | 'image' | 'blank' | 'blocks';

export interface NormalizedBox { x: number; y: number; w: number; h: number }

export interface LayoutGeometry {
  /** The primary title/heading box, when the layout has one. */
  title?: NormalizedBox & { size: number; bold?: boolean; align?: 'left' | 'center' };
  /** Secondary text (subtitle / attribution). */
  secondary?: NormalizedBox & { size: number; align?: 'left' | 'center'; italic?: boolean };
  /** The bullets region (title-bullets). */
  bullets?: NormalizedBox & { size: number };
  /** The quote body (quote layout — rendered larger, italic). */
  quote?: NormalizedBox & { size: number };
  /** The image region (image layout). */
  image?: NormalizedBox;
}

/** Font sizes are POINTS at 16:9 (pptx uses them directly; pdf scales ×1.0 —
 *  540pt-high pages make 1pt ≈ 1pt visually consistent with pptx's 5.625in). */
export const SLIDE_GEOMETRY: Record<SlideLayoutId, LayoutGeometry> = {
  title: {
    title: { x: 0.08, y: 0.34, w: 0.84, h: 0.18, size: 40, bold: true, align: 'center' },
    secondary: { x: 0.14, y: 0.54, w: 0.72, h: 0.12, size: 20, align: 'center' },
  },
  'title-bullets': {
    title: { x: 0.06, y: 0.06, w: 0.88, h: 0.13, size: 28, bold: true, align: 'left' },
    bullets: { x: 0.08, y: 0.24, w: 0.84, h: 0.66, size: 18 },
  },
  section: {
    title: { x: 0.08, y: 0.42, w: 0.84, h: 0.16, size: 34, bold: true, align: 'left' },
  },
  quote: {
    quote: { x: 0.12, y: 0.28, w: 0.76, h: 0.34, size: 26 },
    secondary: { x: 0.12, y: 0.66, w: 0.76, h: 0.08, size: 16, align: 'left', italic: true },
  },
  image: {
    title: { x: 0.06, y: 0.05, w: 0.88, h: 0.11, size: 24, bold: true, align: 'left' },
    image: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 },
  },
  blank: {},
  // ADR 0328 P3 — blocks slides use the stacked-flow path, not fixed boxes.
  blocks: {},
};

export interface SlideThemePalette {
  /** Slide background. */
  bg: string;
  /** Primary text. */
  ink: string;
  /** Accent (section bars, quote marks, bullets). */
  accent: string;
  /** Muted/secondary text. */
  muted: string;
  /** Body font face hint (portable names both renderers have). */
  font: 'helvetica' | 'times';
}

/** The 5 schema themes (`artifactTypes.ts` enum). Mirrored by the renderer CSS
 *  (`.canvas-slides[data-theme=…]` in global.css) — the dual-list-by-package
 *  convention; the export test pins the theme SET against the schema enum. */
export const SLIDE_THEMES: Record<string, SlideThemePalette> = {
  default: { bg: 'FFFFFF', ink: '1F2430', accent: '2563EB', muted: '6B7280', font: 'helvetica' },
  light: { bg: 'F8FAFC', ink: '111827', accent: '0EA5E9', muted: '64748B', font: 'helvetica' },
  dark: { bg: '111827', ink: 'F9FAFB', accent: '60A5FA', muted: '9CA3AF', font: 'helvetica' },
  editorial: { bg: 'FAF7F0', ink: '1C1917', accent: '9A3412', muted: '78716C', font: 'times' },
  vibrant: { bg: '0F0A2E', ink: 'FFFFFF', accent: 'F59E0B', muted: 'C4B5FD', font: 'helvetica' },
};

// 'brand' resolves at EXPORT time from the host app brand (hex-validated per
// channel; non-hex brand values fall back per channel) — the renderer's
// [data-theme='brand'] CSS inherits the app tokens instead.
SLIDE_THEMES['brand'] = { ...SLIDE_THEMES['default']! };

const HEX6 = /^#([0-9a-fA-F]{6})$/;
/** Overlay hex-only brand colors onto the default palette (channel-wise). */
export function brandPalette(colors: Partial<Record<string, string>> | undefined): SlideThemePalette {
  const base = { ...SLIDE_THEMES['default']! };
  const pick = (v: string | undefined): string | null => {
    const m = typeof v === 'string' ? HEX6.exec(v.trim()) : null;
    return m ? m[1]!.toUpperCase() : null;
  };
  const paper = pick(colors?.paper); if (paper) base.bg = paper;
  const ink = pick(colors?.ink); if (ink) base.ink = ink;
  const accent = pick(colors?.accent); if (accent) base.accent = accent;
  const ink2 = pick(colors?.ink2); if (ink2) base.muted = ink2;
  return base;
}

export function themeOf(theme: unknown): SlideThemePalette {
  return SLIDE_THEMES[typeof theme === 'string' ? theme : 'default'] ?? SLIDE_THEMES['default']!;
}

/** The host asset-serve path prefix — the ONLY image source whose bytes the
 *  exporters embed (resolved internally, zero network — the ADR 0328 §5 SSRF
 *  posture). Everything else renders as a linked-image placeholder. */
export const ASSET_SERVE_PREFIX = '/v1/host/openwop-app/assets/';

export function assetTokenFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const idx = url.indexOf(ASSET_SERVE_PREFIX);
  if (idx === -1) return null;
  const token = url.slice(idx + ASSET_SERVE_PREFIX.length).split(/[?#]/)[0] ?? '';
  return /^[A-Za-z0-9_-]{8,}$/.test(token) ? token : null;
}
