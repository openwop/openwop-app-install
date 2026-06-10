/**
 * In-process registry of feature-toggle DEFAULTS (ADR §3.1).
 *
 * A feature package declares its toggle's default config once at boot
 * (`registerToggleDefault`), mirroring myndhyve's FEATURE_REGISTRY. The durable
 * store (service.ts) holds admin OVERRIDES layered over these defaults — so a
 * fresh deploy has every feature at its declared default with no DB rows, and
 * the admin screen lists defaults even before anyone has touched them.
 */

import { createLogger } from '../../observability/logger.js';
import type { ToggleConfig } from './types.js';

const log = createLogger('featureToggles.registry');

const defaults = new Map<string, ToggleConfig>();

/**
 * Declare (or replace) a feature's default toggle config. Idempotent — calling
 * twice with the same id replaces the default (last declaration wins), which is
 * what we want when a feature manifest re-registers on hot-reload.
 */
export function registerToggleDefault(config: ToggleConfig): void {
  if (defaults.has(config.id)) {
    log.debug('toggle_default_replaced', { id: config.id });
  }
  defaults.set(config.id, config);
}

/** The default config for one toggle, or null if no feature declared it. */
export function getToggleDefault(id: string): ToggleConfig | null {
  return defaults.get(id) ?? null;
}

/** Every declared default, in declaration order. */
export function listToggleDefaults(): ToggleConfig[] {
  return [...defaults.values()];
}

/** Test-only: drop all declared defaults. */
export function __resetToggleDefaults(): void {
  defaults.clear();
}
