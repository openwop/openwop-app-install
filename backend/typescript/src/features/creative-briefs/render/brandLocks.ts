/**
 * ADR 0946 D4 — brand creative locks, enforced by construction before a render
 * is composed.
 *
 * - Nudges are clamped to the brand's `overrideBounds`, inside the renderer's
 *   own global clamp (`clampNudge`: ±10% of the smaller side, scale 0.8–1.25).
 *   The clamped nudges are what gets rendered, hashed and stored.
 * - A resolved colour or font family outside the brand's lists, a template
 *   whose logo slot sits outside the logo zones or below the minimum size, or a
 *   required logo that did not resolve is REFUSED. The render is a typed 400
 *   (`brand_lock_violation`), never a quietly off-brand image.
 *
 * It also reports the render's lock facts (what was actually used) so the
 * ADR 0946 P2 `brand-lock` pre-flight rule can re-check the result.
 */
import { OpenwopError } from '../../../types.js';
import type { BrandCreativeLocks } from '../../brand/types.js';
import type { LockFacts } from '../../../host/contentRules/creative/types.js';
import { clampNudge, type BrandRenderTokens, type LayerNudge, type RenderWarning } from './renderCreative.js';
import type { AdLayerId, AdLayoutTemplate, BrandColorToken } from './templates.js';

/** What the render used: the content-rules library's `LockFacts`, the input
 *  the P2 `brand-lock` pre-flight rule reads. */
export type RenderLockFacts = LockFacts;

export interface LockedRender {
  overrides?: Partial<Record<AdLayerId, LayerNudge>>;
  warnings: RenderWarning[];
  lockFacts: RenderLockFacts;
}

