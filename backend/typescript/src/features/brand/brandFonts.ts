/**
 * Brand custom fonts (ADR 0399 OQ-1) — a brand-owned store of operator-uploaded
 * TTF/OTF faces the ad-layout renderer embeds into exported creatives, gated on
 * a license attestation (embedding a licensed font into a redistributed raster
 * needs redistribution rights — the operator attests they hold them).
 *
 * Brand owns this (sibling of `brand:audit`), NOT the media library — fonts are
 * not servable media assets and the attestation gate is brand-governance, not
 * media capacity. Rows carry `tenantId` in content so tenant teardown reaps
 * them; `deleteBrand` prefix-purges them (see brandService, C1).
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';

export type BrandFontRole = 'sans' | 'serif';
export const BRAND_FONT_ROLES: readonly BrandFontRole[] = ['sans', 'serif'];

/** ~2 MiB raw font cap (a TTF/OTF text face is well under this). */
const MAX_FONT_BYTES = 2 * 1024 * 1024;

export interface BrandFont {
  tenantId: string;
  brandId: string;
  role: BrandFontRole;
  /** The font's REAL internal family name (name-table ID 1) — what the SVG's
   *  font-family must equal for resvg to match the embedded buffer. NEVER the
   *  operator-typed string (a typo would silently fall back to a bundled font). */
  family: string;
  contentBase64: string;
  sha256: string;
  sizeBytes: number;
  /** The operator's redistribution-rights attestation — a hard precondition. */
  licenseAttested: true;
  attestedBy: string;
  createdAt: string;
}

const fonts = new DurableCollection<BrandFont>('brand:font', (f) => `${f.tenantId}:${f.brandId}:${f.role}`);

const key = (tenantId: string, brandId: string, role: BrandFontRole): string => `${tenantId}:${brandId}:${role}`;

/** TTF/OTF sniff (C3) — TrueType (`0x00010000` / `'true'`) or OpenType-CFF
 *  (`'OTTO'`) only. WOFF/WOFF2 (resvg-js 2.6.2 can't decode) and font
 *  collections (`'ttcf'`) are rejected. */
function isSupportedFont(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const tag = buf.subarray(0, 4);
  return tag.readUInt32BE(0) === 0x00010000 || tag.toString('latin1') === 'OTTO' || tag.toString('latin1') === 'true';
}

/** Parse the font's `name` table and return family name ID 1 (C2). Prefers the
 *  Windows-Unicode English record; falls back to any family record. Returns
 *  null when the table is missing/unparseable. Bounded, pure. */
export function extractFontFamily(buf: Buffer): string | null {
  try {
    const numTables = buf.readUInt16BE(4);
    let nameOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (buf.toString('latin1', rec, rec + 4) === 'name') { nameOffset = buf.readUInt32BE(rec + 8); break; }
    }
    if (nameOffset < 0) return null;
    const count = buf.readUInt16BE(nameOffset + 2);
    const storage = nameOffset + buf.readUInt16BE(nameOffset + 4);
    let best: string | null = null;
    let bestScore = -1;
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12;
      const platformId = buf.readUInt16BE(rec);
      const languageId = buf.readUInt16BE(rec + 4);
      const nameId = buf.readUInt16BE(rec + 6);
      if (nameId !== 1) continue; // 1 = font family
      const len = buf.readUInt16BE(rec + 8);
      const off = storage + buf.readUInt16BE(rec + 10);
      if (off + len > buf.length) continue;
      const raw = buf.subarray(off, off + len);
      // Platform 3 (Windows) / 0 (Unicode) store UTF-16BE; platform 1 (Mac) is
      // MacRoman (latin1 covers ASCII family names).
      const value = platformId === 3 || platformId === 0 ? utf16beToString(raw) : raw.toString('latin1');
      const score = platformId === 3 ? (languageId === 0x409 ? 3 : 2) : platformId === 1 ? 1 : 0;
      if (value && score > bestScore) { best = value; bestScore = score; }
    }
    return best && best.trim() ? best.trim() : null;
  } catch {
    return null;
  }
}

