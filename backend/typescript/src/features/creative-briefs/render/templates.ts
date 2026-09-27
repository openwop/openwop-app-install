/**
 * Ad-layout template catalog (ADR 0399 §1) — the code-owned, versioned SSoT of
 * per-(platform, format) layout geometry: exact pixel dimensions, z-ordered
 * absolute-positioned layer slots, and platform safe-zone rects. Static data
 * like `providers.json`, NOT tenant data — a template change is a code change
 * with a version bump (the version enters the composite render hash, so an
 * edited template can never silently re-pixel an existing render).
 *
 * Safe-zone rects are authored from each platform's published safe-area
 * guidance and are DATA, not code branches (ADR 0399 §4 — filled in Phase 2).
 */

/** A platform-UI overlap rect (pixels, template coordinate space). */
export interface SafeZoneRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** i18n-independent human hint, e.g. "TikTok right action rail". */
  label: string;
}

export type AdLayerId = 'background' | 'product' | 'scrim' | 'headline' | 'body' | 'cta' | 'logo';

/** Brand-resolved color tokens a template may reference — never raw hex in a
 *  template, so every render re-colors from the brand kit (ADR 0399 §5). */
export type BrandColorToken = 'ink' | 'paper' | 'accent' | 'accentInk';

export interface TemplateTextStyle {
  fontRole: 'sans' | 'serif';
  sizePx: number;
  weight: 400 | 700;
  align: 'start' | 'middle' | 'end';
  maxLines: number;
  color: BrandColorToken;
  /** Line height multiplier (default 1.2). */
  lineHeight?: number;
}

export interface TemplateLayer {
  id: AdLayerId;
  kind: 'image' | 'text' | 'shape';
  box: { x: number; y: number; w: number; h: number };
  z: number;
  /** Text layers only. */
  type?: TemplateTextStyle;
  /** Image layers only (default 'cover'). */
  fit?: 'cover' | 'contain';
  /** Rounded-corner radius for image/shape layers, and the CTA pill. */
  radiusPx?: number;
  /** Inner padding for text-in-shape layers (the CTA pill). */
  padPx?: number;
  /** Shape layers + the CTA pill background. */
  fill?: BrandColorToken;
  /** Shape opacity (scrims), 0..1. Deterministic constant, never computed. */
  opacity?: number;
}

export interface AdLayoutTemplate {
  /** e.g. "meta.feed.1x1" — stable id; `version` bumps on any geometry edit. */
  templateId: string;
  version: number;
  platform: 'meta' | 'tiktok' | 'linkedin' | 'google-display';
  format: string;
  width: number;
  height: number;
  safeZones: SafeZoneRect[];
  layers: TemplateLayer[];
}

/** Shared layer recipe for the two 9:16 story canvases (Meta story / TikTok).
 *  Geometry constants only — each template still owns its OWN safe zones. */
function storyLayers(): TemplateLayer[] {
  // Safe-by-design: every copy/logo slot sits INSIDE the tightest safe area of
  // the two 9:16 hosts (above y=1440, below y=300, left of x=950) — a default
  // render should produce zero safe-zone warnings; nudges can reintroduce them.
  return [
    { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 1080, h: 1920 }, z: 0, fit: 'cover' },
    { id: 'scrim', kind: 'shape', box: { x: 0, y: 900, w: 1080, h: 540 }, z: 1, fill: 'ink', opacity: 0.55 },
    { id: 'product', kind: 'image', box: { x: 300, y: 380, w: 480, h: 480 }, z: 2, fit: 'contain', radiusPx: 24 },
    { id: 'headline', kind: 'text', box: { x: 110, y: 950, w: 860, h: 260 }, z: 3, type: { fontRole: 'sans', sizePx: 84, weight: 700, align: 'middle', maxLines: 3, color: 'paper' } },
    { id: 'body', kind: 'text', box: { x: 140, y: 1230, w: 800, h: 100 }, z: 3, type: { fontRole: 'sans', sizePx: 40, weight: 400, align: 'middle', maxLines: 2, color: 'paper' } },
    { id: 'cta', kind: 'text', box: { x: 340, y: 1344, w: 400, h: 88 }, z: 4, type: { fontRole: 'sans', sizePx: 38, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 44, padPx: 22 },
    { id: 'logo', kind: 'image', box: { x: 60, y: 300, w: 140, h: 140 }, z: 4, fit: 'contain' },
  ];
}

