/**
 * Media library (ADR 0007) — org-scoped collections + searchable asset metadata.
 * Bytes live in the storage adapter (`mediaStorage`); this owns the metadata
 * only, so `list()`/search never load content. Tenant + org scoped throughout
 * (CTI-1) — every read/write verifies the row's tenantId AND orgId, so a foreign
 * collection/asset reads as not-found (IDOR guard).
 *
 * @see docs/adr/0007-media-library.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { fireMediaAssetDeleted } from '../../host/mediaAssetLifecycle.js';
import { OpenwopError } from '../../types.js';
import { resolveHeadlessAi } from '../../host/headlessAi.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { cleanString, cleanTagList, optionalCleanString } from '../../host/boundedStrings.js';
import * as mediaStorage from './mediaStorage.js';

export interface MediaCollection {
  collectionId: string;
  tenantId: string;
  orgId: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

/** Asset lineage (campaign gap plan §5D D3 / ADR 0229) — OPTIONAL provenance for
 *  generated/derived assets: what it came from, the generation prompt, the model,
 *  and a rights note. Additive + sanitized (bounded strings); `generatedBy` is a
 *  closed vocabulary (only `'ai'` today) so a caller can't stamp arbitrary claims. */
export interface MediaAssetLineage {
  /** The source asset this one was derived from (a media `assetId`). */
  derivedFrom?: string;
  /** Provenance marker — only `'ai'` is recognized. */
  generatedBy?: 'ai';
  /** The generation prompt (bounded 2000 chars). */
  prompt?: string;
  /** The generating model id (bounded 120 chars). */
  model?: string;
  /** ADR 0401 — the dispatching provider (openai/google/replicate/mock). */
  provider?: string;
  /** ADR 0401 — which image op produced this asset. */
  op?: 'generate' | 'edit' | 'inpaint' | 'background-remove' | 'upscale';
  /** Usage-rights note, e.g. license/approval context (bounded 400 chars). */
  rightsNote?: string;
}

/** ADR 0352 Phase 1 — the typed marketing-metadata facet (CS-002). All fields
 *  optional + bounded; `personaIds` reference campaign-brief personas by id;
 *  `palette` holds dominant-color strings. Feeds the deterministic weighted
 *  selection (Phase 4) — free-form `tags` stay for everything else. */
/** A normalized (0–1) crop box. */
export interface MediaCropBox { x: number; y: number; w: number; h: number }

export interface MediaMarketing {
  product?: string;
  sku?: string;
  angle?: string;
  background?: string;
  industry?: string;
  personaIds?: string[];
  useCase?: string;
  palette?: string[];
}

export interface MediaAsset {
  assetId: string;
  tenantId: string;
  orgId: string;
  collectionId?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  storageRef: string;
  serveToken: string;
  tags: string[];
  uploadedBy: string;
  usageCount: number;
  lastUsedAt?: string;
  /** Optional provenance (ADR 0229) — absent for plain uploads. */
  lineage?: MediaAssetLineage;
  /** ADR 0352 P1 — typed marketing facet (absent = untagged). */
  marketing?: MediaMarketing;
  /** ADR 0352 P2 — SHA-256 of the stored bytes (hex). Dedup key; absent on
   *  rows uploaded before the facet shipped. */
  contentHash?: string;
  /** ADR 0352 P5 — platform crop GEOMETRIES (normalized 0–1 boxes derived from
   *  the autotag subject box; the FE crops via CSS/canvas — no raster
   *  derivation, no native image dependency). */
  renditions?: Partial<Record<'16:9' | '1:1' | '9:16', MediaCropBox>>;
  /** ADR 0363 P1 — accessibility alt text for image assets. `altTextSource`
   *  records provenance; `'decorative'` legitimately pairs with an EMPTY
   *  `altText` (a marked-decorative image renders `alt=""`). Absent on rows
   *  predating the field and on non-image assets. */
  altText?: string;
  altTextSource?: MediaAltTextSource;
  createdAt: string;
  updatedAt: string;
}

/** ADR 0363 P1 — provenance of an asset's alt text. `human` = hand-authored;
 *  `ai` = generated via the vision seam then user-applied; `decorative` = the
 *  author marked the image decorative (`altText:''`, `alt=""` at render). */
export type MediaAltTextSource = 'human' | 'ai' | 'decorative';

/** A view adds the (derived) serve URL — the metadata never persists a URL. */
export interface MediaAssetView extends MediaAsset {
  serveUrl: string;
}

/** DEBT-2 / MEDIA-CODE-2 — the media collections predate tenant-prefixed keys
 *  (deployed data; a key migration is off the table), so they opt into the
 *  GOV-1 tenant SECONDARY INDEX (`tenantOf`): hot paths read via
 *  `listForTenantIndexed(tenantId)` — a bounded scan of that tenant's
 *  `hostextidx:` marker slice — instead of full cross-tenant `list()` scans.
 *  Pre-index deployed rows are healed by the one-time `ensureTenantIndex`
 *  backfill on the first indexed read (sentinel-guarded full scan that writes a
 *  marker per existing row); every subsequent `put`/`compareAndSwap`/`delete`
 *  maintains the markers. Rows stay under their original keys — no migration.
 *
 *  `media:asset` additionally carries a VALIDATOR because its prefix is shared
 *  with the LEGACY byte-store (`inMemorySurfaces._legacyMediaBytes`, token-keyed
 *  `{token, tenantId, contentBase64, …}` rows with no `assetId`/`orgId` — see
 *  `listAssetsForTenant`'s note). The guard keeps byte rows out of `list()` and
 *  — crucially — out of the index backfill, so a byte row can never surface as
 *  a library asset or leave a bogus `undefined`-id marker. */
