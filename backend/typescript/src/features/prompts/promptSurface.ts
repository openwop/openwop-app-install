/**
 * ADR 0116 Phase 4 — the `ctx.features.prompts` workflow surface (ADR 0014 seam).
 *
 * Lets a workflow node read/render a library entry mid-run (e.g. assemble a prompt
 * from the team catalog). Toggle-gated at the seam (`prompts` OFF ⇒ every method
 * refuses). Tenant isolation: the builder closes over `scope.tenantId`; methods take
 * an explicit `orgId` and the service enforces the tenant+org key (a cross-tenant id
 * isn't found). Reuses the SAME service the routes use — `renderEntry` is the single
 * render source (no duplicated substitution).
 *
 * CORRECTED (ADR 0694 D2a) — this used to claim the surface was "replay-safe via
 * the action-node convention (the seam records outputs)". There is NO such
 * convention. `gen-side-effect-floor.mjs:139` binds the floor on
 * `role === 'side-effect'` OR the `side-effectful` capability; nothing under
 * `src/executor/` reads `role:"action"` at all. MEASURED: all three
 * `feature.prompts.nodes.*` are floor=false, served=false, declared=true — so
 * nothing records or serves their outputs.
 *
 * What is actually true: these are PURE READS. They are NOT replay-served; on a
 * replay they re-execute and re-read the LIVE store, so a render can compose
 * different text than the original run if the template moved (an unpinned
 * `promptRef` resolves to latest by design — see `resolvePromptRef`). That
 * duplicates no effect, which is why it is safe; it is not safe BECAUSE
 * anything recorded it. Same correction as ADR 0655 D4 (email nodes).
 */
import type { BundleScope, SurfaceFn } from '../../host/inMemorySurfaces.js';
import { surfaceStr } from '../../host/featureSurfaces.js';
import { listEntries, getEntry, renderEntry, canonicalPromptActor } from './promptLibraryService.js';

export function buildPromptSurface(scope: BundleScope): Record<string, SurfaceFn> {
  const tenantId = scope.tenantId;
  // PLC-1 — the workflow's acting human is the caller: a private entry is visible to
  // its owner's runs, never to another user's run (a system run with no acting user
  // sees org/shared only). CANONICALIZE to the SAME id space `createEntry` stamps as
  // `createdBy` (`resolveCallerUser → userIdFor(tenantId, principal)`): a run's
  // `actingUserId` is the RAW `req.userId ?? principalId`, so an unbound-OIDC/bearer
  // owner arrives as `oidc:<sub>` while their `createdBy` is `user:<hash>`. An already
  // `user:`-prefixed id (bound browser / org tenant) is canonical already — pass it
  // through so those callers keep matching. Without this an owner is locked out of
  // their OWN default-private prompt via `ctx.prompts`.
  // ADR 0694 D3a — the rule now lives beside `createEntry`, which DEFINES this id
  // space. It was inline HERE, and that is exactly why the portability importer
  // never received it (`PLC-7`). One owner, three callers.
  const raw = scope.actingUserId;
  const caller = raw ? canonicalPromptActor(tenantId, raw) : raw;
  return {
    /** List the org's library entries: { orgId } → { entries }. */
    listLibrary: async (args) => ({ entries: await listEntries(tenantId, surfaceStr(args.orgId), caller) }),
    /** Get one entry: { orgId, entryId } → { entry|null }. */
    getEntry: async (args) => ({ entry: await getEntry(tenantId, surfaceStr(args.orgId), surfaceStr(args.entryId), caller) }),
    /** Render an entry's referenced template with {{var}} bindings:
     *  { orgId, entryId, variables } → { composed, templateId }. */
    renderEntry: async (args) => renderEntry(
      tenantId, surfaceStr(args.orgId), surfaceStr(args.entryId),
      (args.variables && typeof args.variables === 'object' ? args.variables : {}) as Record<string, unknown>,
      caller,
    ),
  };
}
