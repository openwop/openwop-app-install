/**
 * ADR 0473 — the pinned, verifiable form of a workflow definition: SHA-256 over
 * canonical (recursively key-sorted) JSON — the same canonicalization the audit
 * chain hashes with, so "the definition the reviewer saw" is deterministic.
 *
 * Lives in its own module because BOTH the composition lanes
 * (`host/workflowComposeTool.ts`) and the shared run starter
 * (`host/runStarter.ts` — the dispatch-time re-verify) need it without an
 * import cycle.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from './auditChainService.js';
import type { WorkflowDefinition } from '../executor/types.js';

export function definitionHashOf(def: WorkflowDefinition): string {
  return createHash('sha256').update(canonicalize(def), 'utf8').digest('hex');
}

/**
 * ADR 0474 — the REVISION hash: the content hash with `metadata.lifecycle`
 * stripped. The lifecycle verbs (archive/unarchive/promote — ADR 0369) patch
 * only that facet and re-register, so a full-content hash would mint a phantom
 * revision on every lifecycle change (the ADR 0473 false-edited-chip class,
 * made structural here). Contrast `definitionHashOf` (full): that remains the
 * ADR 0473 approve-what-you-see pin, where lifecycle IS part of what the
 * reviewer saw. Two hashes, two questions — keep both.
 */
export function revisionHashOf(def: WorkflowDefinition): string {
  if (def.metadata && 'lifecycle' in def.metadata) {
    const { lifecycle: _lifecycle, ...metadata } = def.metadata as Record<string, unknown>;
    return definitionHashOf({ ...def, metadata } as WorkflowDefinition);
  }
  return definitionHashOf(def);
}
