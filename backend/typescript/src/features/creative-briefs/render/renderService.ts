/**
 * Render service (ADR 0399) — orchestrates `brief + template + resolved assets
 * + brand tokens (+ nudges)` → the deterministic renderer → a PNG stored as a
 * Media asset (hash-deduped, marketing-faceted), plus a durable render record.
 *
 * Ownership: creative-briefs owns the render RECORD and the orchestration;
 * media stays the sole owner of bytes (`mediaStorage.put` → `createAsset`,
 * exactly the `createAssetFromServeUrl` write path — capacity gate BEFORE
 * storing, dedup via content hash, never a second byte store). The renderer
 * never mutates a brief.
 *
 * Replay: a workflow render is an ACTION node — its recorded result (the
 * `mediaAssetId`) is read verbatim on replay/`:fork` (the ADR 0083/0115
 * record-and-read invariant); this service is only reached on live execution.
 * The composite hash pins provenance (which inputs produced these pixels) and
 * powers media dedup — identical inputs land on the SAME asset row.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { cleanString, optionalCleanString } from '../../../host/boundedStrings.js';
import { createLogger } from '../../../observability/logger.js';
import { resolveMediaAsset } from '../../../host/inMemorySurfaces.js';
import { assertOrgCapacity, clearUsageForRef, createAsset, findAssetByContentHash, getAsset, mergeAssetMetadataOnDedup, syncUsageRefs } from '../../media/mediaService.js';
import * as mediaStorage from '../../media/mediaStorage.js';
import { listBrands, getBrand } from '../../brand/brandService.js';
import { getBrandFont, BRAND_FONT_ROLES } from '../../brand/brandFonts.js';
import type { Brand } from '../../brand/types.js';
import { getBrief } from '../creativeBriefsService.js';
import type { CreativeBrief } from '../types.js';
import { getTemplate, type AdLayoutTemplate, type AdLayerId, type BrandColorToken } from './templates.js';
import {
  renderAd, renderAnimatedGif, isSafeSvgColor, RENDERER_VERSION,
  type AnimateOptions, type BrandRenderTokens, type LayerNudge, type RenderWarning, type ResolvedLayerImage, type ResolvedRenderContent,
} from './renderCreative.js';
import { BUNDLED_FONT_FAMILIES } from './fonts.js';
import { checkSafeZones } from './safeZones.js';
import { onMediaAssetDeleted } from '../../../host/mediaAssetLifecycle.js';

const log = createLogger('creative-briefs:render');

const MAX = { rendersPerBrief: 60, copy: 300, variantTemplates: 12, animatedBytes: 20 * 1024 * 1024 } as const;

/**
 * The effective per-brief render cap. Reads through a variable rather than
 * `MAX.rendersPerBrief` directly so cap BEHAVIOUR (the TOCTOU recheck, the
 * delete-old-first eviction) can be tested at a small cap: every render in
 * those tests is a full rasterization, so filling to 60 cost ~12s per test and
 * blew the timeout under parallel load. The invariant is independent of the
 * cap's value; the cost is not.
 *
 * Production ALWAYS uses `MAX.rendersPerBrief` — only {@link __setRenderCapForTest}
 * changes it, and it hands back a restore fn so a test cannot leak the override.
 */
let renderCap: number = MAX.rendersPerBrief;

/** Test-only view of the render cap (avoids hard-coding the number in tests). */
export const renderCapForTest = (): number => renderCap;

/** Test-only: shrink the cap; returns the restore fn (call it in `afterAll`). */
export function __setRenderCapForTest(n: number): () => void {
  const previous = renderCap;
  renderCap = n;
  return () => { renderCap = previous; };
}

/** Raster formats resvg decodes from a data: URI. WebP is NOT among them. */
const EMBEDDABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif']);

