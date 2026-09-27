/**
 * The ONE composer of a workflow definition's `metadata` for persistence
 * (ADR 0440 P1, extracted in the grade-pass).
 *
 * Every POST to `/host/openwop-app/workflows` replaces the definition
 * wholesale (`registerWorkflow` kv-sets the whole body), so a writer that omits
 * `metadata` ERASES it. P1 fixed the builder's autosave path but left three
 * other writers untouched — the builder's Run button, re-run from the runs
 * index, and running a `@workflow` mention in chat — each POSTing bare
 * `serializeWorkflow` output. Pressing Run therefore destroyed exactly what the
 * autosave had just been taught to preserve.
 *
 * That is not a cosmetic loss. Definition metadata carries live consumers:
 * `walkthrough`/`tour` (gates `isWalkthrough` in the walkthroughs surface),
 * `requiresAgentId` (a handoff gate — erasing it silently stops enforcement),
 * `retention.ttlDays`, `deferredParameterAliases` (RFC 0124), `expandedFrom`
 * (chain re-expansion), `mintedPromptTemplates`, and authoring provenance.
 *
 * Ownership is two-tier and unchanged: `name` and `lifecycle` are BUILDER-owned
 * (the user renames; the builder promotes/archives) and overlay the carried
 * object; every other key is author/server-owned, carried verbatim, never
 * invented and never dropped.
 */

import type { SavedWorkflow } from '../schema/workflow.js';

/** The BUILDER-owned metadata keys — each has its own home on `SavedWorkflow`
 *  and exactly one writer. Stripped from the carried copy at load so the two
 *  never disagree (a stale carried `name` would shadow a rename). */
export const BUILDER_OWNED_METADATA_KEYS = ['name', 'lifecycle'] as const;

export function stripBuilderOwnedKeys(metadata: Record<string, unknown>): Record<string, unknown> {
  const out = { ...metadata };
  for (const k of BUILDER_OWNED_METADATA_KEYS) delete out[k];
  return out;
}

/**
 * The `metadata` object to persist for `wf`. Use this at EVERY site that POSTs
 * a definition — the autosave and all three run paths — or that site silently
 * erases the keys it does not model.
 */
export function definitionMetadataFor(wf: SavedWorkflow): Record<string, unknown> {
  return {
    ...(wf.metadata ?? {}),
    name: wf.name,
    ...(wf.lifecycle ? { lifecycle: wf.lifecycle } : {}),
  };
}
