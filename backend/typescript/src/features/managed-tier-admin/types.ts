/**
 * ADR 0990 — the site owner chooses the free tier's provider and model.
 *
 * One superadmin-owned durable row that the core managed-tier resolver reads
 * through the `registerManagedTierConfigProvider` seam (core never imports this
 * feature). With no row, the free tier runs on the env default exactly as before.
 */
import type { ManagedTierProviderOption, ManagedTierSource } from '../../providers/managedProvider.js';

/** The persisted setting (singleton row, id = `default`). */
export interface ManagedTierConfig {
  id: 'default';
  /** One of `MANAGED_UNDERLYING_PROVIDERS`. Kept a string on the row so a value a
   *  later release drops is still READ, and makes the tier unavailable (D4). */
  provider: string;
  model: string;
  /** D5 — per-person daily token allowance while this provider serves; null = env. */
  dailyTokenCap: number | null;
  updatedAt?: string;
  updatedBy?: string;
}

/** GET view: the saved row, what is serving now, and which providers have a key. */
export interface ManagedTierView {
  config: ManagedTierConfig | null;
  effective: {
    provider: string | null;
    model: string | null;
    source: ManagedTierSource | null;
    /** False when the serving provider is unsupported (D4) or has no key. */
    ready: boolean;
  };
  providers: ManagedTierProviderOption[];
  /** Under `OPENWOP_BYOK_EPHEMERAL=true` a host-global vault key never resolves. */
  vaultUsable: boolean;
}