const isLibraryAsset = (parsed: unknown): MediaAsset | null => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const a = parsed as Partial<MediaAsset>;
  return typeof a.assetId === 'string' && typeof a.tenantId === 'string' && typeof a.orgId === 'string' ? (parsed as MediaAsset) : null;
};
const collections = new DurableCollection<MediaCollection>('media:collection', (c) => c.collectionId, undefined, (c) => c.tenantId);
const assets = new DurableCollection<MediaAsset>('media:asset', (a) => a.assetId, isLibraryAsset, (a) => a.tenantId);

/** Bounded (tenant, org) asset slice via the tenant index (DEBT-2). The
 *  `tenantId` re-check is belt-and-braces: marker keys are `:`-joined, so a
 *  pathological tenant id that is a `:`-prefix of another must never leak. */
async function assetsForOrg(tenantId: string, orgId: string): Promise<MediaAsset[]> {
  return (await assets.listForTenantIndexed(tenantId)).filter((a) => a.tenantId === tenantId && a.orgId === orgId);
}

const MAX = { name: 120, tag: 48, tags: 24, perOrgAssets: 1000, perOrgCollections: 200, perOrgBytes: 256 * 1024 * 1024, lineagePrompt: 2000, lineageRightsNote: 400, lineageModel: 120, lineageRef: 128 } as const;

/** Sentinel `?collectionId=` value selecting UNCATEGORIZED assets (those with no
 *  collection) — so the filter happens server-side, not over the wire. */
export const UNCATEGORIZED = 'none';

/**
 * Capacity gate (ADR 0007 code-review #2): reject a new asset that would push the
 * org past its count OR total-bytes limit. Called BEFORE bytes are stored, so an
 * over-cap upload never orphans bytes. 409 (the same status the count cap used).
 */
export async function assertOrgCapacity(tenantId: string, orgId: string, addBytes: number): Promise<void> {
  const orgAssets = await assetsForOrg(tenantId, orgId); // DEBT-2 — bounded tenant read, not a cross-tenant scan
  if (orgAssets.length >= MAX.perOrgAssets) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgAssets} assets.`, 409, { max: MAX.perOrgAssets });
  }
  const totalBytes = orgAssets.reduce((sum, a) => sum + a.sizeBytes, 0);
  if (totalBytes + addBytes > MAX.perOrgBytes) {
    throw new OpenwopError('validation_error', `This org has reached its media storage limit (${Math.round(MAX.perOrgBytes / (1024 * 1024))} MiB).`, 409, { maxBytes: MAX.perOrgBytes });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

const cleanName = (raw: string, fallback: string): string => cleanString(raw, MAX.name, fallback);
const cleanTags = (raw: unknown): string[] => cleanTagList(raw, { maxTags: MAX.tags, maxLen: MAX.tag });

/** ADR 0363 P1 — alt-text length cap (WCAG-friendly concise descriptions). */
const MAX_ALT_TEXT = 250;

/** Normalize a raw alt-text value: trim, collapse internal whitespace, cap at
 *  {@link MAX_ALT_TEXT}. Unlike {@link cleanName} the EMPTY STRING is a valid
 *  result (a decorative image) — no fallback is substituted. */
function cleanAltText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ALT_TEXT);
}

/** Validate an alt-text source against the closed enum; reject anything else
 *  (a client typo must not silently persist an unknown provenance). */
function coerceAltTextSource(raw: unknown): MediaAltTextSource {
  if (raw === 'human' || raw === 'ai' || raw === 'decorative') return raw;
  throw new OpenwopError('validation_error', 'Field `altTextSource` MUST be one of "human", "ai", "decorative".', 400, { altTextSource: raw });
}

/** Sanitize node/route-supplied lineage (ADR 0229): every field bounded, unknown
 *  keys dropped, `generatedBy` accepted only as the literal `'ai'`. Returns
 *  undefined when nothing valid survives — an empty lineage is never persisted. */
const MKT_STR = 160;
const MKT_LIST_MAX = 8;
/** Sanitize the marketing facet — bounded strings, capped lists; an empty or
 *  invalid object clears the facet (additive + reversible, mirrors lineage). */
export function cleanMarketing(raw: unknown): MediaMarketing | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? cleanString(v, MKT_STR, '') || undefined : undefined);
  const list = (v: unknown): string[] | undefined => Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => cleanString(x, MKT_STR, '')).filter(Boolean).slice(0, MKT_LIST_MAX)
    : undefined;
  const m: MediaMarketing = {
    ...(str(o.product) ? { product: str(o.product)! } : {}),
    ...(str(o.sku) ? { sku: str(o.sku)! } : {}),
    ...(str(o.angle) ? { angle: str(o.angle)! } : {}),
    ...(str(o.background) ? { background: str(o.background)! } : {}),
    ...(str(o.industry) ? { industry: str(o.industry)! } : {}),
    ...(list(o.personaIds)?.length ? { personaIds: list(o.personaIds)! } : {}),
    ...(str(o.useCase) ? { useCase: str(o.useCase)! } : {}),
    ...(list(o.palette)?.length ? { palette: list(o.palette)! } : {}),
  };
  return Object.keys(m).length > 0 ? m : undefined;
}

/** Sanitize renditions — each box normalized + clamped; junk dropped. */
export function cleanRenditions(raw: unknown): MediaAsset['renditions'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: NonNullable<MediaAsset['renditions']> = {};
  for (const key of ['16:9', '1:1', '9:16'] as const) {
    const b = (raw as Record<string, unknown>)[key];
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
    const x = n(o.x); const y = n(o.y); const w = n(o.w); const h = n(o.h);
    if (x === null || y === null || w === null || h === null || w === 0 || h === 0) continue;
    out[key] = { x, y, w, h };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** ADR 0352 P5 — derive the three platform crops from a subject box: the
 *  largest crop of each aspect inside the unit square, centered on the subject
 *  (clamped). Pure geometry — deterministic, no image processing. */
export function deriveRenditions(subject: MediaCropBox): NonNullable<MediaAsset['renditions']> {
  const cx = subject.x + subject.w / 2;
  const cy = subject.y + subject.h / 2;
  const mk = (ratio: number): MediaCropBox => {
    const h = Math.min(1, 1 / ratio);
    const w = h * ratio;
    const x = Math.max(0, Math.min(1 - w, cx - w / 2));
    const y = Math.max(0, Math.min(1 - h, cy - h / 2));
    const r = (v: number): number => Math.round(v * 1000) / 1000;
    return { x: r(x), y: r(y), w: r(w), h: r(h) };
  };
  return { '16:9': mk(16 / 9), '1:1': mk(1), '9:16': mk(9 / 16) };
}

export function cleanLineage(raw: unknown): MediaAssetLineage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: MediaAssetLineage = {};
  const derivedFrom = optionalCleanString(r.derivedFrom, MAX.lineageRef);
  if (derivedFrom) out.derivedFrom = derivedFrom;
  if (r.generatedBy === 'ai') out.generatedBy = 'ai';
  const prompt = optionalCleanString(r.prompt, MAX.lineagePrompt);
  if (prompt) out.prompt = prompt;
  const model = optionalCleanString(r.model, MAX.lineageModel);
  if (model) out.model = model;
  const provider = optionalCleanString(r.provider, 60);
  if (provider) out.provider = provider;
  if (r.op === 'generate' || r.op === 'edit' || r.op === 'inpaint' || r.op === 'background-remove' || r.op === 'upscale') out.op = r.op;
  const rightsNote = optionalCleanString(r.rightsNote, MAX.lineageRightsNote);
  if (rightsNote) out.rightsNote = rightsNote;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function viewAsset(a: MediaAsset): MediaAssetView {
  return { ...a, serveUrl: mediaStorage.serveUrl(a.serveToken) };
}

// ── Collections ─────────────────────────────────────────────────────────────

export async function createCollection(tenantId: string, orgId: string, name: string, createdBy: string): Promise<MediaCollection> {
  const existing = (await collections.listForTenantIndexed(tenantId)).filter((c) => c.tenantId === tenantId && c.orgId === orgId);
  if (existing.length >= MAX.perOrgCollections) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgCollections} collections.`, 409, { max: MAX.perOrgCollections });
  }
  const c: MediaCollection = {
    collectionId: `mcol:${randomUUID()}`,
    tenantId,
    orgId,
    name: cleanName(name, 'Untitled collection'),
    createdBy,
    createdAt: nowIso(),
  };
  await collections.put(c);
  return c;
}

