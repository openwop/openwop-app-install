/**
 * Brand service (ADR 0155). Owns the `Brand` entity — CRUD on the generic
 * `DurableCollection` (no schema migration), tenant + org keyed for CTI-1
 * isolation. Every read/write is tenant-scoped; a foreign-tenant id reads `null`
 * (fail-closed, the route maps that to a uniform 404 — no existence leak).
 *
 * Pure domain logic only — RBAC + toggle gating live in routes.ts; the compliance
 * scorer + voice resolver are pure library fns in scoring.ts (Phase 2).
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString, safeUrl } from '../../host/boundedStrings.js';
import {
  BRAND_CHANNELS,
  BRAND_COLOR_KEYS,
  THEMEABLE_TOKENS,
  DEFAULT_GOVERNANCE,
  EMPTY_KEY_PHRASES,
  EMPTY_POSITIONING,
  EMPTY_VOICE_PROFILE,
  type Brand,
  type BrandChannel,
  type BrandColorKey,
  type BrandGovernance,
  type BrandIdentity,
  type BrandTheme,
  type BrandKeyPhrases,
  type BrandPositioning,
  type BrandVoiceProfile,
  type ChannelVoiceRule,
  type ToneRegister,
} from './types.js';

const brands = new DurableCollection<Brand>('brand:brand', (b) => `${b.tenantId}::${b.id}`);

const NAME_MAX = 160;
const TEXT_MAX = 4000;
const PHRASE_MAX = 400;
const LIST_MAX = 100; // max items in any string-list field

/** Caller-supplied brand shape (everything optional except name/orgId on create). */
export interface BrandInput {
  name?: unknown;
  description?: unknown;
  parentBrandId?: unknown;
  voiceProfile?: unknown;
  positioning?: unknown;
  keyPhrases?: unknown;
  channelVoiceRules?: unknown;
  governance?: unknown;
  identity?: unknown;
  status?: unknown;
}

const strList = (raw: unknown, max = PHRASE_MAX): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, LIST_MAX)
    .map((v) => cleanString(v, max))
    .filter((v) => v.length > 0);
};

const clampFormality = (raw: unknown, fallback = 3): number => {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : fallback;
};

const optFormality = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : undefined;
};

function sanitizeToneRegister(raw: unknown): ToneRegister | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = cleanString(r.name, NAME_MAX);
  if (!name) return null;
  return {
    name,
    description: cleanString(r.description, TEXT_MAX),
    formalityLevel: optFormality(r.formalityLevel),
    samplePhrases: strList(r.samplePhrases),
    avoidPhrases: strList(r.avoidPhrases),
  };
}

function sanitizeVoiceProfile(raw: unknown): BrandVoiceProfile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_VOICE_PROFILE };
  const v = raw as Record<string, unknown>;
  return {
    voice: cleanString(v.voice, TEXT_MAX),
    guidelines: cleanString(v.guidelines, TEXT_MAX),
    formalityLevel: clampFormality(v.formalityLevel),
    samplePhrases: strList(v.samplePhrases),
    avoidPhrases: strList(v.avoidPhrases),
    toneRegisters: Array.isArray(v.toneRegisters)
      ? v.toneRegisters.slice(0, LIST_MAX).map(sanitizeToneRegister).filter((t): t is ToneRegister => t !== null)
      : [],
  };
}

function sanitizePositioning(raw: unknown): BrandPositioning {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_POSITIONING };
  const p = raw as Record<string, unknown>;
  return {
    tagline: cleanString(p.tagline, NAME_MAX),
    elevatorPitch: cleanString(p.elevatorPitch, TEXT_MAX),
    differentiators: strList(p.differentiators),
    competitiveFrame: cleanString(p.competitiveFrame, TEXT_MAX),
  };
}

function sanitizeKeyPhrases(raw: unknown): BrandKeyPhrases {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_KEY_PHRASES };
  const k = raw as Record<string, unknown>;
  return {
    approvedTaglines: strList(k.approvedTaglines),
    valuePropositions: strList(k.valuePropositions),
    productDescriptors: strList(k.productDescriptors),
    bannedPhrases: strList(k.bannedPhrases),
  };
}

const CHANNEL_SET = new Set<string>(BRAND_CHANNELS);

