/**
 * Host brand-asset publication (ADR 0511) — copy-on-select into the reserved
 * `host:brand` media scope.
 *
 * The app brand is HOST-GLOBAL (one reserved record served to anonymous
 * visitors) while Media is tenant/org-scoped, so a published asset must not
 * reference tenant-owned bytes: a tenant deletion, retention purge, or org
 * teardown could dangle the public logo, and the public response must never
 * be coupled to a tenant's lifecycle. Publication therefore COPIES the bytes
 * into `host:brand` (a scope no real tenant can own — real ids are
 * `user:*`/`org:*`/`anon:*`) via the host storage seam, and the brand record
 * stores the copy's own capability serve URL.
 *
 * Validation is fail-closed at the boundary:
 *   - magic-byte sniffing must MATCH the declared content type (raster
 *     allowlist: PNG, JPEG, WebP, GIF, ICO);
 *   - SVG is REJECTED on this path (no sanitizer dependency exists; an
 *     accepted SVG would be a stored-XSS vector on an anonymous endpoint —
 *     ADR 0511 §2; the ≤8KB `safeBrandAsset` data-URI lane is unchanged);
 *   - 512 KB byte cap — brand chrome, not a gallery.
 *
 * Growth is bounded: one live copy per slot; replacing a slot frees the
 * previous copy AFTER the new one is stored (fail-open on the delete — a
 * leaked orphan is recoverable, a dangling public logo is not).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { storeMediaAsset, deleteMediaAsset } from './inMemorySurfaces.js';

export const HOST_BRAND_TENANT = 'host:brand';

export const BRAND_ASSET_SLOTS = ['mark', 'markDark', 'lockup', 'lockupDark', 'favicon'] as const;
export type BrandAssetSlot = (typeof BRAND_ASSET_SLOTS)[number];

const MAX_ASSET_BYTES = 512 * 1024;
/** Media's durable class (mediaStorage.ts uses the same figure). */
const DURABLE_TTL_SECONDS = 100 * 365 * 24 * 60 * 60;

/** slot → the live copy's storage token, so replacement can free the old copy. */
interface BrandAssetSlotRow { slot: BrandAssetSlot; token: string }
const slots = new DurableCollection<BrandAssetSlotRow>('brand:asset-slot', (r) => r.slot);

/** Declared type → its magic-byte signature check. SVG is deliberately absent. */
const SNIFFERS: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/x-icon': (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00,
  'image/vnd.microsoft.icon': (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00,
};

export type PublishFailure =
  | { kind: 'unsupported_type'; message: string }
  | { kind: 'type_mismatch'; message: string }
  | { kind: 'too_large'; message: string }
  | { kind: 'invalid_slot'; message: string };

export type PublishResult =
  | { ok: true; url: string }
  | { ok: false; failure: PublishFailure };

/** Validate + copy the bytes into the host scope; returns the copy's serve URL. */
export async function publishBrandAsset(
  slot: string,
  contentBase64: string,
  contentType: string,
): Promise<PublishResult> {
  if (!(BRAND_ASSET_SLOTS as readonly string[]).includes(slot)) {
    return { ok: false, failure: { kind: 'invalid_slot', message: `slot must be one of: ${BRAND_ASSET_SLOTS.join(', ')}` } };
  }
  const sniff = SNIFFERS[contentType];
  if (!sniff) {
    return {
      ok: false,
      failure: {
        kind: 'unsupported_type',
        message: `contentType must be one of: ${Object.keys(SNIFFERS).join(', ')} (SVG is not accepted on this path — ADR 0511 §2)`,
      },
    };
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0 || !sniff(bytes)) {
    return { ok: false, failure: { kind: 'type_mismatch', message: `bytes do not match the declared ${contentType} signature` } };
  }
  if (bytes.length > MAX_ASSET_BYTES) {
    return { ok: false, failure: { kind: 'too_large', message: `asset exceeds ${Math.floor(MAX_ASSET_BYTES / 1024)} KB` } };
  }

  const stored = await storeMediaAsset(HOST_BRAND_TENANT, {
    contentBase64: bytes.toString('base64'), // re-encoded: normalized, whitespace-free
    contentType,
    ttlSeconds: DURABLE_TTL_SECONDS,
  });

  // Replacement frees the PREVIOUS copy only after the new one is durably
  // stored; a failed delete leaks one recoverable orphan, never a dangling URL.
  const prev = await slots.get(slot);
  await slots.put({ slot: slot as BrandAssetSlot, token: stored.token });
  if (prev && prev.token !== stored.token) {
    await deleteMediaAsset(HOST_BRAND_TENANT, prev.token).catch(() => undefined);
  }
  return { ok: true, url: stored.url };
}
