/**
 * Media asset-lifecycle seam (DATB-1, the ADR 0283/0288 keyed-registry
 * pattern) — the dependency-safe hook by which OTHER features clean up their
 * SOFT references to a media asset when it is deleted, WITHOUT media importing
 * them. Media already sweeps its OWN usage-ref rows on delete
 * (`sweepUsageRefsForAsset`); this seam is for foreign rows media cannot know
 * about (e.g. a creative-briefs render record whose composed PNG was the
 * deleted asset).
 *
 * Contract (identical to the product/CRM/connection/roster/conversation
 * seams): registrations are KEYED so a repeated boot overwrites the same slot
 * (idempotent by construction); handlers MUST be idempotent, MUST bound their
 * work (prefix/point reads — never a cross-tenant scan), and run best-effort —
 * `fireMediaAssetDeleted` swallows a handler's error so one registrant's
 * cleanup can neither block the delete nor another registrant's cleanup.
 * Fired AFTER the owning row + bytes + usage rows are gone, so a mid-way
 * handler failure fails CLOSED (leftover soft refs remain re-prunable
 * orphans, never resurrected assets). Disposition per ADR 0288: PRUNE dead
 * refs / derived rows; TOLERATE ON READ historical provenance. Deletes happen
 * on REST paths outside runs — nothing here touches replay. Default = no
 * handlers ⇒ the media delete path is byte-identical when nothing is wired.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.mediaAssetLifecycle');

export interface MediaAssetDeletedEvent {
  tenantId: string;
  orgId: string;
  assetId: string;
}

type MediaAssetDeletedHandler = (e: MediaAssetDeletedEvent) => Promise<void>;

const handlers = new Map<string, MediaAssetDeletedHandler>();

/** A consumer feature registers (idempotently, keyed) its cleanup at boot. */
export function onMediaAssetDeleted(key: string, fn: MediaAssetDeletedHandler): void {
  handlers.set(key, fn);
}

/** Best-effort fan-out AFTER the asset row/bytes/usage rows are deleted. */
export async function fireMediaAssetDeleted(e: MediaAssetDeletedEvent): Promise<void> {
  for (const [key, fn] of handlers) {
    try {
      await fn(e);
    } catch (err) {
      log.warn('media_asset_deleted_handler_failed', { key, assetId: e.assetId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