export async function listCollections(tenantId: string, orgId: string): Promise<MediaCollection[]> {
  return (await collections.listForTenantIndexed(tenantId)).filter((c) => c.tenantId === tenantId && c.orgId === orgId);
}

export async function getCollection(tenantId: string, orgId: string, collectionId: string): Promise<MediaCollection | null> {
  const c = await collections.get(collectionId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

/** Delete a collection, RE-HOMING its assets to uncategorized (never orphan the
 *  bytes). Returns the counts touched. */
export async function deleteCollection(tenantId: string, orgId: string, collectionId: string): Promise<{ rehomed: number } | null> {
  const c = await getCollection(tenantId, orgId, collectionId);
  if (!c) return null;
  // DELIBERATELY the authoritative full scan, not the tenant index (DEBT-2):
  // this read DRIVES WRITES (re-homing), and an index miss ("delayed, not
  // lost") would strand an asset pointing at a deleted collection forever.
  // Collection deletion is rare; completeness wins over speed here.
  const orphans = (await assets.list()).filter((a) => a.tenantId === tenantId && a.orgId === orgId && a.collectionId === collectionId);
  await Promise.all(
    orphans.map((a) => {
      const next: MediaAsset = { ...a, updatedAt: nowIso() };
      delete next.collectionId;
      return assets.put(next);
    }),
  );
  await collections.delete(collectionId);
  return { rehomed: orphans.length };
}

// ── Assets ──────────────────────────────────────────────────────────────────

export async function createAsset(input: {
  tenantId: string;
  orgId: string;
  collectionId?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  storageRef: string;
  serveToken: string;
  tags?: unknown;
  uploadedBy: string;
  /** Optional provenance (ADR 0229) — sanitized via `cleanLineage`. */
  lineage?: unknown;
  /** ADR 0352 P1 — sanitized via `cleanMarketing`. */
  marketing?: unknown;
  /** ADR 0352 P2 — sha256 hex of the stored bytes (computed in the route). */
  contentHash?: string;
}): Promise<MediaAsset> {
  // Capacity (count + bytes) is asserted in the route BEFORE bytes are stored —
  // see assertOrgCapacity — so no over-cap upload reaches here with orphaned bytes.
  // A supplied collectionId MUST belong to this org (else uncategorized).
  let collectionId: string | undefined;
  if (input.collectionId) {
    const c = await getCollection(input.tenantId, input.orgId, input.collectionId);
    if (!c) throw new OpenwopError('not_found', 'Collection not found in this org.', 404, { collectionId: input.collectionId });
    collectionId = c.collectionId;
  }
  const ts = nowIso();
  const lineage = cleanLineage(input.lineage);
  const marketing = cleanMarketing(input.marketing);
  const a: MediaAsset = {
    assetId: `masset:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    ...(collectionId ? { collectionId } : {}),
    name: cleanName(input.name, 'untitled'),
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageRef: input.storageRef,
    serveToken: input.serveToken,
    tags: cleanTags(input.tags),
    uploadedBy: input.uploadedBy,
    usageCount: 0,
    ...(lineage ? { lineage } : {}),
    ...(marketing ? { marketing } : {}),
    ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  await assets.put(a);
  return a;
}

/** ADR 0352 P2 — deterministic filename→tags: strip the extension, split on
 *  `_`/`-`/space, keep 2–24-char alphanumeric-ish tokens (≤6). The spec's
 *  `product_angle_persona.ext` convention seeds searchable tags on bulk upload. */
export function parseFilenameTags(filename: string): string[] {
  const stem = filename.replace(/\.[a-z0-9]{1,8}$/i, '');
  return stem.split(/[_\-\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2 && t.length <= 24 && /^[a-z0-9][a-z0-9.]*$/.test(t))
    .slice(0, 6);
}

/** ADR 0352 P2 — dedup lookup: an asset with these exact bytes IN THE SAME
 *  collection context (same collection, or both uncategorized). Same bytes
 *  aimed at a DIFFERENT collection are a deliberate organizational copy, not a
 *  duplicate — swallowing them would silently discard the caller's intent
 *  (review finding). Bounded (tenant, org) slice via the tenant index (DEBT-2). */
export async function findAssetByContentHash(tenantId: string, orgId: string, contentHash: string, collectionId?: string): Promise<MediaAsset | null> {
  const orgAssets = await assetsForOrg(tenantId, orgId);
  return orgAssets.find((a) => a.contentHash === contentHash && (a.collectionId ?? '') === (collectionId ?? '')) ?? null;
}

/** MEDIA-CODE-5 / CS-DATA-8 — a dedup hit must not silently discard the
 *  caller's metadata: union the NEW tags in and fill the marketing-facet fields
 *  the existing row lacks (existing values always win; the existing name
 *  stays). No-op put avoided when nothing new arrived. Returns the (possibly
 *  updated) row. */
export async function mergeAssetMetadataOnDedup(
  existing: MediaAsset,
  incoming: { tags?: unknown; marketing?: unknown },
): Promise<MediaAsset> {
  const mergedTags = [...existing.tags];
  for (const t of cleanTags(incoming.tags)) {
    if (!mergedTags.includes(t) && mergedTags.length < MAX.tags) mergedTags.push(t);
  }
  const incomingMkt = cleanMarketing(incoming.marketing);
  const mergedMkt: MediaMarketing = { ...(incomingMkt ?? {}), ...(existing.marketing ?? {}) };
  const tagsChanged = mergedTags.length !== existing.tags.length;
  // Existing facet values always win, so a change is exactly "a key was added".
  const mktChanged = Object.keys(mergedMkt).length !== Object.keys(existing.marketing ?? {}).length;
  if (!tagsChanged && !mktChanged) return existing;
  const next: MediaAsset = {
    ...existing,
    tags: mergedTags,
    ...(Object.keys(mergedMkt).length > 0 ? { marketing: mergedMkt } : {}),
    updatedAt: nowIso(),
  };
  await assets.put(next);
  return next;
}

/** All assets in a tenant, ACROSS orgs — for the cross-source artifact Library (ADR 0083).
 *  Access is enforced PER-ORG by the caller (artifactProjection.listArtifacts).
 *  NOTE: the `media:asset` collection name is ALSO used by the host byte-store
 *  (`inMemorySurfaces._mediaAssets`, token-keyed raw bytes) — a pre-existing namespace
 *  overlap. `listAssets(tenant,org)` is shielded by its org filter; this tenant-wide scan is
 *  not, so we filter to real library assets (those carrying an `assetId` + `orgId`); the
 *  byte-store rows have neither (the collection's validator now also enforces
 *  this at the persistence boundary; the filter stays as belt-and-braces). */
export async function listAssetsForTenant(tenantId: string): Promise<MediaAsset[]> {
  return (await assets.listForTenantIndexed(tenantId)).filter((a) => a.tenantId === tenantId && typeof a.assetId === 'string' && typeof a.orgId === 'string');
}

export async function listAssets(
  tenantId: string,
  orgId: string,
  filter: { collectionId?: string; q?: string; tag?: string } = {},
): Promise<MediaAsset[]> {
  const q = filter.q?.trim().toLowerCase();
  const tag = filter.tag?.trim().toLowerCase();
  const collectionMatch = (a: MediaAsset): boolean => {
    if (filter.collectionId === undefined) return true;
    if (filter.collectionId === UNCATEGORIZED) return a.collectionId === undefined; // server-side uncategorized
    return a.collectionId === filter.collectionId;
  };
  return (await assetsForOrg(tenantId, orgId)).filter(
    (a) =>
      collectionMatch(a) &&
      (!q || a.name.toLowerCase().includes(q)) &&
      (!tag || a.tags.includes(tag)),
  );
}

export async function getAsset(tenantId: string, orgId: string, assetId: string): Promise<MediaAsset | null> {
  const a = await assets.get(assetId);
  return a && a.tenantId === tenantId && a.orgId === orgId ? a : null;
}

/** Tenant-scoped point lookup (ADR 0069) — resolves an asset by id without the
 *  caller knowing its org; the artifact workbench derives org FROM the record
 *  then authorizes against it. Tenant-isolated; never returns a foreign tenant's
 *  asset. */
export async function getAssetByIdForTenant(tenantId: string, assetId: string): Promise<MediaAsset | null> {
  const a = await assets.get(assetId);
  return a && a.tenantId === tenantId ? a : null;
}

export async function updateAsset(
  tenantId: string,
  orgId: string,
  assetId: string,
  patch: { name?: string; tags?: unknown; collectionId?: string | null; lineage?: unknown; marketing?: unknown; renditions?: unknown; altText?: string | null; altTextSource?: unknown },
): Promise<MediaAsset | null> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) return null;
  const next: MediaAsset = { ...a, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanName(patch.name, a.name);
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.lineage !== undefined) {
    // ADR 0229: same sanitizer as create; `lineage: null` (or an all-invalid
    // object) clears the record — additive + reversible, never partial-merged.
    const lineage = cleanLineage(patch.lineage);
    if (lineage) next.lineage = lineage;
    else delete next.lineage;
  }
  if (patch.marketing !== undefined) {
    // ADR 0352 P1 — same replace-or-clear semantics as lineage.
    const marketing = cleanMarketing(patch.marketing);
    if (marketing) next.marketing = marketing;
    else delete next.marketing;
  }
  if (patch.renditions !== undefined) {
    // ADR 0352 P5 — replace-or-clear.
    const renditions = cleanRenditions(patch.renditions);
    if (renditions) next.renditions = renditions;
    else delete next.renditions;
  }
  if (patch.altText !== undefined || patch.altTextSource !== undefined) {
    // ADR 0363 P1 — alt text + provenance. `altText: null` clears both fields.
    // Otherwise the source drives validation: `decorative` ⇒ empty alt is valid
    // (renders alt=""); `human`/`ai` ⇒ a non-empty ≤250-char description.
    if (patch.altText === null) {
      delete next.altText;
      delete next.altTextSource;
    } else {
      if (!a.contentType.startsWith('image/')) {
        throw new OpenwopError('validation_error', 'Alt text applies only to image assets.', 422, { contentType: a.contentType });
      }
      // Provenance: an explicit source wins; otherwise supplying `altText` marks a
      // human edit (never inherit a stale `ai` provenance), and a bare source-only
      // change keeps the current source.
      const source: MediaAltTextSource =
        patch.altTextSource !== undefined
          ? coerceAltTextSource(patch.altTextSource)
          : patch.altText !== undefined
            ? 'human'
            : (next.altTextSource ?? 'human');
      if (source === 'decorative') {
        next.altText = '';
        next.altTextSource = 'decorative';
      } else {
        const text = cleanAltText(patch.altText ?? next.altText ?? '');
        if (!text) {
          throw new OpenwopError('validation_error', 'Alt text is required for a non-decorative image. Use `altTextSource: "decorative"` to mark the image decorative instead.', 400, { assetId });
        }
        next.altText = text;
        next.altTextSource = source;
      }
    }
  }
  if (patch.collectionId !== undefined) {
    if (patch.collectionId === null) {
      delete next.collectionId;
    } else {
      const c = await getCollection(tenantId, orgId, patch.collectionId);
      if (!c) throw new OpenwopError('not_found', 'Collection not found in this org.', 404, { collectionId: patch.collectionId });
      next.collectionId = c.collectionId;
    }
  }
  await assets.put(next);
  return next;
}

/**
 * Delete an asset AND free its bytes (no orphaned storage).
 *
 * MED2-B1 — the byte delete is now CHECKED. It used to be fire-and-forget, so a
 * byte row that was missing or tenant-mismatched produced a 204 while the bytes
 * survived — fetchable through a ~100-year capability token on a globally
 * auth-exempt route — and the metadata row, the app's ONLY handle to them, was
 * destroyed in the same breath. Failing here and LEAVING THE ROW is strictly
 * better: the asset stays listed, stays deletable, and the user is told the
 * truth instead of watching it disappear from a library that no longer knows it
 * exists.
 */
export async function deleteAsset(tenantId: string, orgId: string, assetId: string): Promise<boolean> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) return false;
  // MED2-R3 — refuse ONLY when the bytes are someone else's and therefore stay
  // reachable. `absent` means there is nothing left to leak, so the row must
  // stay deletable: treating it as a failure (the first cut did) left an asset
  // whose bytes had already gone permanently stuck in the library, with every
  // retry throwing and no other path to remove it.
  const removal = await mediaStorage.remove(tenantId, a.storageRef);
  if (removal === 'forbidden') {
    throw new OpenwopError(
      'internal_error',
      'The stored file could not be removed, so the asset was kept — deleting its record would leave the file reachable with nothing able to delete it. Contact an operator.',
      500,
      { assetId, reason: 'bytes_not_removed' },
    );
  }
  await assets.delete(assetId);
  // MEDIA-CODE-1 / CS-DATA-3 — the asset's usage rows die with it (no orphaned
  // "used by" edges pointing at a deleted asset).
  await sweepUsageRefsForAsset(tenantId, orgId, assetId);
  // DATB-1 — foreign soft refs (rows media cannot know about) prune through
  // the keyed lifecycle seam, fired AFTER everything owned is gone.
  await fireMediaAssetDeleted({ tenantId, orgId, assetId });
  return true;
}

/** Usage tracking (Phase 2): a consumer marks an asset used. */
export async function markUsed(tenantId: string, orgId: string, assetId: string): Promise<MediaAsset | null> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) return null;
  const next: MediaAsset = { ...a, usageCount: a.usageCount + 1, lastUsedAt: nowIso() };
  await assets.put(next);
  return next;
}

// ── Usage references (ADR 0206 / gap-analysis B4) ────────────────────────────
// A real "used by" graph superseding the bare `usageCount` counter as the
// source of truth for asset-detail usage. MEDIA owns the rows + token→asset
// resolution (consumers keep treating serve tokens as opaque — the ADR 0007
// boundary); consumers (the CMS page save/delete path) call `syncUsageRefs`
// with the tokens their document now references. Deterministic row keys make
// the reconcile idempotent: repeated saves neither duplicate nor double-count.

/** ADR 0352 P6 — the "used in N campaigns" graph kinds.
 *  NOTE (CS-DATA-5): `'campaign'` is now LIVE. The durable campaign→asset edge
 *  is `campaign.assetIds` (campaign-orchestration/types.ts): `attachCampaignAssets`
 *  stamps these rows via `syncUsageRefs({ kind: 'campaign', … })` whenever a
 *  campaign renders or attaches assets (the `renderConcepts` node feeds it the
 *  generated concepts through the surface `attachAssets` op), and `deleteCampaign`
 *  cascades them via `clearUsageForRef('campaign', …)`. */
export type MediaUsageRefKind = 'cms-page' | 'campaign' | 'creative-brief' | 'creative-render';

export interface MediaUsageRef {
  /** Deterministic: `musage:${assetId}:${refKind}:${refId}`. */
  usageId: string;
  tenantId: string;
  orgId: string;
  assetId: string;
  /** The referencing document kind (ADR 0352 P6 added campaign + creative-brief). */
  refKind: MediaUsageRefKind;
  refId: string;
  refLabel: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

// DEBT-2 — tenant-indexed like `assets` (see the note there): reads are bounded
// per-tenant marker scans; pre-index deployed rows heal via the one-time backfill.
const usageRefs = new DurableCollection<MediaUsageRef>('media:usage', (u) => u.usageId, undefined, (u) => u.tenantId);

const usageKey = (assetId: string, refKind: string, refId: string): string => `musage:${assetId}:${refKind}:${refId}`;

/**
 * Reconcile the usage rows for ONE referencing document against the serve
 * tokens it now contains: upsert a row per referenced asset, delete rows for
 * assets no longer referenced. Unknown/foreign tokens are ignored (an asset
 * deleted or cross-org token resolves to nothing — fail-quiet by design; the
 * editor already preserves unknown tokens verbatim). Best-effort: callers
 * treat failures as non-fatal (a save must not fail because usage bookkeeping
 * did).
 */
export async function syncUsageRefs(
  tenantId: string,
  orgId: string,
  ref: { kind: MediaUsageRefKind; id: string; label: string },
  serveTokens: readonly string[],
): Promise<void> {
  const tokenSet = new Set(serveTokens.filter((t) => t.length > 0));
  // DEBT-2 — both scans ride the tenant index (this runs on every CMS page
  // save). Safe for the delete side too: usage keys are DETERMINISTIC
  // (`musage:${assetId}:${refKind}:${refId}`), so a still-referenced row whose
  // marker went missing is simply re-put below — the put rewrites row AND
  // marker (self-heal); a de-referenced one becomes an inert orphan invisible
  // to the (also indexed) reads until tenant teardown's authoritative sweep.
  const orgAssets = await assetsForOrg(tenantId, orgId);
  const referencedAssetIds = new Set(orgAssets.filter((a) => tokenSet.has(a.serveToken)).map((a) => a.assetId));
  const now = nowIso();
  const existing = (await usageRefs.listForTenantIndexed(tenantId)).filter(
    (u) => u.tenantId === tenantId && u.orgId === orgId && u.refKind === ref.kind && u.refId === ref.id,
  );
  for (const row of existing) {
    if (referencedAssetIds.has(row.assetId)) {
      referencedAssetIds.delete(row.assetId); // already tracked — refresh lastSeen + label
      await usageRefs.put({ ...row, refLabel: ref.label, lastSeenAt: now });
    } else {
      // FU-DATA-3 — the INDEXED asset read above can MISS an asset whose tenant
      // marker is lost ("delayed, not lost"), which would read here as
      // "de-referenced" and empty a valid "where used" edge. Confirm via the
      // authoritative point `get` before deleting: a live asset whose token is
      // still referenced is refreshed instead.
      const live = await getAsset(tenantId, orgId, row.assetId);
      if (live && tokenSet.has(live.serveToken)) {
        await usageRefs.put({ ...row, refLabel: ref.label, lastSeenAt: now });
      } else {
        await usageRefs.delete(row.usageId); // de-referenced (or the asset is truly gone)
      }
    }
  }
  for (const assetId of referencedAssetIds) {
    await usageRefs.put({
      usageId: usageKey(assetId, ref.kind, ref.id),
      tenantId,
      orgId,
      assetId,
      refKind: ref.kind,
      refId: ref.id,
      refLabel: ref.label,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
}

/** Drop every usage row for a deleted referencing document.
 *  DELIBERATELY the authoritative full scan, not the tenant index (DEBT-2):
 *  this sweep DELETES rows, and an index miss would leave a permanent orphan
 *  pointing at a deleted document. Deletes are rare; completeness wins. */
export async function clearUsageForRef(tenantId: string, orgId: string, refKind: MediaUsageRefKind, refId: string): Promise<void> {
  const mine = (await usageRefs.list()).filter(
    (u) => u.tenantId === tenantId && u.orgId === orgId && u.refKind === refKind && u.refId === refId,
  );
  for (const row of mine) await usageRefs.delete(row.usageId);
}

/** MEDIA-CODE-1 — drop every usage row for a DELETED asset (the other side of
 *  the graph: `clearUsageForRef` cascades from the referencing document,
 *  this cascades from the asset). Hoisted declaration so `deleteAsset` (defined
 *  above the usage section) can call it. Stays on the authoritative full scan
 *  (DEBT-2): a delete-driving sweep must not miss on a lost index marker. */
async function sweepUsageRefsForAsset(tenantId: string, orgId: string, assetId: string): Promise<void> {
  const mine = (await usageRefs.list()).filter(
    (u) => u.tenantId === tenantId && u.orgId === orgId && u.assetId === assetId,
  );
  for (const row of mine) await usageRefs.delete(row.usageId);
}

/** The documents referencing an asset (asset-detail "used by"). IDOR-guarded:
 *  returns null when the asset isn't visible to this tenant/org. */
export async function listUsageForAsset(tenantId: string, orgId: string, assetId: string): Promise<MediaUsageRef[] | null> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) return null;
  return (await usageRefs.listForTenantIndexed(tenantId)) // DEBT-2 — bounded tenant read
    .filter((u) => u.tenantId === tenantId && u.orgId === orgId && u.assetId === assetId)
    .sort((x, y) => (x.lastSeenAt < y.lastSeenAt ? 1 : -1));
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetMedia(): Promise<void> {
  await collections.__clear();
  await assets.__clear();
  await usageRefs.__clear();
}

/** Test-only: the raw usage rows (so a cascade test can assert rows are GONE —
 *  `listUsageForAsset` IDOR-guards on the asset, which a delete test just removed). */
export async function __listUsageRefs(): Promise<MediaUsageRef[]> {
  return usageRefs.list();
}

// ── ADR 0352 Phase 4 — deterministic weighted selection ─────────────────────
// The CS-002 auto-selection: score an org's image assets against campaign
// criteria with NAMED weights, walk a 5-level fallback chain, and when nothing
// matches return a `needsAsset` signal (the creative-briefs "go shoot this"
// hook, ADR 0353). PURE ranking over the rows — no clock, no randomness —
// so a workflow node calling it is replay-safe.

export const SELECT_WEIGHTS = { product: 40, industry: 25, useCase: 20, persona: 10, recency: 5 } as const;

export interface SelectCriteria {
  product?: string;
  industry?: string;
  useCase?: string;
  personaIds?: string[];
  collectionId?: string;
  limit?: number;
}

export interface SelectedAsset { asset: MediaAssetView; score: number; matched: string[] }
export interface SelectResult {
  assets: SelectedAsset[];
  /** Which fallback level produced the result (0 = full criteria). */
  fallbackLevel: number;
  /** Set when NOTHING matched at any level — the "go shoot this" signal. */
  needsAsset?: { criteria: SelectCriteria };
}

const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase();

/** Facet match = full weight; tag match = half weight (facet-untagged libraries
 *  still rank, but curated metadata wins). */
function fieldScore(weight: number, want: string | undefined, facet: string | undefined, tags: string[]): { score: number; hit: boolean } {
  const w = norm(want);
  if (!w) return { score: 0, hit: false };
  if (norm(facet) === w) return { score: weight, hit: true };
  if (tags.some((t) => norm(t) === w)) return { score: weight / 2, hit: true };
  return { score: 0, hit: false };
}

function scoreAsset(a: MediaAsset, c: SelectCriteria, newestAt: string, oldestAt: string): { score: number; matched: string[] } {
  const tags = a.tags ?? [];
  const m = a.marketing ?? {};
  const matched: string[] = [];
  let score = 0;
  const prod = fieldScore(SELECT_WEIGHTS.product, c.product, m.product, tags);
  if (prod.hit) { score += prod.score; matched.push('product'); }
  const ind = fieldScore(SELECT_WEIGHTS.industry, c.industry, m.industry, tags);
  if (ind.hit) { score += ind.score; matched.push('industry'); }
  const use = fieldScore(SELECT_WEIGHTS.useCase, c.useCase, m.useCase, tags);
  if (use.hit) { score += use.score; matched.push('useCase'); }
  if (c.personaIds && c.personaIds.length > 0 && m.personaIds?.some((id) => c.personaIds!.includes(id))) {
    score += SELECT_WEIGHTS.persona; matched.push('persona');
  }
  // Recency: relative position between the pool's oldest and newest updatedAt —
  // deterministic from the rows (no wall clock ⇒ replay-safe).
  if (newestAt !== oldestAt) {
    const span = Date.parse(newestAt) - Date.parse(oldestAt);
    const rel = span > 0 ? (Date.parse(a.updatedAt) - Date.parse(oldestAt)) / span : 0;
    score += SELECT_WEIGHTS.recency * Math.max(0, Math.min(1, rel));
  }
  return { score, matched };
}

/** The 5-level fallback chain: full → drop persona → drop useCase → drop
 *  industry (product-only) → ANY org image (criteria-free, recency-ranked).
 *  Levels 0–3 "produce" when ≥1 asset scores on a non-recency dimension; the
 *  TERMINAL level is criteria-free (MEDIA-CODE-6 review: levels 3 and 4 were
 *  identical), so `needsAsset` now means "the library has no images at all",
 *  not "nothing matched" — there is always something to start from. */
export async function selectAssets(tenantId: string, orgId: string, criteria: SelectCriteria): Promise<SelectResult> {
  const limit = Math.max(1, Math.min(criteria.limit ?? 5, 20));
  // DEBT-2 — bounded (tenant, org) pool. Determinism is unaffected by marker
  // enumeration order: every ranking below sorts with full tiebreakers
  // (score → updatedAt → assetId), and the recency normalization depends only
  // on the pool's CONTENTS, which are identical.
  const all = (await assetsForOrg(tenantId, orgId)).filter((a) =>
    a.contentType.startsWith('image/')
    && (!criteria.collectionId || a.collectionId === criteria.collectionId));
  if (all.length === 0) return { assets: [], fallbackLevel: 4, needsAsset: { criteria } };

  const times = all.map((a) => a.updatedAt).sort();
  const oldestAt = times[0]!;
  const newestAt = times[times.length - 1]!;

  const levels: SelectCriteria[] = [
    criteria,
    { ...criteria, personaIds: undefined },
    { ...criteria, personaIds: undefined, useCase: undefined },
    { ...criteria, personaIds: undefined, useCase: undefined, industry: undefined },
  ];
  for (let level = 0; level < levels.length; level++) {
    const c = levels[level]!;
    const scored = all
      .map((a) => ({ a, ...scoreAsset(a, c, newestAt, oldestAt) }))
      .filter((x) => x.matched.length > 0)
      .sort((x, y) => y.score - x.score || y.a.updatedAt.localeCompare(x.a.updatedAt) || x.a.assetId.localeCompare(y.a.assetId));
    if (scored.length > 0) {
      return { assets: scored.slice(0, limit).map((x) => ({ asset: viewAsset(x.a), score: Math.round(x.score * 100) / 100, matched: x.matched })), fallbackLevel: level };
    }
  }
  // Terminal level (4): any org image — deterministic recency ranking (the
  // scoreAsset recency component; no wall clock), `matched` honestly empty.
  const terminal = all
    .map((a) => ({ a, ...scoreAsset(a, {}, newestAt, oldestAt) }))
    .sort((x, y) => y.score - x.score || y.a.updatedAt.localeCompare(x.a.updatedAt) || x.a.assetId.localeCompare(y.a.assetId));
  return {
    assets: terminal.slice(0, limit).map((x) => ({ asset: viewAsset(x.a), score: Math.round(x.score * 100) / 100, matched: x.matched })),
    fallbackLevel: levels.length,
  };
}

// ── ADR 0352 Phase 3 — AI auto-tagging (suggest-confirm, honest-off) ─────────
// One vision pass proposes tags + the marketing facet + a dominant palette + a
// subject box; the subject box derives the P5 crop geometries. PROPOSALS only —
// the caller applies them via the existing PATCH (user-confirmed), so the
// library never silently self-mutates. No vision-capable provider ⇒ 422.

export interface AutotagProposal {
  tags: string[];
  marketing: MediaMarketing;
  renditions: NonNullable<MediaAsset['renditions']>;
}

export async function autotagAsset(tenantId: string, orgId: string, assetId: string): Promise<AutotagProposal> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId });
  if (!a.contentType.startsWith('image/')) {
    throw new OpenwopError('validation_error', 'Only image assets can be auto-tagged.', 422, { contentType: a.contentType });
  }
  const entry = await resolveMediaAsset(a.serveToken);
  if (!entry) throw new OpenwopError('not_found', 'Asset bytes not found.', 404, { assetId });
  const dispatch = await resolveHeadlessAi(tenantId, 'image');
  if (!dispatch) {
    throw new OpenwopError('validation_error', 'No vision-capable AI provider is available. Configure a default AI provider (with a vision-capable model) in BYOK settings.', 422, {});
  }
  const system = 'You are a marketing media librarian. Analyze the image and reply with STRICT JSON only: {"tags": string[] (max 6, lowercase), "marketing": {"product"?: string, "angle"?: string, "background"?: string, "industry"?: string, "useCase"?: string}, "palette": string[] (max 5 hex colors), "subjectBox": {"x": number, "y": number, "w": number, "h": number} (the main subject, normalized 0-1)}. No commentary.';
  const raw = await dispatch([
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: 'Tag this marketing image.' }, { type: 'image', mimeType: entry.contentType, dataBase64: entry.contentBase64 }] },
  ], { maxTokens: 1024 });
  // MEDIA-CODE-4 — an unparseable/contentless model payload is an UPSTREAM
  // failure (502), never a fabricated empty "success" proposal.
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
  } catch {
    throw new OpenwopError('internal_error', 'The vision model returned an unparseable autotag payload.', 502, { assetId });
  }
  if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
    throw new OpenwopError('internal_error', 'The vision model returned a non-object autotag payload.', 502, { assetId });
  }
  const parsed = parsedRaw as Record<string, unknown>;
  const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string').slice(0, 6) : [];
  const marketing = cleanMarketing({ ...(typeof parsed.marketing === 'object' && parsed.marketing ? parsed.marketing : {}), ...(Array.isArray(parsed.palette) ? { palette: parsed.palette } : {}) }) ?? {};
  const boxRaw = parsed.subjectBox as Record<string, unknown> | undefined;
  const hasBox = Boolean(boxRaw && typeof boxRaw === 'object' && !Array.isArray(boxRaw));
  if (tags.length === 0 && Object.keys(marketing).length === 0 && !hasBox) {
    throw new OpenwopError('internal_error', 'The vision model returned no usable tags/marketing/subject-box signal.', 502, { assetId });
  }
  const nn = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
  const subject: MediaCropBox = hasBox
    ? { x: nn(boxRaw!.x), y: nn(boxRaw!.y), w: nn(boxRaw!.w) || 1, h: nn(boxRaw!.h) || 1 }
    : { x: 0, y: 0, w: 1, h: 1 };
  return { tags, marketing, renditions: deriveRenditions(subject) };
}

// ── ADR 0363 Phase 1 — AI alt-text (suggest-confirm; apply via PATCH) ─────────
// A vision pass proposes a concise screen-reader description for an image asset.
// PROPOSAL only — the caller applies it via the existing PATCH (user-confirmed),
// so the library never self-mutates. Mirrors `autotagAsset` exactly: same byte
// seam (`resolveMediaAsset`), same vision seam (`resolveHeadlessAi(_, 'image')`),
// same honest failure modes (no vision provider ⇒ 422; empty payload ⇒ 502).
// `model`/`confidence` are deliberately absent — the headless dispatch closure
// returns only text, so a synthetic confidence would be dishonest. Governance is
// autotag-parity (provider-absence 422 + workspace:write + tenant/org IDOR +
// per-org asset caps); vision has no ADR 0106 media-budget kind (neither does
// autotag), so none is claimed.

export interface AltTextProposal {
  assetId: string;
  altText: string;
}

export async function generateAltText(tenantId: string, orgId: string, assetId: string): Promise<AltTextProposal> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId });
  if (!a.contentType.startsWith('image/')) {
    throw new OpenwopError('validation_error', 'Only image assets can have alt text generated.', 422, { contentType: a.contentType });
  }
  const entry = await resolveMediaAsset(a.serveToken);
  if (!entry) throw new OpenwopError('not_found', 'Asset bytes not found.', 404, { assetId });
  const dispatch = await resolveHeadlessAi(tenantId, 'image');
  if (!dispatch) {
    throw new OpenwopError('validation_error', 'No vision-capable AI provider is available. Configure a default AI provider (with a vision-capable model) in BYOK settings.', 422, {});
  }
  const system =
    'You write alt text for images so screen-reader users understand them. Reply with a SINGLE concise sentence (max 250 characters) describing the image\'s content and purpose. Do NOT begin with "image of"/"picture of". Do NOT add commentary, quotes, or markdown — output the description text only. If the image is purely decorative, reply with the exact token DECORATIVE.';
  const raw = await dispatch([
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: 'Write alt text for this image.' }, { type: 'image', mimeType: entry.contentType, dataBase64: entry.contentBase64 }] },
  ], { maxTokens: 256 });
  const text = cleanAltText(raw.replace(/^["'`\s]+|["'`\s]+$/g, ''));
  // MEDIA-CODE-4 parity — a contentless model payload is an UPSTREAM failure
  // (502), never a fabricated empty "success" proposal. A DECORATIVE verdict is
  // returned as an empty description (the client applies `altTextSource:'decorative'`).
  // Tolerate trailing punctuation ("DECORATIVE.", "Decorative!").
  if (/^decorative[.!\s]*$/i.test(text)) return { assetId, altText: '' };
  if (!text) throw new OpenwopError('internal_error', 'The vision model returned no usable alt-text.', 502, { assetId });
  return { assetId, altText: text };
}
