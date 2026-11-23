/**
 * ADR 0961 D7 — the autopilot preflight. The checks moved to the campaign's
 * owner (ADR 1154 D6); this module re-exports them so the autopilot and its
 * callers keep one definition.
 *
 * @see docs/adr/1154-campaign-studio-guided-flow.md
 */
export { PREFLIGHT_ITEM_IDS, runPreflight } from '../campaign-orchestration/preflight.js';
export type { PreflightItem, PreflightItemId, PreflightResult } from '../campaign-orchestration/preflight.js';
