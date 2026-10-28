/**
 * `ctx.features['campaign-playbooks']` (ADR 0959 matrix row 3) — READ-ONLY in v1: rollouts are
 * human-initiated. Every op takes `orgId` and is bound to that client exactly as campaign-ops'
 * surface is (`bindRunToClient`: a person behind the run, `workspace:read` on that client org,
 * the client exists), and additionally refuses a run whose own playbook stamp names a different
 * client (`wrong_client`): a run installed for client A cannot read client B.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { bindRunToClient } from '../campaign-ops/surface.js';
import { getAgencyLayer, getInstallation, mergeLayers, mergeSlots, parseLayer } from './installService.js';
import { getVersion } from './playbookStore.js';
import { PLAYBOOK_RUN_STAMP_KEY, type PlaybookRunStamp } from './types.js';

async function bindPlaybookRun(scope: BundleScope, orgId: string): Promise<void> {
  if (scope.runId) {
    const run = await hostExtStorage().getRun(scope.runId);
    const stamp = run && run.tenantId === scope.tenantId ? (run.metadata as Record<string, unknown> | undefined)?.[PLAYBOOK_RUN_STAMP_KEY] as PlaybookRunStamp | undefined : undefined;
    if (stamp && stamp.orgId !== orgId) throw new OpenwopError('forbidden_scope', 'This run belongs to a different client.', 403, { reason: 'wrong_client' });
  }
  await bindRunToClient(scope, orgId);
}

export function buildCampaignPlaybooksSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** The client's installation of a playbook: version, ring, history (no layers' raw people fields). */
    getInstallation: async (args) => {
      const orgId = str(args.orgId);
      await bindPlaybookRun(scope, orgId);
      const row = await getInstallation(tenantId, orgId, str(args.playbookId));
      if (!row || row.status !== 'installed') return { installed: false };
      return { installed: true, playbookId: row.playbookId, version: row.pinnedVersion, contentHash: row.contentHash, ring: row.ring ?? 'general', workflowId: row.workflowId, installedVersions: row.history.map((h) => h.version) };
    },
    /** D3 — the values this client's installation runs with (layers 0 → 1 → 2) and its slot bindings. */
    effectiveConfig: async (args) => {
      const orgId = str(args.orgId);
      await bindPlaybookRun(scope, orgId);
      const row = await getInstallation(tenantId, orgId, str(args.playbookId));
      if (!row || row.status !== 'installed') throw new OpenwopError('not_found', 'This playbook is not installed for this client.', 404, { orgId, reason: 'playbook_not_installed' });
      const version = await getVersion(tenantId, row.playbookId, row.pinnedVersion);
      if (!version) throw new OpenwopError('not_found', 'The installed playbook version is gone.', 404, {});
      const agencyRow = await getAgencyLayer(tenantId, row.playbookId);
      const agency = agencyRow ? parseLayer(agencyRow, version, 'agencyLayer') : row.layers.agency;
      return { version: version.version, params: mergeLayers(version, row.layers.client, agency), slots: mergeSlots(row.layers.client, agency) };
    },
  };
}