function sanitizeChannelRules(raw: unknown): ChannelVoiceRule[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ChannelVoiceRule[] = [];
  for (const item of raw.slice(0, BRAND_CHANNELS.length)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const channel = cleanString(r.channel, 40);
    if (!CHANNEL_SET.has(channel) || seen.has(channel)) continue;
    seen.add(channel);
    const maxLengthN = Number(r.maxLength);
    out.push({
      channel: channel as BrandChannel,
      tone: cleanString(r.tone, NAME_MAX),
      formalityOverride: optFormality(r.formalityOverride),
      maxLength: Number.isFinite(maxLengthN) && maxLengthN > 0 ? Math.round(maxLengthN) : undefined,
      samplePhrases: strList(r.samplePhrases),
      avoidPhrases: strList(r.avoidPhrases),
    });
  }
  return out;
}

function sanitizeGovernance(raw: unknown): BrandGovernance {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GOVERNANCE };
  const g = raw as Record<string, unknown>;
  const lockLevel = g.lockLevel === 'partial' || g.lockLevel === 'full' ? g.lockLevel : 'none';
  return {
    lockLevel,
    allowedEditors: strList(g.allowedEditors, NAME_MAX),
    requireApproval: g.requireApproval === true,
  };
}

// ── Identity facet (ADR 0170) ────────────────────────────────────────────────
// These values are injected into `:root` AND inlined into a serve-time `<style>`
// block (Phase 5), so the validators below double as CSS-injection controls:
// every accepted value is free of `;{}<>()`-style CSS metacharacters.

const ASSET_MAX = 8192; // a small `data:` SVG favicon fits; raster logos use a URL (Phase 8 media)
const COLOR_MAX = 64;
const FONT_MAX = 200;
const ASSET_DATA = /^data:image\/(svg\+xml|png|x-icon|vnd\.microsoft\.icon|jpeg|webp)[;,]/i;
// Function-form color: inner charset has NO `(`/`;`/`{`/`}`/`<`/`>`, so nesting/injection is impossible.
const COLOR_FN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([a-z0-9%.,/\s+-]*\)$/i;
const COLOR_HEX = /^#[0-9a-f]{3,8}$/i;
const COLOR_WORD = new Set(['transparent', 'currentcolor', 'inherit']);
const FONT_STACK = /^[a-z0-9 ,"'._-]+$/i; // family names + fallbacks only — no CSS metacharacters

/** A CSS-safe color string, or '' if it isn't one (rejects injection vectors). */
function safeColor(raw: unknown): string {
  const v = cleanString(raw, COLOR_MAX);
  if (!v) return '';
  if (COLOR_HEX.test(v) || COLOR_FN.test(v) || COLOR_WORD.has(v.toLowerCase())) return v;
  return '';
}

/** A CSS-safe font-family stack, or '' (no metacharacters). */
function safeFontStack(raw: unknown): string {
  const v = cleanString(raw, FONT_MAX);
  return v && FONT_STACK.test(v) ? v : '';
}

/** A bounded asset URL: https / root-relative / small `data:image` only. */
function safeBrandAsset(raw: unknown): string {
  const v = cleanString(raw, ASSET_MAX);
  if (!v) return '';
  if (ASSET_DATA.test(v)) return v; // safe image data URI (favicon SVG, etc.)
  return safeUrl(v, ASSET_MAX); // https / mailto / relative; dangerous schemes → ''
}

/** Drop empty-string keys so an identity object never stores blanks. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined || val === '' || (Array.isArray(val) && val.length === 0)) continue;
    out[k] = val;
  }
  return Object.keys(out).length ? (out as Partial<T>) : undefined;
}

/** Sanitize the visual-identity facet (ADR 0170). Returns `undefined` when absent
 *  so the facet is omitted entirely rather than stored as an empty husk. */
const THEMEABLE = new Set<string>(THEMEABLE_TOKENS);
const enumOr = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/** Advanced-tier override map: ONLY allowlisted tokens, each value CSS-grammar-safe
 *  (these are injected to `:root` at runtime, so this is a security control). */
function sanitizeOverrideMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!THEMEABLE.has(k)) continue; // closed allowlist — no arbitrary CSS properties
    const c = safeColor(v);
    if (c) out[k] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Sanitize the generative theme inputs (ADR 0171): seeds via the CSS-grammar color
 *  guard, scalars enum-clamped, the override map allowlisted + value-validated. */
function sanitizeTheme(raw: unknown): BrandTheme | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const ov = (t.override && typeof t.override === 'object' ? t.override : {}) as Record<string, unknown>;
  const override = compact({ light: sanitizeOverrideMap(ov.light), dark: sanitizeOverrideMap(ov.dark) });
  return compact({
    defaultMode: enumOr(t.defaultMode, ['system', 'light', 'dark'] as const),
    accentSeed: safeColor(t.accentSeed),
    neutralSeed: safeColor(t.neutralSeed),
    secondarySeed: safeColor(t.secondarySeed),
    contrastLevel: enumOr(t.contrastLevel, ['standard', 'medium', 'high'] as const),
    radius: enumOr(t.radius, ['sm', 'md', 'lg'] as const),
    density: enumOr(t.density, ['compact', 'comfortable'] as const),
    override,
  }) as BrandTheme | undefined;
}

