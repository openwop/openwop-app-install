/**
 * Deterministic ad renderer (ADR 0399 §2) — pure function from
 * `(template, resolved layer content, brand tokens, overrides)` to a composed
 * SVG document and rasterized PNG bytes via `@resvg/resvg-js`.
 *
 * The same-pixels guarantee: identical inputs ⇒ identical bytes. Everything
 * variable is an INPUT — no wall-clock, no RNG, no locale-dependent shaping,
 * fonts from the embedded buffers only (`loadSystemFonts: false` — system
 * fonts differ per machine and are the classic determinism breaker), and layer
 * imagery arrives as content-hashed `data:` URIs resolved host-side by the
 * caller (never a render-time fetch — determinism + SSRF).
 *
 * The SVG is a server-internal intermediate ONLY: `image/svg+xml` is excluded
 * from the storable media mimes (stored-XSS guard in `allowedUploadMime.ts`),
 * so the PNG is the sole persisted artifact and the frontend draws safe-zone
 * overlays from template geometry JSON, not from this SVG.
 */

// Namespace import + runtime pick — gifenc is a dual-package (CJS for Node's
// loader, ESM for vite); named imports boot-crash the production bundle and a
// bare default import breaks under vitest (see gifenc.d.ts note).
import * as gifencNs from 'gifenc';

// Named-exports-first: the ESM build (vite/vitest) has them AND a function-
// valued `default`; the CJS build under Node's loader has NO named exports
// (non-analyzable) and everything on `default`. Feature-detect, don't guess.
const { GIFEncoder, quantize, applyPalette } =
  typeof gifencNs.GIFEncoder === 'function' ? gifencNs : (gifencNs.default ?? gifencNs);
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';

/** resvg-js 2.6.2 supports `fontBuffers` in the native binding but omits it
 *  from the published typings — widen structurally (assignable because excess
 *  property checks apply only to fresh literals). Drop when upstream catches up. */
type RenderOptionsWithFontBuffers = Omit<ResvgRenderOptions, 'font'> & {
  font?: NonNullable<ResvgRenderOptions['font']> & { fontBuffers?: Buffer[] };
};
import { bundledFontBuffers, BUNDLED_FONT_FAMILIES, BUNDLED_FONTS_VERSION } from './fonts.js';
import type { AdLayoutTemplate, AdLayerId, BrandColorToken, TemplateLayer } from './templates.js';

/** Bump on ANY behavior change in this module (layout math, wrap estimator,
 *  SVG emission) or a `@resvg/resvg-js` version bump — it enters the composite
 *  render hash so an upgraded renderer never silently re-pixels old renders. */
export const RENDERER_VERSION = `adrender-1.0.0+resvg-2.6.2+${BUNDLED_FONTS_VERSION}`;

/** A host-resolved raster image for one layer slot (bytes already tenant-checked). */
export interface ResolvedLayerImage {
  /** `data:image/png;base64,...` — png/jpeg/gif only (what resvg decodes). */
  dataUri: string;
  /** sha256 of the source bytes — pins the composite hash. */
  sha256: string;
}

export interface ResolvedRenderContent {
  images: Partial<Record<AdLayerId, ResolvedLayerImage>>;
  texts: Partial<Record<AdLayerId, string>>;
}

export interface BrandRenderTokens {
  colors: Record<BrandColorToken, string>;
  /** Bundled family per role — brand stacks are nearest-matched upstream. */
  fontFamilies: { sans: string; serif: string };
}

/** Bounded per-layer nudge (ADR 0399 §7) — deterministic, clamped, hashed. */
export interface LayerNudge {
  dx?: number;
  dy?: number;
  scale?: number;
}

export interface RenderWarning {
  code: string;
  layerId?: string;
  message: string;
  /** Safe-zone overlap percentage (0–100), when code === 'safe-zone-overlap'. */
  overlapPct?: number;
  safeZoneId?: string;
}

export interface ComposedAd {
  svg: string;
  png: Buffer;
  warnings: RenderWarning[];
  /** Post-nudge layer bounding boxes (px) — the safe-zone check input (P2). */
  layerBboxes: Array<{ layerId: AdLayerId; kind: TemplateLayer['kind']; x: number; y: number; w: number; h: number }>;
}

/** Nudge clamp: ±10% of the canvas' smaller dimension; scale 0.8–1.25. */
const NUDGE_SCALE_MIN = 0.8;
const NUDGE_SCALE_MAX = 1.25;

