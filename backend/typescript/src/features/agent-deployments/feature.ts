/**
 * RFC 0082 agent deployment lifecycle (ADR 1005). Self-contained feature-package
 * (ADR 0001): the v2 routes, and the channel resolver registered into the host
 * seam the executor calls (`host/agentChannelPin.ts`). Both answer as
 * unadvertised until `OPENWOP_AGENT_DEPLOYMENT=on` (`capability.ts`).
 */

import type { BackendFeature } from '../types.js';
import { registerAgentChannelResolver } from '../../host/agentChannelPin.js';
import { resolveAgentForTenant } from '../../host/agentVisibility.js';
import { registerHostRunInterruptHandler } from '../../host/hostRunInterrupts.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { setAgentPackInstalledHook, setArchivePinnedVersions } from '../../packs/agentPackArchive.js';
import { registerAgentServingResolver } from '../../host/agentServing.js';
import { DEPLOYMENT_MANAGEMENT_WORKFLOW_ID, allNamedVersions, deleteAgentDeployments, deploymentApprovalHandler, hasStoredRows, isReservedAgent, listDeployments, mintDraft, mintInstalledDrafts, resolveChannel, versionsNamedByRows } from './service.js';
import { setUserAgentDeletedHook, setUserAgentPinnedRevisions, setUserAgentRevisedHook } from '../../host/userAgentRevisions.js';
import { prefetchVersions } from './prefetch.js';
import { agentDeploymentFacet } from './capability.js';
import { registerAgentDeploymentPolicyRoutes } from './policyRoutes.js';
import { registerAgentDeploymentV2Routes } from './v2Routes.js';

export const agentDeploymentsFeature: BackendFeature = {
  id: 'agent-deployments',
  registerRoutes: (deps) => {
    registerAgentDeploymentV2Routes(deps);
    registerAgentDeploymentPolicyRoutes(deps);
    // ADR 1005 D14 — a gated transition's run resolves through the ordinary interrupt route.
    registerHostRunInterruptHandler(DEPLOYMENT_MANAGEMENT_WORKFLOW_ID, deploymentApprovalHandler(deps.storage));
    registerAgentChannelResolver({
      async resolve(tenantId, agentId, channel, drawKey) {
        let baseline: string | undefined;
        if (!isReservedAgent(agentId)) {
          const a = await resolveAgentForTenant(agentId, tenantId);
          if (!a) return { ok: false, reason: 'no_active_deployment' };
          baseline = a.packVersion || undefined;
        }
        return resolveChannel(tenantId, agentId, channel, drawKey, baseline);
      },
      // ADR 1014 P0/D2 — the installed head, or an archived version (D1) this host can load.
      async available(tenantId, agentId, version) {
        if (isReservedAgent(agentId)) return true;
        const a = await resolveAgentForTenant(agentId, tenantId);
        if (!a) return false;
        if ((a.packVersion || undefined) === version) return true;
        if ((await getAgentRegistry().resolve(agentId, tenantId, version)) !== null) return true;
        // Not on this instance: fail this run now (typed) and fetch it for the next.
        void prefetchVersions([{ tenant: tenantId, agentId, version }]).catch(() => undefined);
        return false;
      },
    });
    // ADR 1014 Q3 — an archived version a deployment row names is never pruned.
    setArchivePinnedVersions((_packName, agentIds) => versionsNamedByRows(agentIds));
    // ADR 1014 D4 — under OPENWOP_AGENT_VERSIONS=on, an unpinned execution of a pack
    // agent with rows runs what `stable` serves; with no rows, its head.
    registerAgentServingResolver(async (tenantId, agentId, drawKey) => {
      if (isReservedAgent(agentId) || !agentDeploymentFacet()) return undefined;
      if (!(await hasStoredRows(tenantId, agentId))) return undefined;
      const r = await resolveChannel(tenantId, agentId, 'stable', drawKey);
      return r.ok ? r.version : null;
    });
    // ADR 1014 P5 — a user agent's revisions: rows pin theirs, and an edit of a deployed
    // user agent arrives as a draft (flag-gated, like an install).
    setUserAgentPinnedRevisions(async (tenant, agentId) => new Set((await listDeployments(tenant, agentId)).map((r) => r.version)));
    // Minting changes nothing that runs, so it does not wait for the flag: with the
    // flag off, a deployment pinned to a channel can still promote the edit (review M3).
    setUserAgentRevisedHook(async (tenant, agentId, revision) => {
      if (!(await hasStoredRows(tenant, agentId))) return;
      await mintDraft(tenant, agentId, revision, 'agent-edit');
    });
    setUserAgentDeletedHook((tenant, agentId) => deleteAgentDeployments(tenant, agentId));
    setAgentPackInstalledHook(async (_packName, version, agentIds) => {
      await mintInstalledDrafts(agentIds, version);
    });
    // ADR 1014 D1 — at startup, fetch every version a deployment names (background).
    setImmediate(() => {
      if (!agentDeploymentFacet()) return;
      void allNamedVersions().then(prefetchVersions).catch(() => undefined);
    });
  },
};
