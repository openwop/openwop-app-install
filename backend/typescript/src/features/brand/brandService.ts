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
import { getGovernancePolicy } from '../../host/governanceService.js';
import { createLogger } from '../../observability/logger.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString, safeUrl } from '../../host/boundedStrings.js';
import {
  BRAND_CHANNELS,
  BRAND_COLOR_KEYS,
  GENERATOR_OWNED_TOKENS,
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

import { purgeBrandFonts } from './brandFonts.js';

const brands = new DurableCollection<Brand>('brand:brand', (b) => `${b.tenantId}::${b.id}`);

const log = createLogger('brand.service');

const NAME_MAX = 160;
const TEXT_MAX = 4000;
const PHRASE_MAX = 400;
const LIST_MAX = 100; // max items in any string-list field

/** Caller-supplied brand shape (everything optional except name/orgId on create). */
export interface BrandInput {
  /** R2 BR-SP-5 — optimistic-concurrency guard: reject (409) if the brand's
   *  updatedAt no longer matches. Absent = legacy unconditional write. */
  expectedUpdatedAt?: string;
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
  // ADR 0354 P4 — a channel may now carry PERSONA-bound variants beside its
  // generic rule, so dedupe on (channel, personaId) and size the cap for them.
  for (const item of raw.slice(0, BRAND_CHANNELS.length * 4)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const channel = cleanString(r.channel, 40);
    const personaId = typeof r.personaId === 'string' && r.personaId.trim() ? cleanString(r.personaId, 120) : undefined;
    const dedupeKey = `${channel}::${personaId ?? ''}`;
    if (!CHANNEL_SET.has(channel) || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const maxLengthN = Number(r.maxLength);
    out.push({
      ...(personaId ? { personaId } : {}),
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

export function sanitizeGovernance(raw: unknown): BrandGovernance {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GOVERNANCE };
  const g = raw as Record<string, unknown>;
  const lockLevel = g.lockLevel === 'partial' || g.lockLevel === 'full' ? g.lockLevel : 'none';
  const bp = (g.compliance as Record<string, unknown> | undefined)?.blockPublish;
  const bt = (g.compliance as Record<string, unknown> | undefined)?.blockThreshold;
  return {
    lockLevel,
    allowedEditors: strList(g.allowedEditors, NAME_MAX),
    requireApproval: g.requireApproval === true,
    ...(bp === 'critical' || bp === 'threshold'
      ? { compliance: { blockPublish: bp, ...(typeof bt === 'number' && Number.isFinite(bt) ? { blockThreshold: Math.max(0, Math.min(100, Math.floor(bt))) } : {}) } }
      : {}),
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
/** Contrast-bearing tokens are generator-owned (ADR 0510 §5 — see types.ts). */
const CONTRAST_CRITICAL = new Set<string>(GENERATOR_OWNED_TOKENS);
const enumOr = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/** Advanced-tier override map: ONLY allowlisted tokens, each value CSS-grammar-safe
 *  (these are injected to `:root` at runtime, so this is a security control). */
function sanitizeOverrideMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!THEMEABLE.has(k) || CONTRAST_CRITICAL.has(k)) continue; // closed allowlist; contrast roles remain generator-owned
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
    markSrcDark: safeBrandAsset(logoRaw.markSrcDark),
    lockupSrcDark: safeBrandAsset(logoRaw.lockupSrcDark),
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
  // BRAND-CODE-7 — the audit trail is best-effort: an audit-write failure must
  // never 500 a mutation that already applied. Still awaited (happy path stays
  // ordered before the response); a failure logs at warn.
  try { await recordBrandAudit(tenantId, brand.id, createdBy, null, brand); }
  catch (e) { log.warn('brand audit write failed (create) — mutation applied, trail incomplete', { brandId: brand.id, error: e instanceof Error ? e.message : String(e) }); }
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
  actor = 'editor',
): Promise<Brand | null> {
  const existing = await getBrand(tenantId, brandId);
  if (!existing) return null;
  // R2 BR-SP-5 — optimistic-concurrency precondition: the editor seeds from
  // its list-fetch-time row and each facet replaces wholesale, so a stale
  // save silently clobbered a concurrent edit (including its invisible
  // fields). An `expectedUpdatedAt` mismatch is a 409, never a clobber.
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== existing.updatedAt) {
    throw new OpenwopError('conflict', 'This brand changed since you opened it — reload and reapply your edits.', 409, { brandId, expected: input.expectedUpdatedAt, actual: existing.updatedAt });
  }
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
  // BRAND-CODE-7 — best-effort audit (see createBrand).
  try { await recordBrandAudit(tenantId, next.id, actor, existing, next); }
  catch (e) { log.warn('brand audit write failed (update) — mutation applied, trail incomplete', { brandId: next.id, error: e instanceof Error ? e.message : String(e) }); }
  return next;
}

/** Delete a brand. Returns false when the id is absent/foreign-tenant. */
export async function deleteBrand(tenantId: string, brandId: string): Promise<boolean> {
  const existing = await getBrand(tenantId, brandId);
  if (!existing) return false;
  const deleted = await brands.delete(tenantKey(tenantId, brandId));
  // CS-DATA-7 — purge the brand's audit trail with it (tenant-erasure-friendly:
  // no orphaned `brand:audit` rows outliving the entity they describe). Best-effort.
  try {
    for (const row of await brandAudit.listByPrefix(`${tenantId}:${brandId}:`)) {
      await brandAudit.delete(`${row.tenantId}:${row.brandId}:${row.auditId}`);
    }
  } catch (e) {
    log.warn('brand audit purge on delete failed — orphaned audit rows may remain', { brandId, error: e instanceof Error ? e.message : String(e) });
  }
  // ADR 0399 OQ-1 (C1) — the brand's custom fonts die with it (no orphan rows).
  try { await purgeBrandFonts(tenantId, brandId); }
  catch (e) { log.warn('brand font purge on delete failed — orphaned font rows may remain', { brandId, error: e instanceof Error ? e.message : String(e) }); }
  return deleted;
}

/** Test-only: drop every brand (mirrors strategy's `__clearStrategies`). */
export async function __clearBrands(): Promise<void> {
  await brands.__clear();
}

// ── ADR 0354 P3 — parent-brand cascade ───────────────────────────────────────

/** Effective guardrail rules for a brand: banned phrases and avoid-lists are
 *  ADDITIVE down the parentBrandId chain (a child extends, never removes);
 *  voice/tone stay nearest-wins (the child brand object itself). Cycle-guarded,
 *  depth ≤ 5. Pure aggregation over stored rows. */
export async function resolveEffectiveBrandRules(tenantId: string, brandId: string): Promise<{ bannedPhrases: string[]; avoidPhrases: string[] } | null> {
  const seen = new Set<string>();
  const banned = new Set<string>();
  const avoid = new Set<string>();
  let cur: string | undefined = brandId;
  let depth = 0;
  let found = false;
  while (cur && depth < 5 && !seen.has(cur)) {
    seen.add(cur);
    const b = await getBrand(tenantId, cur);
    if (!b) break;
    found = true;
    for (const ph of b.keyPhrases.bannedPhrases) banned.add(ph);
    for (const rule of b.channelVoiceRules) for (const ph of rule.avoidPhrases ?? []) avoid.add(ph);
    cur = b.parentBrandId;
    depth += 1;
  }
  return found ? { bannedPhrases: [...banned], avoidPhrases: [...avoid] } : null;
}

// ── ADR 0354 P5 — append-only rule-change audit ─────────────────────────────

export interface BrandAuditRow {
  auditId: string;
  tenantId: string;
  brandId: string;
  actor: string;
  changedAt: string;
  /** Field-level before → after for guardrail-relevant fields only. */
  changes: Array<{ field: string; from: unknown; to: unknown }>;
}
const brandAudit = new DurableCollection<BrandAuditRow>('brand:audit', (r) => `${r.tenantId}:${r.brandId}:${r.auditId}`);
const AUDIT_CAP = 500;
const AUDIT_FIELDS = ['keyPhrases', 'channelVoiceRules', 'governance', 'positioning', 'voiceProfile'] as const;

/** Record a guardrail-relevant diff (no-op when nothing relevant changed). */
export async function recordBrandAudit(tenantId: string, brandId: string, actor: string, before: Partial<Brand> | null, after: Partial<Brand>): Promise<void> {
  const changes: BrandAuditRow['changes'] = [];
  for (const f of AUDIT_FIELDS) {
    const b = before ? (before as Record<string, unknown>)[f] : undefined;
    const a = (after as Record<string, unknown>)[f];
    if (JSON.stringify(b) !== JSON.stringify(a)) changes.push({ field: f, from: b, to: a });
  }
  if (changes.length === 0) return;
  await brandAudit.put({ auditId: `ba:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, tenantId, brandId, actor, changedAt: new Date().toISOString(), changes });
  // BRAND-CODE-7 — the cap trim is best-effort: a trim failure must not lose
  // the audit row that just landed (cap enforcement simply defers to the next write).
  try {
    const rows = (await brandAudit.listByPrefix(`${tenantId}:${brandId}:`)).sort((x, y) => x.changedAt.localeCompare(y.changedAt));
    for (const stale of rows.slice(0, Math.max(0, rows.length - AUDIT_CAP))) await brandAudit.delete(`${stale.tenantId}:${stale.brandId}:${stale.auditId}`);
  } catch (e) {
    log.warn('brand audit trim failed — cap enforcement deferred', { brandId, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function listBrandAudit(tenantId: string, brandId: string): Promise<BrandAuditRow[]> {
  return (await brandAudit.listByPrefix(`${tenantId}:${brandId}:`)).sort((x, y) => y.changedAt.localeCompare(x.changedAt) || y.auditId.localeCompare(x.auditId));
}

// ── ADR 0354 P1 — the ads-dispatch compliance checker ────────────────────────

/**
 * Build the checker the brand feature registers on the adsAdapter seam. Policy
 * lives on the BRAND the campaign brief binds; content is scored with the
 * deterministic scorer over EFFECTIVE (cascaded) rules. FAIL-CLOSED: under a
 * non-off policy, a policy/scoring failure returns requires-approval — a
 * governance error must never open the dispatch edge.
 */
type ComplianceVerdict = { verdict: 'allow' | 'requires-approval'; reason?: string; score?: number };

/** The compliance ENFORCEMENT policy shape shared by a brand's own
 *  `governance.compliance` (briefed path) and the tenant-default
 *  `GovernancePolicy.brandCompliance` (BRAND-CODE-6 unbriefed path). */
type CompliancePolicy = { blockPublish: 'off' | 'critical' | 'threshold'; blockThreshold?: number };

/**
 * The ONE deterministic scorer both dispatch legs share (BRAND-CODE-6): score
 * `content` against `brand`'s EFFECTIVE (parent-cascaded) rules under
 * `compliancePolicy`. Caller guarantees `blockPublish !== 'off'`. FAIL-CLOSED:
 * any brand-load/scoring crash returns requires-approval — a policy MAY exist we
 * could not evaluate, so we never silently open the dispatch edge.
 */
async function scoreBrandCompliance(
  tenantId: string,
  brand: Brand,
  compliancePolicy: CompliancePolicy,
  content: string,
): Promise<ComplianceVerdict> {
  try {
    const effective = await resolveEffectiveBrandRules(tenantId, brand.id);
    const { scoreComplianceDeterministic } = await import('./scoring.js');
    const report = scoreComplianceDeterministic(content, brand, {
      ...(effective ? { extraBannedPhrases: effective.bannedPhrases.filter((p) => !brand.keyPhrases.bannedPhrases.includes(p)) } : {}),
    });
    const banned = report.issues.some((i) => i.category === 'banned-phrase');
    if (compliancePolicy.blockPublish === 'critical' && banned) {
      return { verdict: 'requires-approval', reason: 'banned phrase in ad content', score: report.deterministicScore };
    }
    if (compliancePolicy.blockPublish === 'threshold' && report.deterministicScore < (compliancePolicy.blockThreshold ?? 60)) {
      return { verdict: 'requires-approval', reason: `compliance score below threshold (${compliancePolicy.blockThreshold ?? 60})`, score: report.deterministicScore };
    }
    return { verdict: 'allow', score: report.deterministicScore };
  } catch (e) {
    return { verdict: 'requires-approval', reason: `compliance evaluation failed (${e instanceof Error ? e.message : 'error'}) — failing closed` };
  }
}

export function buildAdsComplianceChecker(
  resolveBrandIdForBrief: (tenantId: string, briefId: string) => Promise<string | undefined>,
): (tenantId: string, args: { briefId?: string; platform: string; content: string }) => Promise<ComplianceVerdict> {
  return async (tenantId, args) => {
    // Resolver leg — fails OPEN: a missing/unresolvable brand BINDING must not
    // block unbranded dispatch (the pre-0354 behavior).
    let brandId: string | undefined;
    try {
      brandId = args.briefId ? await resolveBrandIdForBrief(tenantId, args.briefId) : undefined;
    } catch {
      return { verdict: 'allow' };
    }
    if (!brandId) {
      // BRAND-CODE-6 — unbriefed dispatch (no brand bound). Instead of an
      // unconditional allow, consult the tenant-DEFAULT brand compliance policy:
      // when one names a `defaultBrandId` under a non-off posture, score against
      // that brand's rules through the SAME scorer the briefed path uses. Fail
      // OPEN (allow) when no policy / off / no default / the default brand row is
      // gone — matching the resolver-leg posture.
      let policy: CompliancePolicy;
      let defaultBrandId: string;
      try {
        const gov = (await getGovernancePolicy(tenantId))?.brandCompliance;
        if (!gov || gov.blockPublish === 'off' || !gov.defaultBrandId) return { verdict: 'allow' };
        policy = { blockPublish: gov.blockPublish, ...(gov.blockThreshold !== undefined ? { blockThreshold: gov.blockThreshold } : {}) };
        defaultBrandId = gov.defaultBrandId;
      } catch {
        // A governance-store read failure on the UNBRIEFED path leaves us unable
        // to know a default even exists — preserve the pre-0354 open posture.
        return { verdict: 'allow' };
      }
      const defaultBrand = await getBrand(tenantId, defaultBrandId).catch(() => null);
      if (!defaultBrand) {
        // A configured default that doesn't resolve is a real misconfig signal —
        // log it, but fail OPEN (an unbriefed dispatch was ungoverned before).
        log.warn('brand compliance: tenant defaultBrandId does not resolve — allowing (fail-open)', { tenantId, defaultBrandId });
        return { verdict: 'allow' };
      }
      return scoreBrandCompliance(tenantId, defaultBrand, policy, args.content);
    }
    // Policy leg — fails CLOSED (BRAND-CODE-2 grade fix): once a brandId IS
    // known, a brand-load/scoring crash means a policy MAY exist that we could
    // not evaluate — requires-approval, never a silent allow.
    let brand: Brand | null;
    try {
      brand = await getBrand(tenantId, brandId);
    } catch (e) {
      return { verdict: 'requires-approval', reason: `compliance evaluation failed (${e instanceof Error ? e.message : 'error'}) — failing closed` };
    }
    const policy = brand?.governance?.compliance;
    if (!brand || !policy || policy.blockPublish === 'off') return { verdict: 'allow' };
    return scoreBrandCompliance(tenantId, brand, policy, args.content);
  };
}