/** Deterministic average-advance estimate per font role/weight, as a fraction
 *  of sizePx. An ESTIMATE for greedy wrapping only (resvg does the real
 *  shaping) — constants, so wrapping is a pure function of the string. */
const AVG_CHAR_W: Record<'sans' | 'serif', Record<400 | 700, number>> = {
  sans: { 400: 0.5, 700: 0.54 },
  serif: { 400: 0.49, 700: 0.53 },
};

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Only #hex colors may enter the SVG (attribute-injection guard — brand and
 *  brief palettes are user-authored strings). */
export function isSafeSvgColor(c: unknown): c is string {
  return typeof c === 'string' && HEX_COLOR_RE.test(c);
}

export function clampNudge(raw: LayerNudge | undefined, template: AdLayoutTemplate): Required<LayerNudge> {
  const limit = Math.round(Math.min(template.width, template.height) * 0.1);
  const clamp = (v: number | undefined, lo: number, hi: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return lo <= 0 && hi >= 0 ? 0 : lo;
    return Math.max(lo, Math.min(hi, v));
  };
  return {
    dx: Math.round(clamp(raw?.dx, -limit, limit)),
    dy: Math.round(clamp(raw?.dy, -limit, limit)),
    scale: clamp(raw?.scale ?? 1, NUDGE_SCALE_MIN, NUDGE_SCALE_MAX),
  };
}

/** Apply a clamped nudge to a layer box (scale about the box center). */
function nudgedBox(layer: TemplateLayer, nudge: Required<LayerNudge>): { x: number; y: number; w: number; h: number } {
  const { x, y, w, h } = layer.box;
  const nw = Math.round(w * nudge.scale);
  const nh = Math.round(h * nudge.scale);
  return {
    x: Math.round(x + (w - nw) / 2 + nudge.dx),
    y: Math.round(y + (h - nh) / 2 + nudge.dy),
    w: nw,
    h: nh,
  };
}

/** Greedy word wrap against the deterministic width estimate. Overlong words
 *  hard-split; overflow beyond maxLines is dropped with an ellipsis on the
 *  last line (and reported by the caller as a warning). */
