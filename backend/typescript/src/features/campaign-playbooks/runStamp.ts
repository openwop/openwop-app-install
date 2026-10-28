/**
 * ADR 0959 D8 — stamp which playbook version made a run, at run creation, from the host-written
 * workflow → installation index (never from the definition's metadata, which the builder edits).
 *
 * - Contributes NOTHING on a `:fork` / replay (`derivedFromRun`): the copied metadata is
 *   authoritative both ways, so a fork keeps its source's stamp and a source without one
 *   stays without one (ADR 0604).
 * - The key is in `RESERVED_RUN_METADATA_KEYS`, so a caller can never supply it.
 * - `drift` is `edited` when the run's pinned definition (`definitionRevision`, stamped before
 *   contributors run) is not the definition the install wrote (a builder edit, D3), and
 *   `unknown` when the run carries no pin to compare (J959WF-2: never claim what was not measured).
 */
import type { RunStartContributor } from '../../host/runStartContext.js';
import { installationForWorkflow } from './installService.js';
import { PLAYBOOK_RUN_STAMP_KEY, type PlaybookRunStamp } from './types.js';

export const playbookRunStampContributor: RunStartContributor = async (ctx) => {
  if (ctx.derivedFromRun || !ctx.workflowId) return {};
  const install = await installationForWorkflow(ctx.tenantId, ctx.workflowId);
  if (!install || !install.expectedRevision) return {};
  const pinned = ctx.metadata?.definitionRevision;
  const stamp: PlaybookRunStamp = {
    playbookId: install.playbookId,
    version: install.pinnedVersion,
    contentHash: install.contentHash,
    orgId: install.orgId,
    layersHash: install.layersHash ?? '',
    drift: typeof pinned !== 'string' ? 'unknown' : pinned === install.expectedRevision ? 'none' : 'edited',
  };
  return { [PLAYBOOK_RUN_STAMP_KEY]: stamp };
};