export interface CreativeRender {
  renderId: string;
  tenantId: string;
  orgId: string;
  briefId: string;
  /** The brief content revision the render projected. */
  briefVersion: number;
  templateId: string;
  templateVersion: number;
  directionIndex?: number;
  overrides?: Partial<Record<AdLayerId, LayerNudge>>;
  copy: { headline: string; body?: string; cta?: string };
  layerAssets: Partial<Record<AdLayerId, { mediaAssetId: string; sha256: string }>>;
  /** The brand tokens AS APPLIED (brand rows change over time — the snapshot
   *  keeps the record honest about what produced these pixels). */
  brand: { brandId?: string; colors: Record<BrandColorToken, string>; fontFamilies: { sans: string; serif: string } };
  warnings: RenderWarning[];
  /** sha256 over every determinism input (ADR 0399 §2) — provenance + dedup. */
  compositeHash: string;
  /** The stored composed asset (media owns the bytes) — PNG, or GIF when
   *  animated. For a REEL render this is the host Media URL/token of the
   *  generated video (ADR 0411 P3 — video owns the bytes). */
  mediaAssetId: string;
  /** ADR 0399 OQ-2 — set when this render is an animated GIF. */
  animation?: { preset: 'reveal'; frames: number; fps: number };
  /** ADR 0411 P3 — set when this render is a generated REEL (video via
   *  ctx.callVideoGenerator). Its presence discriminates a reel from a
   *  composed image render; `mediaAssetId` then points at the video, and the
   *  image-only fields (layerAssets/compositeHash) are reel-inapplicable stubs. */
  reel?: { prompt: string; durationSeconds?: number; aspectRatio?: string; provider?: string };
  createdBy: string;
  createdAt: string;
}

const renders = new DurableCollection<CreativeRender>('creative-briefs:render', (r) => `${r.tenantId}:${r.orgId}:${r.briefId}:${r.renderId}`);

const nowIso = (): string => new Date().toISOString();

/** Relative luminance — picks black/white text on the accent pill. Pure. */
function accentInkFor(accentHex: string): string {
  const hex = accentHex.length === 4 ? `#${accentHex[1]}${accentHex[1]}${accentHex[2]}${accentHex[2]}${accentHex[3]}${accentHex[3]}` : accentHex;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? '#111111' : '#ffffff';
}

const NEUTRAL_COLORS: Record<BrandColorToken, string> = { ink: '#111111', paper: '#ffffff', accent: '#3b5bdb', accentInk: '#ffffff' };

/** Map a brand CSS font stack onto the bundled set (nearest-match, ADR 0399
 *  Open Q1). Only ever returns a bundled family name — the SVG never names an
 *  unbundled font. */
function mapFontStack(stack: string | undefined, role: 'sans' | 'serif', warnings: RenderWarning[]): string {
  const bundled = role === 'serif' ? BUNDLED_FONT_FAMILIES.serif : BUNDLED_FONT_FAMILIES.sans;
  if (!stack) return bundled;
  const lower = stack.toLowerCase();
  if (role === 'sans' && lower.includes('inter')) return bundled;
  if (role === 'serif' && lower.includes('pt serif')) return bundled;
  warnings.push({ code: 'brand-font-not-bundled', message: `Brand ${role} font stack "${stack.slice(0, 60)}" is not bundled — rendered with ${bundled}.` });
  return bundled;
}

interface ResolvedBrandTokens {
  tokens: BrandRenderTokens;
  snapshot: CreativeRender['brand'];
  logo?: ResolvedLayerImage;
  /** ADR 0399 OQ-1 — attested brand fonts to embed (resvg buffers) + their
   *  sha256s (composite-hash inputs, so a font change re-pixels). */
  customFonts: { buffers: Buffer[]; shas: { sans?: string; serif?: string } };
}

/** Resolve brand kit + brief palette into safe render tokens (brief wins for
 *  accent). Missing brand ⇒ neutral defaults + a warning — honest degradation,
 *  never a hard fail (ADR 0399 §5). */