export function wrapText(text: string, opts: { widthPx: number; sizePx: number; fontRole: 'sans' | 'serif'; weight: 400 | 700; maxLines: number }): { lines: string[]; truncated: boolean } {
  const avg = AVG_CHAR_W[opts.fontRole][opts.weight] * opts.sizePx;
  const maxChars = Math.max(1, Math.floor(opts.widthPx / avg));
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';
  for (let word of words) {
    while (word.length > maxChars) {
      if (current) { lines.push(current); current = ''; }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > opts.maxLines) {
    const kept = lines.slice(0, opts.maxLines);
    const last = kept[opts.maxLines - 1] ?? '';
    kept[opts.maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
    return { lines: kept, truncated: true };
  }
  return { lines, truncated: false };
}

export interface RenderAdInput {
  template: AdLayoutTemplate;
  content: ResolvedRenderContent;
  brand: BrandRenderTokens;
  overrides?: Partial<Record<AdLayerId, LayerNudge>>;
  /** ADR 0399 OQ-1 — attested brand-font buffers appended to the resvg set
   *  (after the bundled fonts); the SVG references them by their real family. */
  extraFontBuffers?: Buffer[];
}

/** Compose the deterministic SVG document (no rasterization — see renderAd).
 *  `opts.revealProgress` (0..1, ADR 0399 OQ-2) fades the FOREGROUND (everything
 *  over the background image) in for the animated-GIF "reveal" preset; the
 *  background stays put. Omitted ⇒ a full static frame (byte-identical to before). */
export function composeAdSvg(input: RenderAdInput, opts?: { revealProgress?: number }): { svg: string; warnings: RenderWarning[]; layerBboxes: ComposedAd['layerBboxes'] } {
  const { template, content, brand } = input;
  const warnings: RenderWarning[] = [];
  const layerBboxes: ComposedAd['layerBboxes'] = [];
  const bgParts: string[] = [];
  const fgParts: string[] = [];
  const color = (token: BrandColorToken): string => brand.colors[token];
  const push = (layerId: AdLayerId, part: string): void => { (layerId === 'background' ? bgParts : fgParts).push(part); };

  const layers = [...template.layers].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  for (const layer of layers) {
    const nudge = clampNudge(input.overrides?.[layer.id], template);
    const box = nudgedBox(layer, nudge);

    if (layer.kind === 'image') {
      const img = content.images[layer.id];
      if (!img) {
        if (layer.id !== 'logo' && layer.id !== 'product') {
          warnings.push({ code: 'missing-layer-image', layerId: layer.id, message: `No image resolved for the '${layer.id}' layer — slot left empty.` });
        }
        continue;
      }
      const fit = layer.fit ?? 'cover';
      const preserve = fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
      const clipId = `clip-${layer.id}`;
      if (layer.radiusPx) {
        push(layer.id, `<clipPath id="${clipId}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${layer.radiusPx}"/></clipPath>`);
      }
      const clipAttr = layer.radiusPx ? ` clip-path="url(#${clipId})"` : '';
      push(layer.id, `<image x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" preserveAspectRatio="${preserve}" href="${img.dataUri}"${clipAttr}/>`);
      layerBboxes.push({ layerId: layer.id, kind: layer.kind, ...box });
      continue;
    }

    if (layer.kind === 'shape') {
      const fill = color(layer.fill ?? 'ink');
      const opacity = layer.opacity !== undefined ? ` fill-opacity="${layer.opacity}"` : '';
      push(layer.id, `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"${layer.radiusPx ? ` rx="${layer.radiusPx}"` : ''} fill="${fill}"${opacity}/>`);
      layerBboxes.push({ layerId: layer.id, kind: layer.kind, ...box });
      continue;
    }

    // Text layer.
    const text = content.texts[layer.id];
    const style = layer.type;
    if (!text || !style) continue;
    const pad = layer.padPx ?? 0;
    const innerW = Math.max(1, box.w - pad * 2);
    const { lines, truncated } = wrapText(text, { widthPx: innerW, sizePx: style.sizePx, fontRole: style.fontRole, weight: style.weight, maxLines: style.maxLines });
    if (truncated) {
      warnings.push({ code: 'text-truncated', layerId: layer.id, message: `Text for '${layer.id}' exceeds ${style.maxLines} line(s) at this size and was truncated.` });
    }
    if (lines.length === 0) continue;
    // A filled text layer (the CTA pill) draws its own background first.
    if (layer.fill) {
      push(layer.id, `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"${layer.radiusPx ? ` rx="${layer.radiusPx}"` : ''} fill="${color(layer.fill)}"/>`);
    }
    const family = style.fontRole === 'serif' ? brand.fontFamilies.serif : brand.fontFamilies.sans;
    const lineH = Math.round(style.sizePx * (style.lineHeight ?? 1.2));
    const blockH = lineH * lines.length;
    // Vertically center the line block in the box; text-anchor handles x-align.
    const firstBaseline = Math.round(box.y + (box.h - blockH) / 2 + style.sizePx * 0.9);
    const anchorX = style.align === 'start' ? box.x + pad : style.align === 'end' ? box.x + box.w - pad : box.x + Math.round(box.w / 2);
    const spans = lines
      .map((line, i) => `<tspan x="${anchorX}" y="${firstBaseline + i * lineH}">${escapeXml(line)}</tspan>`)
      .join('');
    push(layer.id, `<text font-family="${escapeXml(family)}" font-size="${style.sizePx}" font-weight="${style.weight}" text-anchor="${style.align}" fill="${color(style.color)}">${spans}</text>`);
    // Text bbox = the ESTIMATED occupied block (not the slot) — safe-zone
    // checks care about where glyphs actually sit.
    const estW = Math.min(innerW, Math.max(...lines.map((l) => Math.round(l.length * AVG_CHAR_W[style.fontRole][style.weight] * style.sizePx))));
    const estX = style.align === 'start' ? anchorX : style.align === 'end' ? anchorX - estW : anchorX - Math.round(estW / 2);
    layerBboxes.push({ layerId: layer.id, kind: layer.kind, x: estX, y: firstBaseline - style.sizePx, w: estW, h: blockH });
  }

  const reveal = opts?.revealProgress;
  const fg = reveal !== undefined && reveal < 1
    ? `<g opacity="${Math.max(0, Math.min(1, reveal)).toFixed(3)}">${fgParts.join('')}</g>`
    : fgParts.join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${template.width}" height="${template.height}" viewBox="0 0 ${template.width} ${template.height}"><rect width="${template.width}" height="${template.height}" fill="${color('paper')}"/>${bgParts.join('')}${fg}</svg>`;
  return { svg, warnings, layerBboxes };
}

/** Deterministic ease (smoothstep) for the reveal — pure. */
function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

export interface AnimateOptions {
  /** The only preset in v1: the foreground fades in over the frames. */
  preset: 'reveal';
  /** Total frames (clamped 2–30). */
  frames: number;
  /** Frames per second (clamped 2–24). */
  fps: number;
}

export interface ComposedAnimation {
  gif: Buffer;
  warnings: RenderWarning[];
  layerBboxes: ComposedAd['layerBboxes'];
  frames: number;
  fps: number;
}

/** Safe bounds for an animation request — a frame is a full resvg rasterization,
 *  so `frames` bounds the CPU an animate:true render may spend. */
export const ANIMATE_BOUNDS = { minFrames: 2, maxFrames: 30, minFps: 2, maxFps: 24 } as const;

/**
 * Clamp a caller's animation request into {@link ANIMATE_BOUNDS}.
 *
 * Split out of `renderAnimatedGif` so the bounds are assertable WITHOUT paying
 * for a rasterization: asserting the max clamp end-to-end means rendering the
 * worst case (30 frames), which took ~14s of a 15s test budget and went red the
 * moment the suite ran under load. The bounds are arithmetic — test them as
 * arithmetic, and keep one cheap end-to-end case to prove the wiring.
 */
export function clampAnimateOptions(animate: AnimateOptions): { frames: number; fps: number } {
  const { minFrames, maxFrames, minFps, maxFps } = ANIMATE_BOUNDS;
  return {
    frames: Math.max(minFrames, Math.min(maxFrames, Math.floor(animate.frames))),
    fps: Math.max(minFps, Math.min(maxFps, Math.floor(animate.fps))),
  };
}

/**
 * Render an ANIMATED GIF (ADR 0399 OQ-2 in-posture slice) — N deterministic
 * resvg frames of the reveal preset, encoded with the pure-JS `gifenc` (no
 * heavy video encoder; MP4/reel-video stays deferred, §Alternatives). Each
 * frame fades the foreground in; the last frame equals the static render.
 * Deterministic: resvg + gifenc are both deterministic for fixed input.
 */
export function renderAnimatedGif(input: RenderAdInput, animate: AnimateOptions): ComposedAnimation {
  const { frames, fps } = clampAnimateOptions(animate);
  const delay = Math.round(1000 / fps);
  const fontBuffers = [...bundledFontBuffers(), ...(input.extraFontBuffers ?? [])];
  const options = (): RenderOptionsWithFontBuffers => ({
    font: { loadSystemFonts: false, fontBuffers, defaultFontFamily: BUNDLED_FONT_FAMILIES.sans },
    fitTo: { mode: 'original' },
  });

  const enc = GIFEncoder();
  let warnings: RenderWarning[] = [];
  let layerBboxes: ComposedAd['layerBboxes'] = [];
  for (let k = 0; k < frames; k++) {
    const progress = smoothstep(k / (frames - 1));
    const composed = composeAdSvg(input, { revealProgress: progress });
    if (k === frames - 1) { warnings = composed.warnings; layerBboxes = composed.layerBboxes; }
    const pngPixels = new Resvg(composed.svg, options()).render();
    const rgba = pngPixels.pixels; // RGBA Uint8Array (width×height×4)
    const w = pngPixels.width, h = pngPixels.height;
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    enc.writeFrame(index, w, h, { palette, delay });
  }
  enc.finish();
  return { gif: Buffer.from(enc.bytes()), warnings, layerBboxes, frames, fps };
}

/** Compose + rasterize. PNG only (the storable, platform-uploadable format). */
export function renderAd(input: RenderAdInput): ComposedAd {
  const { svg, warnings, layerBboxes } = composeAdSvg(input);
  const options: RenderOptionsWithFontBuffers = {
    font: {
      loadSystemFonts: false,
      fontBuffers: [...bundledFontBuffers(), ...(input.extraFontBuffers ?? [])],
      defaultFontFamily: BUNDLED_FONT_FAMILIES.sans,
    },
    fitTo: { mode: 'original' },
  };
  const resvg = new Resvg(svg, options);
  const png = Buffer.from(resvg.render().asPng());
  return { svg, png, warnings, layerBboxes };
}