function sanitizeIdentity(raw: unknown): BrandIdentity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const wordmarkRaw = (r.wordmark && typeof r.wordmark === 'object' ? r.wordmark : {}) as Record<string, unknown>;
  const wordmark = compact({
    pre: cleanString(wordmarkRaw.pre, NAME_MAX),
    emphasis: cleanString(wordmarkRaw.emphasis, NAME_MAX),
    sub: cleanString(wordmarkRaw.sub, NAME_MAX),
  });

  const logoRaw = (r.logo && typeof r.logo === 'object' ? r.logo : {}) as Record<string, unknown>;
  const logo = compact({
    markSrc: safeBrandAsset(logoRaw.markSrc),
    lockupSrc: safeBrandAsset(logoRaw.lockupSrc),
    faviconSrc: safeBrandAsset(logoRaw.faviconSrc),
  });

  const colorsRaw = (r.colors && typeof r.colors === 'object' ? r.colors : {}) as Record<string, unknown>;
  const colors: Partial<Record<BrandColorKey, string>> = {};
  for (const key of BRAND_COLOR_KEYS) {
    const c = safeColor(colorsRaw[key]);
    if (c) colors[key] = c;
  }

  const typoRaw = (r.typography && typeof r.typography === 'object' ? r.typography : {}) as Record<string, unknown>;
  const typography = compact({
    serif: safeFontStack(typoRaw.serif),
    sans: safeFontStack(typoRaw.sans),
    mono: safeFontStack(typoRaw.mono),
    fontsHref: safeUrl(typoRaw.fontsHref, ASSET_MAX),
  });

  const domainsRaw = (r.domains && typeof r.domains === 'object' ? r.domains : {}) as Record<string, unknown>;
  const domains = compact({
    primaryDomain: cleanString(domainsRaw.primaryDomain, NAME_MAX),
    homeUrl: safeUrl(domainsRaw.homeUrl, TEXT_MAX),
    repoUrl: safeUrl(domainsRaw.repoUrl, TEXT_MAX),
  });

  const policyRaw = (r.chromePolicy && typeof r.chromePolicy === 'object' ? r.chromePolicy : {}) as Record<
    string,
    unknown
  >;
  const chromePolicy = compact({
    showPoweredBy: typeof policyRaw.showPoweredBy === 'boolean' ? policyRaw.showPoweredBy : undefined,
    customFooter: cleanString(policyRaw.customFooter, TEXT_MAX),
    customCopyright: cleanString(policyRaw.customCopyright, NAME_MAX),
  });

  const identity = compact({
    productName: optionalCleanString(r.productName, NAME_MAX),
    wordmark,
    tagline: optionalCleanString(r.tagline, NAME_MAX),
    footerText: optionalCleanString(r.footerText, TEXT_MAX),
    instanceName: optionalCleanString(r.instanceName, NAME_MAX),
    assistantName: optionalCleanString(r.assistantName, NAME_MAX),
    documentTitle: optionalCleanString(r.documentTitle, NAME_MAX),
    logo,
    colors: Object.keys(colors).length ? colors : undefined,
    typography,
    theme: sanitizeTheme(r.theme),
    domains,
    chromePolicy,
  });
  return identity as BrandIdentity | undefined;
}

const tenantKey = (tenantId: string, id: string): string => `${tenantId}::${id}`;