/** UTF-16BE → string (font `name` strings on platform 3/0 are big-endian). */
function utf16beToString(raw: Buffer): string {
  let s = '';
  for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode(raw.readUInt16BE(i));
  return s;
}

/** Validate + store an attested brand font. Returns the stored metadata (no
 *  bytes). Throws typed 400s on attestation/type/size/parse failure. */
export async function putBrandFont(input: {
  tenantId: string; brandId: string; role: BrandFontRole;
  contentBase64: unknown; licenseAttested: unknown; attestedBy: string;
}): Promise<Omit<BrandFont, 'contentBase64'>> {
  if (input.licenseAttested !== true) {
    throw new OpenwopError('validation_error', 'A license attestation (`licenseAttested: true`) is required to embed a font into exported creatives.', 400, { field: 'licenseAttested' });
  }
  if (typeof input.contentBase64 !== 'string' || input.contentBase64.length === 0) {
    throw new OpenwopError('validation_error', 'Field `contentBase64` is required.', 400, { field: 'contentBase64' });
  }
  let buf: Buffer;
  try { buf = Buffer.from(input.contentBase64, 'base64'); } catch { throw new OpenwopError('validation_error', '`contentBase64` is not valid base64.', 400, { field: 'contentBase64' }); }
  if (buf.length === 0 || buf.length > MAX_FONT_BYTES) {
    throw new OpenwopError('validation_error', `Font must be 1 B–${Math.floor(MAX_FONT_BYTES / (1024 * 1024))} MiB.`, 400, { field: 'contentBase64' });
  }
  if (!isSupportedFont(buf)) {
    throw new OpenwopError('validation_error', 'Font must be a raw TTF or OTF file (WOFF/WOFF2 and font collections are not supported).', 400, { field: 'contentBase64' });
  }
  const family = extractFontFamily(buf);
  if (!family) {
    throw new OpenwopError('validation_error', 'Could not read the font family name from the file — is it a valid TTF/OTF?', 400, { field: 'contentBase64' });
  }
  const row: BrandFont = {
    tenantId: input.tenantId,
    brandId: input.brandId,
    role: input.role,
    family: cleanString(family, 120),
    contentBase64: input.contentBase64,
    sha256: createHash('sha256').update(buf).digest('hex'),
    sizeBytes: buf.length,
    licenseAttested: true,
    attestedBy: input.attestedBy,
    createdAt: new Date().toISOString(),
  };
  await fonts.put(row);
  const { contentBase64: _bytes, ...meta } = row;
  return meta;
}

/** The attested font for a (brand, role), or null. Bounded point read. */
export async function getBrandFont(tenantId: string, brandId: string, role: BrandFontRole): Promise<BrandFont | null> {
  const row = await fonts.get(key(tenantId, brandId, role));
  return row && row.tenantId === tenantId && row.licenseAttested === true ? row : null;
}

/** Metadata for every attested font on a brand (no bytes) — for the settings UI. */
export async function listBrandFonts(tenantId: string, brandId: string): Promise<Array<Omit<BrandFont, 'contentBase64'>>> {
  const rows = await fonts.listByPrefix(`${tenantId}:${brandId}:`);
  return rows.filter((r) => r.tenantId === tenantId).map(({ contentBase64: _b, ...meta }) => meta);
}

export async function deleteBrandFont(tenantId: string, brandId: string, role: BrandFontRole): Promise<boolean> {
  const row = await fonts.get(key(tenantId, brandId, role));
  if (!row || row.tenantId !== tenantId) return false;
  await fonts.delete(key(tenantId, brandId, role));
  return true;
}

/** C1 — the brand-delete cascade (called from `deleteBrand`). Prefix-purge so
 *  a deleted brand never orphans font rows. */
export async function purgeBrandFonts(tenantId: string, brandId: string): Promise<void> {
  for (const row of await fonts.listByPrefix(`${tenantId}:${brandId}:`)) {
    if (row.tenantId === tenantId) await fonts.delete(key(tenantId, brandId, row.role));
  }
}

