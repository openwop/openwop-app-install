/**
 * ADR 0116 Phase 4 — the `ctx.features.prompts` workflow surface (ADR 0014 seam).
 *
 * Lets a workflow node read/render a library entry mid-run (e.g. assemble a prompt
 * from the team catalog). Toggle-gated at the seam (`prompts` OFF ⇒ every method
 * refuses). Tenant isolation: the builder closes over `scope.tenantId`; methods take
 * an explicit `orgId` and the service enforces the tenant+org key (a cross-tenant id
 * isn't found). Reuses the SAME service the routes use — `renderEntry` is the single
 * render source (no duplicated substitution). Reads only; replay-safe via the
 * action-node convention (the seam records outputs).
 */
import type { BundleScope, SurfaceFn } from '../../host/inMemorySurfaces.js';
import { surfaceStr } from '../../host/featureSurfaces.js';
import { listEntries, getEntry, renderEntry } from './promptLibraryService.js';

export function buildPromptSurface(scope: BundleScope): Record<string, SurfaceFn> {
  const tenantId = scope.tenantId;
  return {
    /** List the org's library entries: { orgId } → { entries }. */
    listLibrary: async (args) => ({ entries: await listEntries(tenantId, surfaceStr(args.orgId)) }),
    /** Get one entry: { orgId, entryId } → { entry|null }. */
    getEntry: async (args) => ({ entry: await getEntry(tenantId, surfaceStr(args.orgId), surfaceStr(args.entryId)) }),
    /** Render an entry's referenced template with {{var}} bindings:
     *  { orgId, entryId, variables } → { composed, templateId }. */
    renderEntry: async (args) => renderEntry(
      tenantId, surfaceStr(args.orgId), surfaceStr(args.entryId),
      (args.variables && typeof args.variables === 'object' ? args.variables : {}) as Record<string, unknown>,
    ),
  };
}
