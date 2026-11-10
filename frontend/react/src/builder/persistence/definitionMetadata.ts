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
 * Builder-owned `name`, `lifecycle` and the namespaced raw launch defaults
 * overlay their SavedWorkflow values. Other metadata and editor-namespace
 * siblings are carried verbatim. The editor leaf uses customProperties, the
 * canonical host-extension slot; it is not a new runtime-default field.
 */

import i18n from '../../i18n/index.js';
import { BuilderEditorMetadataError, withBuilderDefaultInputs } from './editorMetadata.js';
import type { SavedWorkflow } from '../schema/workflow.js';

/** Top-level builder-owned keys. The nested editor container stays carried so
 *  unknown siblings survive; definitionMetadataFor overlays its current raw
 *  defaultInputs leaf when the caller models it. */
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
  const carried = wf.metadata ?? {};
  let metadata = carried;
  if (typeof wf.defaultInputs === 'string') {
    try {
      metadata = withBuilderDefaultInputs(carried, wf.defaultInputs);
    } catch (error) {
      if (error instanceof BuilderEditorMetadataError) {
        throw new BuilderEditorMetadataError(i18n.t('builder:defaultInputsMetadataConflict'));
      }
      throw error;
    }
  }
  return {
    ...metadata,
    name: wf.name,
    ...(wf.lifecycle ? { lifecycle: wf.lifecycle } : {}),
  };
}
