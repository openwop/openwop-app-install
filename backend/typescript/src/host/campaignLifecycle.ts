/**
 * Campaign delete-lifecycle seam — the dependency-safe hook by which sibling
 * campaign-* features (campaign-connectors, campaign-intel) clean up their own
 * per-campaign rows when a campaign is deleted, WITHOUT `campaign-orchestration`
 * importing them (which would be a cross-feature upward dependency). The exact
 * sibling of `crmRecordLifecycle.ts` (ADR 0283) and `commerce/productLifecycleSeam.ts`.
 *
 * Contract (same as those seams): registrations are KEYED so a repeated boot
 * (feature `registerRoutes` runs per test `createApp`) overwrites the same slot
 * instead of stacking duplicates. Handlers MUST be idempotent, bound their work,
 * and run best-effort — `fireCampaignDeleted` swallows a handler's error so one
 * registrant's cleanup can neither block the delete nor another registrant's.
 * Fired AFTER the campaign row is deleted, so a mid-way handler failure fails
 * CLOSED (the parent is already unreachable; leftover per-campaign rows remain
 * re-prunable orphans). Outside runs — nothing here touches `run.metadata`/replay.
 * Default = no handlers ⇒ `deleteCampaign` is byte-identical when nothing is wired.
 */

export interface CampaignDeletedEvent {
  tenantId: string;
  orgId: string;
  campaignId: string;
}

type CampaignDeletedHandler = (e: CampaignDeletedEvent) => Promise<void>;

const handlers = new Map<string, CampaignDeletedHandler>();

/** A consumer feature registers (idempotently, keyed) its per-campaign cleanup at boot. */
export function onCampaignDeleted(key: string, fn: CampaignDeletedHandler): void {
  handlers.set(key, fn);
}

/** Called by the campaign delete path AFTER the row is gone; runs every registrant
 *  best-effort. Never throws. Returns how many handlers ran (observability). */
export async function fireCampaignDeleted(e: CampaignDeletedEvent): Promise<number> {
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a registrant's cleanup failure must not block the delete */ }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetCampaignLifecycleHooks(): void {
  handlers.clear();
}
