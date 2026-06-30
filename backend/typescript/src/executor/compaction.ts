/**
 * ADR 0099 — the core contract for the per-run compaction decision frozen in
 * `run.metadata.compaction`. Lives at the executor level (below `host/`) so both
 * the executor (reads it into `NodeContext.compaction`) and the
 * tool-output-compaction feature (writes it via the run-start contributor) share
 * ONE key + reader without a host→executor→host cycle and without core importing
 * the feature.
 */

import type { CompactionDecision } from './types.js';

/** The `run.metadata` key the decision is frozen under (sibling of `trustBoundary`). */
export const COMPACTION_METADATA_KEY = 'compaction';

/**
 * Read a frozen decision out of `run.metadata`. Total — returns `undefined`
 * (⇒ identity) for absent or malformed values. Never throws.
 */
export function readCompactionDecision(metadata: unknown): CompactionDecision | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as Record<string, unknown>)[COMPACTION_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const mode = (raw as { mode?: unknown }).mode;
  if (mode !== 'lossless' && mode !== 'lossy' && mode !== 'off') return undefined;
  const out: CompactionDecision = { mode };
  const head = (raw as { head?: unknown }).head;
  const tail = (raw as { tail?: unknown }).tail;
  const minChars = (raw as { minChars?: unknown }).minChars;
  if (typeof head === 'number') out.head = head;
  if (typeof tail === 'number') out.tail = tail;
  if (typeof minChars === 'number') out.minChars = minChars;
  const exemptTools = (raw as { exemptTools?: unknown }).exemptTools;
  if (Array.isArray(exemptTools)) {
    const tools = exemptTools.filter((t): t is string => typeof t === 'string');
    if (tools.length) out.exemptTools = tools;
  }
  return out;
}