/** ADR 0399 Phase 3 / Open Q3 — the four highest-traffic fixed IAB display
 *  sizes. No system chrome overlays a display slot ⇒ no safe zones; the long
 *  tail of sizes is data-only additions later. */
const GOOGLE_DISPLAY_TEMPLATES: AdLayoutTemplate[] = [
  {
    templateId: 'google.display.300x250',
    version: 1,
    platform: 'google-display',
    format: 'medium rectangle 300×250',
    width: 300,
    height: 250,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 300, h: 250 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 110, w: 300, h: 140 }, z: 1, fill: 'ink', opacity: 0.6 },
      { id: 'logo', kind: 'image', box: { x: 12, y: 12, w: 60, h: 36 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 16, y: 120, w: 268, h: 64 }, z: 3, type: { fontRole: 'sans', sizePx: 24, weight: 700, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 16, y: 196, w: 130, h: 38 }, z: 4, type: { fontRole: 'sans', sizePx: 16, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 19, padPx: 10 },
    ],
  },
  {
    templateId: 'google.display.728x90',
    version: 1,
    platform: 'google-display',
    format: 'leaderboard 728×90',
    width: 728,
    height: 90,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 728, h: 90 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 0, w: 728, h: 90 }, z: 1, fill: 'ink', opacity: 0.55 },
      { id: 'logo', kind: 'image', box: { x: 16, y: 21, w: 80, h: 48 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 116, y: 12, w: 440, h: 66 }, z: 3, type: { fontRole: 'sans', sizePx: 24, weight: 700, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 576, y: 25, w: 136, h: 40 }, z: 4, type: { fontRole: 'sans', sizePx: 16, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 20, padPx: 10 },
    ],
  },
  {
    templateId: 'google.display.160x600',
    version: 1,
    platform: 'google-display',
    format: 'wide skyscraper 160×600',
    width: 160,
    height: 600,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 160, h: 600 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 230, w: 160, h: 370 }, z: 1, fill: 'ink', opacity: 0.6 },
      { id: 'logo', kind: 'image', box: { x: 40, y: 24, w: 80, h: 48 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 12, y: 250, w: 136, h: 180 }, z: 3, type: { fontRole: 'sans', sizePx: 22, weight: 700, align: 'middle', maxLines: 5, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 20, y: 520, w: 120, h: 40 }, z: 4, type: { fontRole: 'sans', sizePx: 15, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 20, padPx: 8 },
    ],
  },
  {
    templateId: 'google.display.300x600',
    version: 1,
    platform: 'google-display',
    format: 'half page 300×600',
    width: 300,
    height: 600,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 300, h: 600 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 320, w: 300, h: 280 }, z: 1, fill: 'ink', opacity: 0.6 },
      { id: 'product', kind: 'image', box: { x: 75, y: 90, w: 150, h: 150 }, z: 2, fit: 'contain', radiusPx: 12 },
      { id: 'logo', kind: 'image', box: { x: 110, y: 20, w: 80, h: 48 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 20, y: 340, w: 260, h: 120 }, z: 3, type: { fontRole: 'sans', sizePx: 28, weight: 700, align: 'middle', maxLines: 3, color: 'paper' } },
      { id: 'body', kind: 'text', box: { x: 24, y: 466, w: 252, h: 56 }, z: 3, type: { fontRole: 'sans', sizePx: 16, weight: 400, align: 'middle', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 80, y: 534, w: 140, h: 44 }, z: 4, type: { fontRole: 'sans', sizePx: 17, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 22, padPx: 10 },
    ],
  },
  // ── Long-tail IAB sizes (ADR 0399 OQ-3 follow-through) ────────────────────
  {
    templateId: 'google.display.336x280',
    version: 1,
    platform: 'google-display',
    format: 'large rectangle 336×280',
    width: 336,
    height: 280,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 336, h: 280 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 130, w: 336, h: 150 }, z: 1, fill: 'ink', opacity: 0.6 },
      { id: 'product', kind: 'image', box: { x: 93, y: 20, w: 150, h: 110 }, z: 2, fit: 'contain', radiusPx: 12 },
      { id: 'logo', kind: 'image', box: { x: 14, y: 14, w: 66, h: 40 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 18, y: 142, w: 300, h: 72 }, z: 3, type: { fontRole: 'sans', sizePx: 26, weight: 700, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'body', kind: 'text', box: { x: 20, y: 210, w: 296, h: 30 }, z: 3, type: { fontRole: 'sans', sizePx: 15, weight: 400, align: 'start', maxLines: 1, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 18, y: 232, w: 130, h: 40 }, z: 4, type: { fontRole: 'sans', sizePx: 16, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 20, padPx: 10 },
    ],
  },
  {
    templateId: 'google.display.250x250',
    version: 1,
    platform: 'google-display',
    format: 'square 250×250',
    width: 250,
    height: 250,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 250, h: 250 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 130, w: 250, h: 120 }, z: 1, fill: 'ink', opacity: 0.6 },
      { id: 'logo', kind: 'image', box: { x: 12, y: 12, w: 60, h: 36 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 16, y: 140, w: 218, h: 60 }, z: 3, type: { fontRole: 'sans', sizePx: 22, weight: 700, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 16, y: 202, w: 120, h: 36 }, z: 4, type: { fontRole: 'sans', sizePx: 15, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 18, padPx: 8 },
    ],
  },
  {
    templateId: 'google.display.970x250',
    version: 1,
    platform: 'google-display',
    format: 'billboard 970×250',
    width: 970,
    height: 250,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 970, h: 250 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 0, w: 560, h: 250 }, z: 1, fill: 'ink', opacity: 0.55 },
      { id: 'product', kind: 'image', box: { x: 660, y: 30, w: 280, h: 190 }, z: 2, fit: 'contain', radiusPx: 16 },
      { id: 'logo', kind: 'image', box: { x: 40, y: 28, w: 120, h: 56 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 40, y: 100, w: 500, h: 66 }, z: 3, type: { fontRole: 'sans', sizePx: 40, weight: 700, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'body', kind: 'text', box: { x: 40, y: 168, w: 480, h: 34 }, z: 3, type: { fontRole: 'sans', sizePx: 18, weight: 400, align: 'start', maxLines: 1, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 40, y: 202, w: 160, h: 40 }, z: 4, type: { fontRole: 'sans', sizePx: 18, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 20, padPx: 10 },
    ],
  },
  {
    templateId: 'google.display.468x60',
    version: 1,
    platform: 'google-display',
    format: 'banner 468×60',
    width: 468,
    height: 60,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 468, h: 60 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 0, w: 468, h: 60 }, z: 1, fill: 'ink', opacity: 0.55 },
      { id: 'logo', kind: 'image', box: { x: 12, y: 14, w: 60, h: 32 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 84, y: 8, w: 260, h: 44 }, z: 3, type: { fontRole: 'sans', sizePx: 18, weight: 700, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 352, y: 14, w: 104, h: 32 }, z: 4, type: { fontRole: 'sans', sizePx: 14, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 16, padPx: 8 },
    ],
  },
  {
    templateId: 'google.display.320x100',
    version: 1,
    platform: 'google-display',
    format: 'large mobile banner 320×100',
    width: 320,
    height: 100,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 320, h: 100 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 0, w: 320, h: 100 }, z: 1, fill: 'ink', opacity: 0.5 },
      { id: 'logo', kind: 'image', box: { x: 10, y: 30, w: 60, h: 40 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 84, y: 14, w: 150, h: 44 }, z: 3, type: { fontRole: 'sans', sizePx: 18, weight: 700, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 244, y: 34, w: 66, h: 32 }, z: 4, type: { fontRole: 'sans', sizePx: 13, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 16, padPx: 8 },
    ],
  },
  {
    templateId: 'google.display.320x50',
    version: 1,
    platform: 'google-display',
    format: 'mobile leaderboard 320×50',
    width: 320,
    height: 50,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 320, h: 50 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 0, w: 320, h: 50 }, z: 1, fill: 'ink', opacity: 0.5 },
      { id: 'logo', kind: 'image', box: { x: 6, y: 9, w: 44, h: 32 }, z: 4, fit: 'contain' },
      { id: 'headline', kind: 'text', box: { x: 58, y: 6, w: 180, h: 38 }, z: 3, type: { fontRole: 'sans', sizePx: 16, weight: 700, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 246, y: 11, w: 68, h: 28 }, z: 4, type: { fontRole: 'sans', sizePx: 12, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 14, padPx: 6 },
    ],
  },
];