/** List the tenant's brands (bounded prefix scan — never a cross-tenant `.list()`). */
export async function listBrands(tenantId: string, orgId?: string): Promise<Brand[]> {
  const all = await brands.listByPrefix(`${tenantId}::`);
  const scoped = orgId ? all.filter((b) => b.orgId === orgId) : all;
  return scoped.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Get one brand by id, tenant-scoped. Foreign tenant → `null` (no leak). */
export async function getBrand(tenantId: string, brandId: string): Promise<Brand | null> {
  const b = await brands.get(tenantKey(tenantId, brandId));
  return b && b.tenantId === tenantId ? b : null;
}

export async function createBrand(
  tenantId: string,
  orgId: string,
  createdBy: string,
  input: BrandInput,
): Promise<Brand> {
  const name = cleanString(input.name, NAME_MAX);
  if (!name) throw new OpenwopError('validation_error', 'A brand name is required.', 400, { field: 'name' });
  const now = new Date().toISOString();
  const identity = sanitizeIdentity(input.identity);
  const brand: Brand = {
    id: randomUUID(),
    tenantId,
    orgId,
    name,
    description: cleanString(input.description, TEXT_MAX),
    status: input.status === 'archived' ? 'archived' : 'active',
    parentBrandId: optionalCleanString(input.parentBrandId, NAME_MAX),
    voiceProfile: sanitizeVoiceProfile(input.voiceProfile),
    positioning: sanitizePositioning(input.positioning),
    keyPhrases: sanitizeKeyPhrases(input.keyPhrases),
    channelVoiceRules: sanitizeChannelRules(input.channelVoiceRules),
    governance: sanitizeGovernance(input.governance),
    ...(identity ? { identity } : {}),
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await brands.put(brand);
  return brand;
}

/** Ensure a brand with a FIXED id exists (idempotent create) — for reserved
 *  host-level brands like the app brand (`brand:host-app`, ADR 0170). Returns the
 *  EXISTING brand unchanged when present, so a super-admin's edits are never
 *  clobbered on a redeploy (the frozen-once-edited guarantee). Shares every
 *  sanitizer with `createBrand`; the brand store stays owned by this service. */
export async function ensureBrand(
  tenantId: string,
  orgId: string,
  brandId: string,
  createdBy: string,
  input: BrandInput,
): Promise<Brand> {
  const existing = await getBrand(tenantId, brandId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const identity = sanitizeIdentity(input.identity);
  const brand: Brand = {
    id: brandId,
    tenantId,
    orgId,
    name: cleanString(input.name, NAME_MAX) || 'Brand',
    description: cleanString(input.description, TEXT_MAX),
    status: 'active',
    voiceProfile: sanitizeVoiceProfile(input.voiceProfile),
    positioning: sanitizePositioning(input.positioning),
    keyPhrases: sanitizeKeyPhrases(input.keyPhrases),
    channelVoiceRules: sanitizeChannelRules(input.channelVoiceRules),
    governance: sanitizeGovernance(input.governance),
    ...(identity ? { identity } : {}),
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await brands.put(brand);
  return brand;
}

/** Patch a brand. Only the provided top-level fields are replaced (whole-field). */
export async function updateBrand(
  tenantId: string,
  brandId: string,
  input: BrandInput,
): Promise<Brand | null> {
  const existing = await getBrand(tenantId, brandId);
  if (!existing) return null;
  const next: Brand = {
    ...existing,
    name: input.name !== undefined ? cleanString(input.name, NAME_MAX) || existing.name : existing.name,
    description: input.description !== undefined ? cleanString(input.description, TEXT_MAX) : existing.description,
    status: input.status === 'archived' ? 'archived' : input.status === 'active' ? 'active' : existing.status,
    parentBrandId:
      input.parentBrandId !== undefined ? optionalCleanString(input.parentBrandId, NAME_MAX) : existing.parentBrandId,
    voiceProfile: input.voiceProfile !== undefined ? sanitizeVoiceProfile(input.voiceProfile) : existing.voiceProfile,
    positioning: input.positioning !== undefined ? sanitizePositioning(input.positioning) : existing.positioning,
    keyPhrases: input.keyPhrases !== undefined ? sanitizeKeyPhrases(input.keyPhrases) : existing.keyPhrases,
    channelVoiceRules:
      input.channelVoiceRules !== undefined ? sanitizeChannelRules(input.channelVoiceRules) : existing.channelVoiceRules,
    governance: input.governance !== undefined ? sanitizeGovernance(input.governance) : existing.governance,
    updatedAt: new Date().toISOString(),
  };
  // Identity facet (ADR 0170): whole-field replace when provided; a provided value
  // that sanitizes away clears it. `...existing` already carried any prior identity.
  if (input.identity !== undefined) {
    const nextIdentity = sanitizeIdentity(input.identity);
    if (nextIdentity) next.identity = nextIdentity;
    else delete next.identity;
  }
  await brands.put(next);
  return next;
}

/** Delete a brand. Returns false when the id is absent/foreign-tenant. */
export async function deleteBrand(tenantId: string, brandId: string): Promise<boolean> {
  const existing = await getBrand(tenantId, brandId);
  if (!existing) return false;
  return brands.delete(tenantKey(tenantId, brandId));
}

/** Test-only: drop every brand (mirrors strategy's `__clearStrategies`). */
export async function __clearBrands(): Promise<void> {
  await brands.__clear();
}
