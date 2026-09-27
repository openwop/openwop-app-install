/**
 * ADR 0194 Phase 3 — per-tenant pack enablement, the registration choke
 * point (extracted from routes/workflows.ts by ADR 0481: the collab derive
 * is a second registration path and must enforce the same curation).
 * Rejects a definition whose nodes come from packs the workspace disabled.
 * Checks ONLY the disabled dimension (availability curation, not runtime
 * deactivation) — typeIds absent from the catalog keep today's behavior.
 */
import { OpenwopError } from '../types.js';
import { resolveDisabledPacks } from './packVisibility.js';
import { buildNodeCatalog } from './nodeCatalogBuilder.js';
import type { WorkflowDefinition } from '../executor/types.js';

export async function assertNoDisabledPacks(def: WorkflowDefinition, tenantId: string): Promise<void> {
  const disabled = await resolveDisabledPacks(tenantId);
  if (disabled.size === 0) return;
  const packByTypeId = new Map<string, string>();
  for (const n of buildNodeCatalog()) {
    if (n.packName) packByTypeId.set(n.typeId, n.packName);
  }
  const hit = new Set<string>();
  for (const node of def.nodes) {
    const pack = packByTypeId.get(node.typeId);
    if (pack && disabled.has(pack)) hit.add(pack);
  }
  if (hit.size > 0) {
    throw new OpenwopError(
      'forbidden',
      `Workflow uses pack(s) disabled in this workspace: ${[...hit].sort().join(', ')}. Re-enable them in the Marketplace first.`,
      403,
      { disabledPacks: [...hit].sort() },
    );
  }
}