async function resolveBrandTokens(tenantId: string, orgId: string, brief: CreativeBrief, brandIdArg: string | undefined, warnings: RenderWarning[]): Promise<ResolvedBrandTokens> {
  let brand: Brand | null = null;
  if (brandIdArg) {
    brand = await getBrand(tenantId, brandIdArg);
    if (!brand || brand.orgId !== orgId) throw new OpenwopError('not_found', 'Brand not found in this org.', 404, { brandId: brandIdArg });
  } else {
    brand = (await listBrands(tenantId, orgId)).find((b) => b.status === 'active') ?? null;
  }
  if (!brand) warnings.push({ code: 'no-brand-kit', message: 'No brand kit found — rendered with neutral colors and bundled fonts.' });

  const identity = brand?.identity;
  const colors: Record<BrandColorToken, string> = { ...NEUTRAL_COLORS };
  const idColors = identity?.colors ?? {};
  if (isSafeSvgColor(idColors.ink)) colors.ink = idColors.ink;
  if (isSafeSvgColor(idColors.paper)) colors.paper = idColors.paper;
  if (isSafeSvgColor(idColors.accent)) colors.accent = idColors.accent;
  // Brief palette wins for the accent (ADR 0399 §2: brief ⊕ brand, brief wins).
  const briefAccent = (brief.brandPalette ?? []).find((c) => isSafeSvgColor(c));
  if (briefAccent) colors.accent = briefAccent;
  colors.accentInk = accentInkFor(colors.accent);

  const fontFamilies = {
    sans: mapFontStack(identity?.typography?.sans, 'sans', warnings),
    serif: mapFontStack(identity?.typography?.serif, 'serif', warnings),
  };

  // ADR 0399 OQ-1 — an attested brand font (bounded point read per role) wins:
  // the SVG's font-family becomes the font's REAL internal family (C2 — never a
  // typed string) and its buffer joins the resvg set. Missing/unattested ⇒ the
  // bundled nearest-match above stands.
  const customFonts: { buffers: Buffer[]; shas: { sans?: string; serif?: string } } = { buffers: [], shas: {} };
  if (brand) {
    for (const role of BRAND_FONT_ROLES) {
      const font = await getBrandFont(tenantId, brand.id, role);
      if (font) {
        fontFamilies[role] = font.family;
        customFonts.buffers.push(Buffer.from(font.contentBase64, 'base64'));
        customFonts.shas[role] = font.sha256;
      }
    }
  }

  const logo = await resolveBrandLogo(tenantId, identity?.logo?.markSrc ?? identity?.logo?.lockupSrc, warnings);
  return {
    tokens: { colors, fontFamilies },
    snapshot: { ...(brand ? { brandId: brand.id } : {}), colors, fontFamilies },
    ...(logo ? { logo } : {}),
    customFonts,
  };
}

const DATA_URI_RE = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/;
const SERVE_TOKEN_RE = /\/assets\/([A-Za-z0-9_-]{1,512})\/?$/;

/** Resolve a brand logo src to embeddable bytes. SSRF-free rule (ADR 0328):
 *  bytes come from a data: URI or a HOST asset token — never an external
 *  fetch. Anything else (https, svg) degrades to no-logo + a warning. */