export const AD_LAYOUT_TEMPLATES: readonly AdLayoutTemplate[] = [
  {
    templateId: 'meta.feed.1x1',
    version: 1,
    platform: 'meta',
    format: 'feed 1:1',
    width: 1080,
    height: 1080,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 1080, h: 1080 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 640, w: 1080, h: 440 }, z: 1, fill: 'ink', opacity: 0.55 },
      { id: 'product', kind: 'image', box: { x: 330, y: 150, w: 420, h: 420 }, z: 2, fit: 'contain', radiusPx: 24 },
      { id: 'headline', kind: 'text', box: { x: 80, y: 700, w: 920, h: 180 }, z: 3, type: { fontRole: 'sans', sizePx: 72, weight: 700, align: 'middle', maxLines: 2, color: 'paper' } },
      { id: 'body', kind: 'text', box: { x: 120, y: 890, w: 840, h: 90 }, z: 3, type: { fontRole: 'sans', sizePx: 36, weight: 400, align: 'middle', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 370, y: 985, w: 340, h: 76 }, z: 4, type: { fontRole: 'sans', sizePx: 34, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 38, padPx: 20 },
      { id: 'logo', kind: 'image', box: { x: 60, y: 60, w: 140, h: 140 }, z: 4, fit: 'contain' },
    ],
  },
  {
    templateId: 'meta.story.9x16',
    version: 1,
    platform: 'meta',
    format: 'story/reel 9:16',
    width: 1080,
    height: 1920,
    // Meta's published stories/reels guidance: keep ~14% top and ~20% bottom
    // free of text/logos (profile chrome above, CTA/swipe chrome below).
    safeZones: [
      { id: 'meta-story-top', x: 0, y: 0, w: 1080, h: 269, label: 'Meta story top system UI' },
      { id: 'meta-story-bottom', x: 0, y: 1536, w: 1080, h: 384, label: 'Meta story bottom CTA area' },
    ],
    layers: storyLayers(),
  },
  {
    templateId: 'tiktok.9x16',
    version: 1,
    platform: 'tiktok',
    format: 'in-feed 9:16',
    width: 1080,
    height: 1920,
    // TikTok's in-feed safe-area guidance: top status chrome, the right action
    // rail (like/comment/share), and the bottom caption + nav band.
    safeZones: [
      { id: 'tiktok-top', x: 0, y: 0, w: 1080, h: 150, label: 'TikTok top chrome' },
      { id: 'tiktok-right-rail', x: 960, y: 600, w: 120, h: 1000, label: 'TikTok right action rail' },
      { id: 'tiktok-bottom', x: 0, y: 1440, w: 1080, h: 480, label: 'TikTok caption and nav band' },
    ],
    layers: storyLayers(),
  },
  {
    templateId: 'linkedin.landscape.191x1',
    version: 1,
    platform: 'linkedin',
    format: 'single image 1.91:1',
    width: 1200,
    height: 627,
    safeZones: [],
    layers: [
      { id: 'background', kind: 'image', box: { x: 0, y: 0, w: 1200, h: 627 }, z: 0, fit: 'cover' },
      { id: 'scrim', kind: 'shape', box: { x: 0, y: 0, w: 640, h: 627 }, z: 1, fill: 'ink', opacity: 0.6 },
      { id: 'product', kind: 'image', box: { x: 700, y: 90, w: 440, h: 440 }, z: 2, fit: 'contain', radiusPx: 20 },
      { id: 'headline', kind: 'text', box: { x: 60, y: 140, w: 520, h: 200 }, z: 3, type: { fontRole: 'sans', sizePx: 52, weight: 700, align: 'start', maxLines: 3, color: 'paper' } },
      { id: 'body', kind: 'text', box: { x: 60, y: 360, w: 520, h: 100 }, z: 3, type: { fontRole: 'sans', sizePx: 28, weight: 400, align: 'start', maxLines: 2, color: 'paper' } },
      { id: 'cta', kind: 'text', box: { x: 60, y: 480, w: 280, h: 64 }, z: 4, type: { fontRole: 'sans', sizePx: 28, weight: 700, align: 'middle', maxLines: 1, color: 'accentInk' }, fill: 'accent', radiusPx: 32, padPx: 16 },
      { id: 'logo', kind: 'image', box: { x: 60, y: 40, w: 110, h: 72 }, z: 4, fit: 'contain' },
    ],
  },
  ...GOOGLE_DISPLAY_TEMPLATES,
];

export function getTemplate(templateId: string): AdLayoutTemplate | null {
  return AD_LAYOUT_TEMPLATES.find((t) => t.templateId === templateId) ?? null;
}

export function listTemplates(): readonly AdLayoutTemplate[] {
  return AD_LAYOUT_TEMPLATES;
}
