/**
 * Event-type vocabulary at the wire seam (ADR 0647 §correction, 2026-09-10).
 *
 * The SPA speaks the v1 event dialect — every `case 'agent.toolCalled'` /
 * `type === 'core.workflowChain.event'` branch in `runs/`, `chat/` and the
 * provenance panels is a v1 spelling, exactly as the backend's own in-process
 * dialect is (`storage/eventEra.ts`: "Contract 1 is the identity case"). But
 * since ADR 0647 the SPA polls and streams under major 2, and a major-2 read
 * carries the v2 spellings from `schemas/v2/event-codemap.json`
 * (`agent.tool-called`, `agent.reasoning-delta`, `workflow-chain.event`, …).
 * The 36 renamed rows therefore arrived in a spelling no consumer matched, and
 * the agent trace, handoff map, provenance panel and chat transport went
 * silently blind to them. `v2Clients.test.ts` never caught it because its
 * poll fixture used `node.completed` — an UNRENAMED type.
 *
 * This module is the ONE place the translation happens, in the same direction
 * and from the same vendored codemap the backend uses, so the rest of the SPA
 * keeps its dialect. The inverse (v1 → v2) is exported for the day the SPA's
 * own dialect moves; it is not used on any path today.
 *
 * The pairs come from `eventCodemap.generated.ts`, produced by
 * `scripts/gen-event-codemap.mjs` from the repo-root vendored codemap (the
 * full 118-row file with notes costs ~3.5 kB gzip in the entry chunk and
 * broke `check-bundle-budget`; the 36 renamed pairs cost ~0.7 kB).
 * `scripts/sync-schemas.sh` regenerates it after every re-vendor, and
 * `eventVocabulary.test.ts` fails when the pairs drift from the file.
 */
import { RENAMED_EVENT_TYPES } from './eventCodemap.generated.js';

/** v2 spelling → v1 spelling, renamed rows only (identity rows need no entry). */
const V2_TO_V1: ReadonlyMap<string, string> = new Map(RENAMED_EVENT_TYPES.map(([v1, v2]) => [v2, v1] as const));
/** v1 spelling → v2 spelling, renamed rows only. */
const V1_TO_V2: ReadonlyMap<string, string> = new Map(RENAMED_EVENT_TYPES.map(([v1, v2]) => [v1, v2] as const));

/** Number of renamed rows the seam translates (non-vacuity witness for tests). */
export const RENAMED_EVENT_TYPE_COUNT = V2_TO_V1.size;

/** A wire (major-2) event type in the SPA's v1 dialect; unknown and identity types pass through. */
export function toClientEventType(type: string): string {
  return V2_TO_V1.get(type) ?? type;
}

/** The SPA's v1 dialect in the major-2 wire spelling; unknown and identity types pass through. */
export function toWireEventType(type: string): string {
  return V1_TO_V2.get(type) ?? type;
}

/**
 * Translate one inbound event's `type`. Only the top-level `type` is a
 * codemap subject: payload contents are opaque to the codemap, and nested
 * `event` bags (webhook bodies) do not reach the SPA.
 */
export function toClientEvent<T extends { type?: unknown }>(ev: T): T {
  if (typeof ev.type !== 'string') return ev;
  const client = toClientEventType(ev.type);
  return client === ev.type ? ev : { ...ev, type: client };
}