async function resolveBrandLogo(tenantId: string, src: string | undefined, warnings: RenderWarning[]): Promise<ResolvedLayerImage | undefined> {
  if (!src) return undefined;
  const dataMatch = src.match(DATA_URI_RE);
  if (dataMatch) {
    const bytes = Buffer.from(dataMatch[2] ?? '', 'base64');
    return { dataUri: src, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const tokenMatch = src.match(SERVE_TOKEN_RE);
  if (tokenMatch) {
    const entry = await resolveMediaAsset(tokenMatch[1] ?? '');
    if (entry && entry.tenantId === tenantId && EMBEDDABLE_MIME.has(entry.contentType)) {
      const bytes = Buffer.from(entry.contentBase64, 'base64');
      return { dataUri: `data:${entry.contentType};base64,${entry.contentBase64}`, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  }
  warnings.push({ code: 'logo-not-embeddable', layerId: 'logo', message: 'Brand logo is not an embeddable host raster (png/jpeg/gif) — rendered without a logo.' });
  return undefined;
}

/** Resolve one library asset to embeddable bytes — tenant+org IDOR-checked via
 *  the media service row, then bytes by its own serve token. */
async function resolveLayerAsset(tenantId: string, orgId: string, layerId: AdLayerId, mediaAssetId: string, warnings: RenderWarning[]): Promise<{ image: ResolvedLayerImage; mediaAssetId: string } | undefined> {
  const asset = await getAsset(tenantId, orgId, mediaAssetId);
  if (!asset) {
    warnings.push({ code: 'layer-asset-missing', layerId, message: `Asset ${mediaAssetId} not found in this org — '${layerId}' layer left empty.` });
    return undefined;
  }
  if (!EMBEDDABLE_MIME.has(asset.contentType)) {
    warnings.push({ code: 'layer-asset-format', layerId, message: `Asset "${asset.name}" is ${asset.contentType} — the renderer embeds png/jpeg/gif only; '${layerId}' layer left empty.` });
    return undefined;
  }
  const entry = await resolveMediaAsset(asset.serveToken);
  if (!entry || entry.tenantId !== tenantId) {
    warnings.push({ code: 'layer-asset-missing', layerId, message: `Bytes for asset "${asset.name}" are unavailable — '${layerId}' layer left empty.` });
    return undefined;
  }
  const bytes = Buffer.from(entry.contentBase64, 'base64');
  const sha256 = asset.contentHash ?? createHash('sha256').update(bytes).digest('hex');
  return { image: { dataUri: `data:${entry.contentType};base64,${entry.contentBase64}`, sha256 }, mediaAssetId: asset.assetId };
}

export interface RenderBriefArgs {
  briefId: string;
  templateId: string;
  /** Index into `brief.directions` — its label becomes the headline. */
  directionIndex?: number;
  /** Copy overrides; defaults derive from the brief (headline ← direction
   *  label or title, body ← messaging intent). No CTA text ⇒ no CTA layer. */
  copy?: { headline?: unknown; body?: unknown; cta?: unknown };
  /** Explicit layer imagery; defaults walk the mood board in order. */
  layers?: { background?: unknown; product?: unknown };
  overrides?: unknown;
  brandId?: unknown;
  /** ADR 0399 OQ-2 — request an animated GIF instead of a static PNG. */
  animate?: unknown;
}

/** Validate an `animate` request (v1: the `reveal` preset only). Clamped to
 *  the renderer's frame/fps bounds; anything else ⇒ undefined (static). */
function cleanAnimate(raw: unknown): AnimateOptions | undefined {
  if (raw === true) return { preset: 'reveal', frames: 12, fps: 8 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.preset !== undefined && o.preset !== 'reveal') return undefined; // only preset in v1
  const frames = Math.max(2, Math.min(30, typeof o.frames === 'number' && Number.isFinite(o.frames) ? Math.floor(o.frames) : 12));
  const fps = Math.max(2, Math.min(24, typeof o.fps === 'number' && Number.isFinite(o.fps) ? Math.floor(o.fps) : 8));
  return { preset: 'reveal', frames, fps };
}

function cleanOverrides(raw: unknown, template: AdLayoutTemplate): Partial<Record<AdLayerId, LayerNudge>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const layerIds = new Set(template.layers.map((l) => l.id));
  const out: Partial<Record<AdLayerId, LayerNudge>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!layerIds.has(k as AdLayerId) || !v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const nudge: LayerNudge = {
      ...(typeof o.dx === 'number' && Number.isFinite(o.dx) ? { dx: o.dx } : {}),
      ...(typeof o.dy === 'number' && Number.isFinite(o.dy) ? { dy: o.dy } : {}),
      ...(typeof o.scale === 'number' && Number.isFinite(o.scale) ? { scale: o.scale } : {}),
    };
    if (Object.keys(nudge).length > 0) out[k as AdLayerId] = nudge;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Stable stringify (sorted keys, recursively) — hash input must not depend on
 *  property insertion order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** The ADR 0399 §2 composite hash — every determinism input, hashed. Exported
 *  pure so the Phase 4 pinning tests can prove input-sensitivity directly. */
export function compositeHashOf(input: {
  briefSnapshot: unknown;
  template: AdLayoutTemplate;
  copy: CreativeRender['copy'];
  layerAssets: CreativeRender['layerAssets'];
  logoSha?: string;
  brand: CreativeRender['brand'];
  overrides?: Partial<Record<AdLayerId, LayerNudge>>;
  fontShas?: { sans?: string; serif?: string };
  animate?: AnimateOptions;
}): string {
  return createHash('sha256').update(stableStringify({
    rendererVersion: RENDERER_VERSION,
    templateId: input.template.templateId,
    templateVersion: input.template.version,
    briefSnapshot: input.briefSnapshot,
    copy: input.copy,
    layerAssets: input.layerAssets,
    logoSha: input.logoSha ?? null,
    fontShas: input.fontShas ?? null,
    animate: input.animate ?? null,
    brand: input.brand,
    overrides: input.overrides ?? null,
  })).digest('hex');
}

export async function renderForBrief(tenantId: string, orgId: string, actor: string, args: RenderBriefArgs): Promise<CreativeRender> {
  const brief = await getBrief(tenantId, orgId, args.briefId);
  if (!brief) throw new OpenwopError('not_found', 'Creative brief not found.', 404, { briefId: args.briefId });
  const template = getTemplate(args.templateId);
  if (!template) throw new OpenwopError('validation_error', `Unknown templateId — one of: ${['meta.feed.1x1', 'meta.story.9x16', 'tiktok.9x16', 'linkedin.landscape.191x1'].join(', ')} (see GET /render-templates).`, 400, { field: 'templateId' });

  const existingCount = (await renders.listByPrefix(`${tenantId}:${orgId}:${brief.briefId}:`)).length;
  if (existingCount >= renderCap) {
    throw new OpenwopError('validation_error', `Render cap reached for this brief (${renderCap}) — delete old renders first.`, 400, {});
  }

  const warnings: RenderWarning[] = [];

  // Direction → headline default.
  let directionIndex: number | undefined;
  if (args.directionIndex !== undefined) {
    const idx = Number(args.directionIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= brief.directions.length) {
      throw new OpenwopError('validation_error', `\`directionIndex\` must be 0–${Math.max(0, brief.directions.length - 1)}.`, 400, { field: 'directionIndex' });
    }
    directionIndex = idx;
  }
  const headline = optionalCleanString(args.copy?.headline, MAX.copy)
    ?? (directionIndex !== undefined ? brief.directions[directionIndex]?.label : undefined)
    ?? brief.title;
  const body = optionalCleanString(args.copy?.body, MAX.copy) ?? brief.messagingIntent;
  const cta = optionalCleanString(args.copy?.cta, 60);
  const copy: CreativeRender['copy'] = { headline, ...(body ? { body } : {}), ...(cta ? { cta } : {}) };

  // Layer imagery: explicit args win; defaults walk the mood board in order.
  const backgroundId = optionalCleanString(args.layers?.background, 200) ?? brief.moodBoard[0]?.mediaAssetId;
  const productId = optionalCleanString(args.layers?.product, 200) ?? brief.moodBoard[1]?.mediaAssetId;

  const images: ResolvedRenderContent['images'] = {};
  const layerAssets: CreativeRender['layerAssets'] = {};
  if (backgroundId) {
    const r = await resolveLayerAsset(tenantId, orgId, 'background', backgroundId, warnings);
    if (r) { images.background = r.image; layerAssets.background = { mediaAssetId: r.mediaAssetId, sha256: r.image.sha256 }; }
  } else {
    warnings.push({ code: 'missing-layer-image', layerId: 'background', message: 'No background asset (empty mood board and no explicit layer) — rendered on the paper color.' });
  }
  if (productId && productId !== backgroundId) {
    const r = await resolveLayerAsset(tenantId, orgId, 'product', productId, warnings);
    if (r) { images.product = r.image; layerAssets.product = { mediaAssetId: r.mediaAssetId, sha256: r.image.sha256 }; }
  }

  const { tokens, snapshot, logo, customFonts } = await resolveBrandTokens(tenantId, orgId, brief, optionalCleanString(args.brandId, 200), warnings);
  if (logo) images.logo = logo;

  const overrides = cleanOverrides(args.overrides, template);

  const content: ResolvedRenderContent = {
    images,
    texts: { headline: copy.headline, ...(copy.body ? { body: copy.body } : {}), ...(copy.cta ? { cta: copy.cta } : {}) },
  };
  const renderInput = { template, content, brand: tokens, ...(overrides ? { overrides } : {}), ...(customFonts.buffers.length > 0 ? { extraFontBuffers: customFonts.buffers } : {}) };

  // ADR 0399 OQ-2 — an `animate` request renders a GIF (reveal preset); else a
  // static PNG. Both deterministic; the media asset the FE previews (<img>)
  // animates natively for a GIF.
  const animate = cleanAnimate(args.animate);
  let bytes: Buffer;
  let contentType: string;
  let animLayerBboxes: ReturnType<typeof renderAd>['layerBboxes'];
  if (animate) {
    const anim = renderAnimatedGif(renderInput, animate);
    warnings.push(...anim.warnings);
    animLayerBboxes = anim.layerBboxes;
    bytes = anim.gif;
    contentType = 'image/gif';
    if (bytes.length > MAX.animatedBytes) {
      throw new OpenwopError('validation_error', `Animated render exceeds the ${Math.floor(MAX.animatedBytes / (1024 * 1024))} MiB cap — reduce frames or size.`, 413, {});
    }
  } else {
    const composed = renderAd(renderInput);
    warnings.push(...composed.warnings);
    animLayerBboxes = composed.layerBboxes;
    bytes = composed.png;
    contentType = 'image/png';
  }
  // ADR 0399 §4 — advisory only; never blocks render or dispatch.
  warnings.push(...checkSafeZones(template, animLayerBboxes, {
    ...(brief.platformSpec?.textRulePct !== undefined ? { textRulePct: brief.platformSpec.textRulePct } : {}),
  }));

  const compositeHash = compositeHashOf({
    briefSnapshot: { briefId: brief.briefId, version: brief.version },
    template, copy, layerAssets, ...(logo ? { logoSha: logo.sha256 } : {}), brand: snapshot, ...(overrides ? { overrides } : {}), ...(Object.keys(customFonts.shas).length > 0 ? { fontShas: customFonts.shas } : {}), ...(animate ? { animate } : {}),
  });

  // Store through media — dedup first (identical bytes reuse the existing row),
  // else capacity-gate BEFORE storing (no orphaned bytes).
  const b64 = bytes.toString('base64');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const marketing = { product: brief.title, angle: directionIndex !== undefined ? brief.directions[directionIndex]?.label : undefined, background: `${template.platform} ${template.format}` };
  let mediaAssetId: string;
  const existing = await findAssetByContentHash(tenantId, orgId, contentHash);
  if (existing) {
    const merged = await mergeAssetMetadataOnDedup(existing, { marketing });
    mediaAssetId = merged.assetId;
  } else {
    await assertOrgCapacity(tenantId, orgId, bytes.length);
    const stored = await mediaStorage.put(tenantId, { contentBase64: b64, contentType });
    const asset = await createAsset({
      tenantId, orgId,
      name: cleanString(`${brief.title} — ${template.templateId}${animate ? ' (animated)' : ''}`, 200),
      contentType,
      sizeBytes: stored.sizeBytes,
      storageRef: stored.storageRef,
      serveToken: stored.serveToken,
      tags: ['ad-render', template.platform, ...(animate ? ['animated'] : [])],
      uploadedBy: actor,
      lineage: { source: 'creative-briefs:render', briefId: brief.briefId, templateId: template.templateId },
      marketing,
      contentHash,
    });
    mediaAssetId = asset.assetId;
  }

  const record: CreativeRender = {
    renderId: `crender:${randomUUID()}`,
    tenantId, orgId,
    briefId: brief.briefId,
    briefVersion: brief.version,
    templateId: template.templateId,
    templateVersion: template.version,
    ...(directionIndex !== undefined ? { directionIndex } : {}),
    ...(overrides ? { overrides } : {}),
    copy,
    layerAssets,
    brand: snapshot,
    warnings,
    compositeHash,
    mediaAssetId,
    ...(animate ? { animation: animate } : {}),
    createdBy: actor,
    createdAt: nowIso(),
  };
  await renders.put(record);

  // R0399-2 — the pre-flight count check (above) is TOCTOU: parallel renders
  // can each pass it and overshoot the cap. A deterministic post-write recheck
  // closes it convergently — every racing writer sorts the SAME way (createdAt,
  // then renderId) and prunes the SAME newest-beyond-cap overflow, keeping the
  // oldest MAX (matching the "delete old renders first" intent). If OUR row is
  // in the overflow, it never persists: prune it and fail typed BEFORE stamping
  // usage refs. The composed media asset stays (media owns its lifecycle — a
  // deliberate library asset), like every other render-delete.
  const forBrief = (await renders.listByPrefix(`${tenantId}:${orgId}:${brief.briefId}:`))
    .sort((a, b) => (a.createdAt === b.createdAt ? a.renderId.localeCompare(b.renderId) : a.createdAt.localeCompare(b.createdAt)));
  if (forBrief.length > renderCap) {
    const overflow = forBrief.slice(renderCap); // newest beyond the cap
    for (const o of overflow) await renders.delete(`${o.tenantId}:${o.orgId}:${o.briefId}:${o.renderId}`);
    if (overflow.some((o) => o.renderId === record.renderId)) {
      throw new OpenwopError('validation_error', `Render cap reached for this brief (${renderCap}) — delete old renders first.`, 400, {});
    }
  }

  // R0399-1 — the layer assets a render CONSUMED join the "used in N" graph
  // under their OWN ref kind (the mood-board sync owns `creative-brief`; a
  // shared kind would clobber). Best-effort like the mood-board stamping.
  try {
    const tokens: string[] = [];
    for (const la of Object.values(layerAssets)) {
      const a = la ? await getAsset(tenantId, orgId, la.mediaAssetId) : null;
      if (a) tokens.push(a.serveToken);
    }
    if (tokens.length > 0) {
      await syncUsageRefs(tenantId, orgId, { kind: 'creative-render', id: record.renderId, label: `${brief.title} — ${template.templateId}` }, tokens);
    }
  } catch (err) {
    log.warn('render usage-ref stamping failed', { renderId: record.renderId, error: err instanceof Error ? err.message : String(err) });
  }
  log.info('rendered ad creative', { briefId: brief.briefId, templateId: template.templateId, mediaAssetId, warnings: warnings.length });
  return record;
}

/** One brief → many platform-correct renders (ADR 0399 §3). Each template is
 *  an independent deterministic render; a per-template failure is reported,
 *  not thrown (partial success is useful — the caller sees exactly which
 *  formats landed). */
export async function renderVariantsForBrief(tenantId: string, orgId: string, actor: string, args: Omit<RenderBriefArgs, 'templateId'> & { templateIds: unknown }): Promise<{ renders: CreativeRender[]; failures: Array<{ templateId: string; error: string }> }> {
  const ids = Array.isArray(args.templateIds)
    ? args.templateIds.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, MAX.variantTemplates)
    : [];
  if (ids.length === 0) throw new OpenwopError('validation_error', '`templateIds` must be a non-empty array of template ids.', 400, { field: 'templateIds' });
  const out: CreativeRender[] = [];
  const failures: Array<{ templateId: string; error: string }> = [];
  for (const templateId of ids) {
    try {
      out.push(await renderForBrief(tenantId, orgId, actor, { ...args, templateId }));
    } catch (err) {
      failures.push({ templateId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { renders: out, failures };
}

export async function listRenders(tenantId: string, orgId: string, briefId: string): Promise<CreativeRender[]> {
  const brief = await getBrief(tenantId, orgId, briefId);
  if (!brief) throw new OpenwopError('not_found', 'Creative brief not found.', 404, { briefId });
  return (await renders.listByPrefix(`${tenantId}:${orgId}:${briefId}:`)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getRender(tenantId: string, orgId: string, briefId: string, renderId: string): Promise<CreativeRender | null> {
  return (await renders.get(`${tenantId}:${orgId}:${briefId}:${renderId}`)) ?? null;
}

export async function deleteRender(tenantId: string, orgId: string, briefId: string, renderId: string): Promise<boolean> {
  const r = await getRender(tenantId, orgId, briefId, renderId);
  if (!r) return false;
  // The record dies; the media asset stays — it is a library asset the org may
  // already have dispatched or reused (media owns its own lifecycle).
  await renders.delete(`${tenantId}:${orgId}:${briefId}:${renderId}`);
  try { await clearUsageForRef(tenantId, orgId, 'creative-render', renderId); } catch { /* best-effort bookkeeping */ }
  return true;
}

/** Brief-delete cascade (wired from deleteBrief) — render records are children
 *  of the brief; the composed media assets survive as library assets. */
export async function deleteRendersForBrief(tenantId: string, orgId: string, briefId: string): Promise<number> {
  const rows = await renders.listByPrefix(`${tenantId}:${orgId}:${briefId}:`);
  for (const r of rows) {
    await renders.delete(`${r.tenantId}:${r.orgId}:${r.briefId}:${r.renderId}`);
    try { await clearUsageForRef(tenantId, orgId, 'creative-render', r.renderId); } catch { /* best-effort bookkeeping */ }
  }
  return rows.length;
}

// Test-only.
export async function __clearCreativeRenders(): Promise<void> {
  for (const r of await renders.list()) await renders.delete(`${r.tenantId}:${r.orgId}:${r.briefId}:${r.renderId}`);
}

/**
 * DATB-1 — media-delete cascade (the ADR 0288 disposition taxonomy):
 *  - a render whose COMPOSED PNG (`mediaAssetId`) was deleted is PRUNED — the
 *    row is derived + regenerable and useless without its pixels (no preview,
 *    nothing to dispatch);
 *  - `layerAssets` refs to a deleted INPUT are TOLERATED — historical
 *    provenance of what produced the pixels, never re-resolved.
 * Bounded: one per-(tenant, org) prefix scan; registration is keyed, so
 * repeated boots overwrite (idempotent).
 */
export function registerRenderMediaCascade(): void {
  onMediaAssetDeleted('creative-briefs:render', async ({ tenantId, orgId, assetId }) => {
    const rows = (await renders.listByPrefix(`${tenantId}:${orgId}:`)).filter((r) => r.mediaAssetId === assetId);
    for (const r of rows) {
      await renders.delete(`${r.tenantId}:${r.orgId}:${r.briefId}:${r.renderId}`);
    }
    if (rows.length > 0) log.info('pruned renders for deleted composed asset', { assetId, pruned: rows.length });
  });
}

// ── ADR 0411 P3 — reel (video) renders ──────────────────────────────────────

/** Derive a deterministic text-to-video PROMPT from a brief's production fields
 *  (the closed set the creative-briefs model already carries). Pure — the
 *  reel node feeds this to `ctx.callVideoGenerator`; testable in isolation. */
export function reelPromptForBrief(brief: CreativeBrief, directionIndex?: number): string {
  const dir = directionIndex != null ? brief.directions[directionIndex] : undefined;
  return [
    brief.title,
    dir?.label,
    brief.sceneDescription,
    brief.composition ? `Composition: ${brief.composition}` : undefined,
    brief.cameraAngle ? `Camera: ${brief.cameraAngle}` : undefined,
    brief.lighting ? `Lighting: ${brief.lighting}` : undefined,
    brief.messagingIntent ? `Message: ${brief.messagingIntent}` : undefined,
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).join('. ');
}

/** Store a generated REEL as a `CreativeRender` (the `reel` marker discriminates
 *  it from an image render; `mediaAssetId` is the video's host Media token).
 *  Real brand snapshot via `resolveBrandTokens`; `layerAssets` is empty (a reel
 *  has no composed image layers — honest, not a stub). Shares the per-brief cap
 *  + the Media-delete cascade with image renders. */
export async function storeReelRender(args: {
  tenantId: string; orgId: string; briefId: string; actor: string;
  videoAssetId: string; prompt: string;
  /** Deterministic `crender:`-prefixed id so a re-run/`:fork`/replay of the
   *  generate-reel RUN converges instead of minting a duplicate render (the
   *  createTask precedent). Omitted ⇒ a fresh id (a direct, non-run call). */
  renderId?: string;
  brandId?: string; directionIndex?: number; durationSeconds?: number; aspectRatio?: string; provider?: string;
}): Promise<CreativeRender> {
  if (args.renderId !== undefined && !args.renderId.startsWith('crender:')) {
    throw new OpenwopError('validation_error', 'renderId must be `crender:`-prefixed.', 400, { field: 'renderId' });
  }
  const brief = await getBrief(args.tenantId, args.orgId, args.briefId);
  if (!brief) throw new OpenwopError('not_found', 'Creative brief not found.', 404, { briefId: args.briefId });
  // Idempotent by deterministic id: a re-run/replay/fork of the generate-reel
  // run converges on the SAME render instead of duplicating (+ dodges the cap).
  if (args.renderId) {
    const existing = await renders.get(`${args.tenantId}:${args.orgId}:${brief.briefId}:${args.renderId}`);
    if (existing) return existing;
  }
  const existingCount = (await renders.listByPrefix(`${args.tenantId}:${args.orgId}:${brief.briefId}:`)).length;
  if (existingCount >= renderCap) {
    throw new OpenwopError('validation_error', `Render cap reached for this brief (${renderCap}) — delete old renders first.`, 400, {});
  }
  const warnings: RenderWarning[] = [];
  const brand = await resolveBrandTokens(args.tenantId, args.orgId, brief, args.brandId, warnings);
  const aspect = args.aspectRatio ?? '9:16';
  const record: CreativeRender = {
    renderId: args.renderId ?? `crender:${randomUUID()}`,
    tenantId: args.tenantId, orgId: args.orgId,
    briefId: brief.briefId, briefVersion: brief.version,
    templateId: `reel-${aspect.replace(':', 'x')}`, templateVersion: 1,
    ...(args.directionIndex !== undefined ? { directionIndex: args.directionIndex } : {}),
    copy: { headline: brief.title },
    layerAssets: {},
    brand: brand.snapshot,
    warnings,
    compositeHash: createHash('sha256').update(stableStringify({ reel: args.prompt, video: args.videoAssetId, aspect })).digest('hex'),
    mediaAssetId: args.videoAssetId,
    reel: {
      prompt: args.prompt,
      ...(args.durationSeconds != null ? { durationSeconds: args.durationSeconds } : {}),
      ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
      ...(args.provider ? { provider: args.provider } : {}),
    },
    createdBy: args.actor,
    createdAt: nowIso(),
  };
  await renders.put(record);
  return record;
}