const lc = (s: string): string => s.trim().toLowerCase();
/** The primary family of a font stack: `"Inter", sans-serif` → `inter`. */
const primaryFamily = (stack: string): string => lc(stack.split(',')[0] ?? '').replace(/^['"]|['"]$/g, '');
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function applyBrandLocks(args: {
  template: AdLayoutTemplate;
  tokens: BrandRenderTokens;
  locks: BrandCreativeLocks | undefined;
  overrides: Partial<Record<AdLayerId, LayerNudge>> | undefined;
  logoPresent: boolean;
  /** Text layers that will draw (their copy is present). */
  textLayerIds: ReadonlySet<AdLayerId>;
}): LockedRender {
  const { template, tokens, locks } = args;
  const warnings: RenderWarning[] = [];

  // 1. Clamp nudges to the brand bounds (inside the global clamp).
  let overrides = args.overrides;
  if (locks && overrides) {
    const maxDx = (template.width * locks.overrideBounds.maxOffsetPct) / 100;
    const maxDy = (template.height * locks.overrideBounds.maxOffsetPct) / 100;
    const out: Partial<Record<AdLayerId, LayerNudge>> = {};
    for (const [id, raw] of Object.entries(overrides) as Array<[AdLayerId, LayerNudge]>) {
      const g = clampNudge(raw, template);
      const n: LayerNudge = {
        // Truncate toward zero: rounding up could land a pixel past the bound.
        ...(raw.dx !== undefined ? { dx: Math.trunc(Math.max(-maxDx, Math.min(maxDx, g.dx))) } : {}),
        ...(raw.dy !== undefined ? { dy: Math.trunc(Math.max(-maxDy, Math.min(maxDy, g.dy))) } : {}),
        ...(raw.scale !== undefined ? { scale: Math.min(locks.overrideBounds.maxScale, g.scale) } : {}),
      };
      if ((n.dx ?? 0) !== (raw.dx ?? 0) || (n.dy ?? 0) !== (raw.dy ?? 0) || (n.scale ?? 1) !== (raw.scale ?? 1)) {
        warnings.push({ code: 'brand-lock-clamped', layerId: id, message: `The nudge on '${id}' was clamped to the brand's override bounds.` });
      }
      out[id] = n;
    }
    overrides = out;
  }

  // 2. What the render will use.
  const textTokens = new Set<BrandColorToken>();
  const bgTokens = new Set<BrandColorToken>(['paper']); // the canvas base
  const fontRoles = new Set<'sans' | 'serif'>();
  for (const layer of template.layers) {
    if (layer.kind === 'shape') bgTokens.add(layer.fill ?? 'ink');
    if (layer.kind === 'text' && layer.type && args.textLayerIds.has(layer.id)) {
      textTokens.add(layer.type.color);
      fontRoles.add(layer.type.fontRole);
      if (layer.fill) bgTokens.add(layer.fill);
    }
  }
  const hex = (set: Set<BrandColorToken>): string[] => [...new Set([...set].map((t) => lc(tokens.colors[t])))].sort();
  const textColours = hex(textTokens);
  const backgroundColours = hex(bgTokens);
  const fonts = [...new Set([...fontRoles].map((r) => primaryFamily(tokens.fontFamilies[r])))].sort();

  const logoLayer = template.layers.find((l) => l.id === 'logo');
  let logoBox: RenderLockFacts['logoBox'];
  let logoPx: number | undefined;
  if (logoLayer) {
    const n = clampNudge(overrides?.logo, template);
    const w = Math.round(logoLayer.box.w * n.scale);
    const h = Math.round(logoLayer.box.h * n.scale);
    const x = logoLayer.box.x + (logoLayer.box.w - w) / 2 + n.dx;
    const y = logoLayer.box.y + (logoLayer.box.h - h) / 2 + n.dy;
    logoBox = { x: round2((x / template.width) * 100), y: round2((y / template.height) * 100), w: round2((w / template.width) * 100), h: round2((h / template.height) * 100) };
    logoPx = Math.min(w, h);
  }
  const nudges: RenderLockFacts['nudges'] = {};
  for (const [id, n] of Object.entries(overrides ?? {}) as Array<[AdLayerId, LayerNudge]>) {
    const g = clampNudge(n, template);
    nudges[id] = { scale: g.scale, dxPct: round2((g.dx / template.width) * 100), dyPct: round2((g.dy / template.height) * 100) };
  }
  const lockFacts: RenderLockFacts = {
    logoPresent: args.logoPresent && logoLayer !== undefined,
    ...(logoBox ? { logoBox } : {}),
    ...(logoPx !== undefined ? { logoPx } : {}),
    textColours, backgroundColours, fonts, nudges,
    disclaimerPresent: false,
  };
  if (!locks) return { ...(overrides ? { overrides } : {}), warnings, lockFacts };

  // 3. Refuse what the locks forbid.
  const violations: Array<{ code: string; detail: string }> = [];
  const allowText = new Set(locks.textColours.map(lc));
  const allowBg = new Set(locks.backgroundColours.map(lc));
  const allowFonts = new Set(locks.fonts.map(primaryFamily));
  if (allowText.size > 0) for (const c of textColours) if (!allowText.has(c)) violations.push({ code: 'text_colour', detail: c });
  if (allowBg.size > 0) for (const c of backgroundColours) if (!allowBg.has(c)) violations.push({ code: 'background_colour', detail: c });
  if (allowFonts.size > 0) for (const f of fonts) if (!allowFonts.has(f)) violations.push({ code: 'font', detail: f });
  if (locks.logo) {
    if (locks.logo.required && !lockFacts.logoPresent) violations.push({ code: 'logo_missing', detail: template.templateId });
    if (lockFacts.logoPresent && logoBox) {
      const inZone = locks.logo.zones.length === 0 || locks.logo.zones.some((z) => logoBox.x >= z.x && logoBox.y >= z.y && logoBox.x + logoBox.w <= z.x + z.w && logoBox.y + logoBox.h <= z.y + z.h);
      if (!inZone) violations.push({ code: 'logo_zone', detail: template.templateId });
      if (logoPx !== undefined && logoPx < locks.logo.minPx) violations.push({ code: 'logo_size', detail: `${logoPx}px` });
    }
  }
  if (violations.length > 0) {
    throw new OpenwopError('validation_error', `This render breaks the brand's creative locks: ${violations.map((v) => `${v.code} (${v.detail})`).join(', ')}.`, 400, {
      reason: 'brand_lock_violation', templateId: template.templateId, violations,
    });
  }
  return { ...(overrides ? { overrides } : {}), warnings, lockFacts };
}
