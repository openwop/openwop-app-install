/**
 * Host-extension workflow-registration routes used by the in-app
 * builder UI. Vendor-prefixed under `/v1/host/openwop-app/*` per
 * `spec/v1/host-extensions.md` §"Canonical prefixes" — these are NOT
 * part of the v1 wire contract.
 *
 *   POST   /v1/host/openwop-app/workflows           — register / overwrite
 *   GET    /v1/host/openwop-app/workflows           — list registered
 *   DELETE /v1/host/openwop-app/workflows/:workflowId
 *
 * The workflowCatalog (`src/host/index.ts`) consults the in-memory
 * registry after its hardcoded samples, so a registered workflow is
 * immediately resolvable by `POST /v1/runs`.
 *
 * The definition validator + RFC 0022 §C capability gate live in
 * `host/workflowDefinitionValidation.ts` — the SINGLE validation path
 * shared with the AI workflow-author feature (ADR 0072).
 */

import type { Express, Request, Response } from 'express';
import { OpenwopError } from '../types.js';
import { validateWorkflowDefinition, WORKFLOW_ID_PATTERN } from '../host/workflowDefinitionValidation.js';
import type { HostAdapterSuite } from '../host/index.js';
import { tenantOf } from '../host/requestSubject.js';
import { requireWorkflowWrite } from '../host/workflowWriteAuthority.js';
import { recordOwnership, listOwned, getOwned, uniqueOwnedName, isWorkflowForeignTo, PUBLIC_WORKFLOW_ID, isSharedWorkflowId, WORKFLOW_SUBJECT_PATTERN } from '../host/workflowOwnership.js';
import { forkSharedWorkflow, retryPendingRepoints, forkOfShared, CANVAS_PRISTINE_HEADER } from '../host/sharedWorkflowFork.js';
import { lifecycleOf, withLifecycle } from '../host/workflowLifecycle.js';
import { registerWorkflowComposeTool, registerWorkflowProposeTool, registerComposedWorkflowDecisionHandler } from '../host/workflowComposeTool.js';
import { registerRunDiagnoseTool } from '../host/runDiagnoseTool.js';
import { getRegisteredWorkflowAsync, registerWorkflowDurable, readRegisteredWorkflowFresh, registerWorkflowIfUnchanged } from '../host/workflowsRegistry.js';
import { recordRevision, listRevisions, getRevision, revisionVisibleTo } from '../host/workflowRevisions.js';
import { listEvalSets, listEvalResults } from '../host/workflowEvalSets.js';
import { revisionHashOf } from '../host/definitionHash.js';
import { loadOwnedRun } from '../host/runAccess.js';
import { aggregateFleetStats } from '../host/workflowFleetStats.js';
import { estimateWorkflowCost } from '../host/workflowCostEstimate.js';
import { listBudgetsForTenant, listTodaySpendForTenant } from '../host/workflowBudgets.js';
import type { Storage } from '../storage/storage.js';
import { pinMismatches } from '../host/chainPinRule.js';
import { getChain, listChains, expandChain, reloadWorkflowChainPacks, chainRequirements, coRegisterSubChains, findMissingRequiredConfig, findUnfilledExpansionParams, SubChainError } from '../host/workflowChainPackLoader.js';
import { validateChainBackedSubChainBinds } from '../host/chainBackedWorkflows.js';
import { workflowRoomLive } from '../host/collab/workflowCollabResource.js';
import { deleteTenantWorkflow } from '../host/tenantWorkflowDelete.js';
import { assertNoDisabledPacks } from '../host/packEnablement.js';
import { preserveDroppedFields, parseFieldContract, FIELD_CONTRACT_HEADER } from '../host/preserveDroppedFields.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { getToggleDefault } from '../host/featureToggles/registry.js';
import { buildNodeCatalog, requiredConfigKeysFor } from '../host/nodeCatalogBuilder.js';
import { assertInstallable, installFromConfiguredRegistry } from '../packs/installLane.js';
import { requireSuperadmin } from '../host/superadmin.js';

import type { WorkflowDefinition } from '../executor/types.js';
import { copyWorkflowId, isServerMintedWorkflowId, mintUnique, workflowKind } from '../host/workflowId.js';
import { createLogger } from '../observability/logger.js';
import { getChainBackedWorkflow } from '../host/chainBackedWorkflows.js';
import { resolveCallerDisplayName } from '../host/chatContext.js';
import { assessWorkflowAvailability } from '../host/workflowDemoAvailability.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';

const log = createLogger('routes.workflows');

/**
 * ADR 0194 Phase 3 — per-tenant pack enablement, the registration choke point.
 * Rejects a NEW definition whose nodes come from packs the caller's workspace
 * disabled. Checks ONLY the disabled dimension: typeIds absent from the catalog
 * keep today's behavior (registration has never done a closed-world check —
 * that gate belongs to the workflow-author, RFC 0022 §C). Existing definitions
 * and runs are untouched (availability curation, not runtime deactivation).
 */


/**
 * Of `candidateNodeIds`, the ones a RUN of `workflowId` actually recorded an
 * event for (ADR 0440 P2, grade-pass correction).
 *
 * The first implementation gated on `hasRunForWorkflow`, which is
 * `SELECT 1 FROM runs WHERE workflow_id = $1 LIMIT 1` — it proves a run exists,
 * NOT that any run touched these nodes. That made the disclosure over-report:
 * a node added and deleted between runs, or one on a never-taken branch, was
 * announced as "existing runs recorded this step". A field that cries wolf
 * gets learned-ignored, and the user-facing copy was asserting something the
 * host had not checked.
 *
 * Bounded by construction: it scans the newest runs of this workflow only, and
 * stops as soon as every candidate is accounted for. Reached only when a save
 * actually shrank the node-id set, so the common autosave never pays for it.
 */
async function nodeIdsRecordedByRuns(
  storage: Storage,
  tenantId: string,
  workflowId: string,
  candidateNodeIds: readonly string[],
): Promise<string[]> {
  const RUN_SCAN_LIMIT = 25;
  const pending = new Set(candidateNodeIds);
  const found = new Set<string>();
  try {
    // ADR 0770 D7 (`WBWF-11`) — filtered AT THE SOURCE. This read the 200 newest
    // runs HOST-WIDE and filtered here, a silent false negative on a busy host.
    const runs = await storage.listRuns({ tenantId, workflowId, limit: RUN_SCAN_LIMIT });
    for (const run of runs) {
      if (pending.size === 0) break;
      for (const ev of await storage.listEvents(run.runId)) {
        if (ev.nodeId && pending.has(ev.nodeId)) {
          pending.delete(ev.nodeId);
          found.add(ev.nodeId);
        }
      }
    }
  } catch (err) {
    // Fail QUIET, not loud: the disclosure is advisory, and a storage blip must
    // never turn an ordinary save into an error. Logged so it is not invisible.
    log.warn('removed_node_run_probe_failed', { workflowId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  // Preserve the caller's order so the notice reads deterministically.
  return candidateNodeIds.filter((id) => found.has(id));
}

/**
 * Reserved PUBLIC workflow-id namespaces (ADR 0163 / M7): seeded chains
 * (`wf.seed.*`), premade templates (`tmpl.*`), and the built-in examples +
 * host system defs (`openwop-app.*`). Every tenant may READ/fork these, so the
 * M7 read guard exempts them. WRITES are NOT exempt (ADR 0440 P4 grade-pass):
 * `openwop-app.*` also contains host system workflows, and a tenant must never
 * overwrite one — see `isWriteProtected`, which keys on registration, not on
 * this prefix.
 */
// `PUBLIC_WORKFLOW_ID` — single-sourced in host/workflowOwnership.ts (ADR 0788).

/**
 * The M7 cross-tenant READ predicate for a workflow id (ADR 0440 P4). Returns
 * `true` when the caller must be refused a by-id READ: the id is owned by some
 * other tenant and the caller is neither a wildcard operator nor reading a
 * public template (which every tenant may read/fork).
 *
 * 404 (not 403) is the correct refusal — a 403 would confirm the id exists and
 * belongs to someone, reinstating the existence oracle the M7 fix removed.
 *
 * Perf: the `getOwned` point lookup answers for an owner; a non-owner pays
 * `isAuthoredByOtherTenant`, which reads only that workflow's ownership rows.
 * (It was a full-table scan and NOT infrequent: every conformance fixture read
 * is an un-owned read — EVID-1.)
 */
export async function isForeignOwned(tenantId: string, principal: Request['principal'], workflowId: string): Promise<boolean> {
  if (principal?.tenants?.includes('*') === true) return false; // wildcard operator
  if (PUBLIC_WORKFLOW_ID.test(workflowId)) return false;         // shared template — public READ
  // ADR 0823 D1 — the same predicate the launch funnel asks, so a definition a
  // tenant cannot read is one it cannot run (owned → point lookup; else by-workflow).
  return isWorkflowForeignTo(tenantId, workflowId);
}

/**
 * The WRITE guard (ADR 0440 P4, corrected in the grade-pass). Returns `true`
 * when the caller must be refused an OVERWRITE.
 *
 * The first cut refused only ids *owned by another tenant*, which left a WORSE
 * hole than the one it closed: the host registers system definitions at boot
 * (`openwop-app.channel.turn`, `assistant.loop.*`, `feature.agent-knowledge.*`,
 * …) via `registerWorkflow` with NO ownership row — so they are UNOWNED, and an
 * unowned id was treated as free. A grade-pass data audit proved a tenant could
 * POST under `openwop-app.channel.turn` (201) and poison the workflow that
 * drives inbound omnichannel processing for EVERY tenant.
 *
 * The correct signal is not "owned by another tenant" but "already REGISTERED
 * and not owned by me". A genuinely free id is not in the registry (create
 * stays open); a foreign-tenant def AND a host system def are both registered
 * and unowned-by-caller, so both are refused. This is a registry POINT LOOKUP —
 * strictly stronger than the read predicate and cheaper than the ownership scan
 * (writes no longer scan at all). The public-namespace exemption is DROPPED for
 * writes: no legitimate tenant route-writes `wf.seed.*`/`tmpl.*`/`openwop-app.*`
 * (seeders call `recordOwnership` directly; from-chain mints random ids), and a
 * tenant that seeded a `wf.seed.*` copy OWNS it, so `getOwned` still lets it
 * self-overwrite.
 *
 * §Correction (ADR 0789): "a tenant that seeded a `wf.seed.*` copy OWNS it, so
 * `getOwned` still lets it self-overwrite" was the hole, not the exemption. The
 * seeded tenant owns an OWNERSHIP ROW; the definition is one row every seeded
 * tenant runs, so that self-overwrite rewrote everyone's workflow. A shared id is
 * now never written through a tenant route: an owner's save forks (the POST
 * handler), and a free shared-namespace id is refused (a pre-squat).
 *
 * Residual (documented, low severity): two tenants racing the FIRST write of
 * the same never-registered id both pass, since neither is registered yet. The
 * storage layer has no CAS to close it; user-authored ids are random so a
 * natural collision is negligible, and deterministic seeded ids never route.
 */
async function isWriteProtected(tenantId: string, principal: Request['principal'], workflowId: string): Promise<boolean> {
  if (principal?.tenants?.includes('*') === true) return false; // wildcard operator (host tooling)
  // ADR 0789 — a SHARED id is never written through a tenant route. An owner
  // passes here only to be FORKED by the caller (`forkSharedWorkflow`); a free
  // shared-namespace id is refused outright — creating `wf.seed.<next-chain>`
  // before the seeder does would make the squatter's steps the definition every
  // later seeded tenant adopts (the seeder is register-if-missing).
  // A tenant that already FORKED it (a concurrent first save, a second tab, a
  // queued autosave) is let through too: its write lands on its own fork.
  if (isSharedWorkflowId(workflowId)) {
    if (await getOwned(tenantId, workflowId)) return false;
    return !(await forkOfShared(tenantId, workflowId));
  }
  if (await getOwned(tenantId, workflowId)) return false;        // self-overwrite / autosave
  // ADR 0794 — a server-minted origin (`copy`, `fork`, `sub`, `cadence`) is never
  // CREATED through a tenant route. `sub` and `cadence` ids are deterministic from
  // the tenant id, so a free one could be registered by anyone who knows that id
  // before its owner's first instantiation — the `wf.seed.*` pre-squat, one origin
  // over. Owned ids returned above, so a tenant still saves its own copy or fork.
  if (isServerMintedWorkflowId(workflowId)) return true;
  // ADR 0703 — BOTH host registries, not just the raw one. This asked only
  // `getRegisteredWorkflowAsync`, and chain-backed definitions live in
  // `chainBackedWorkflows`' OWN registry (`host/index.ts` catalog source A). So
  // draining a host workflow from `registerWorkflow` to `registerChainBackedWorkflow`
  // — the ADR 0701/0703 pin-site migration — silently REMOVED its write protection,
  // and a tenant could POST a definition under the host id and overwrite it.
  //
  // Caught by `workflow-overwrite-tenant-guard.test.ts` on the channel drain (201
  // where 404 was required). The same hole applied to `openwop-app.scheduled-chat.turn`
  // the moment ADR 0701 merged — a migration that changes WHICH registry holds a
  // definition changes every predicate that keys on "is it registered", and those
  // predicates are the authz layer.
  //
  // The guard's own contract is registration, not ownership (see the header comment on
  // `PUBLIC_WORKFLOW_ID`), and a chain-backed registration IS a host registration — so
  // consulting it is faithful to the intent, not a widening of it.
  if (getChainBackedWorkflow(workflowId)) return true;           // host chain-backed ⇒ refuse
  return Boolean(await getRegisteredWorkflowAsync(workflowId));  // registered + not mine ⇒ refuse
}

/** ADR 0770 D5 — the revision hash out of `If-Match: "<hash>"` (quotes and a
 *  weak `W/` prefix tolerated). `*` or absent ⇒ no precondition. */
function parseIfMatch(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const v = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return v && v !== '*' ? v : undefined;
}

/** ADR 0770 D5 — the typed stale-write refusal. The current head's revision
 *  rides the `ETag` header, NOT the envelope: error details are entropy-scrubbed
 *  (`sanitizeDetails`), which redacts a 64-hex hash to `<redacted:high-entropy>`
 *  — a field that would be present and always wrong. */
function headMovedConflict(res: Response, workflowId: string, headRevision: string | undefined): OpenwopError {
  if (headRevision) res.setHeader('ETag', `"${headRevision}"`);
  return new OpenwopError(
    'conflict',
    'This workflow was saved from somewhere else since you opened it.',
    409,
    { workflowId, reason: 'workflow_head_moved' },
  );
}

/**
 * ADR 0770 D3 (`WBWF-1`) — commit ONE staged sub-chain child. The child id is
 * deterministic per `(tenant, chain, version)` (RFC 0133 §1.3 convergence), so
 * a repeat instantiation lands on a child the tenant may already have EDITED.
 * The old commit was an unconditional overwrite: a fresh `params:{}` expansion
 * replaced the user's edits and rename, un-archived it, ignored a live room,
 * and changed what every earlier parent run replays against. Three outcomes:
 *
 *  - `created` — not owned here, or owned but the definition does not resolve
 *    (a lost fire-and-forget write): register + first revision + ownership,
 *    stamping `mintedRevision`.
 *  - `refreshed` — owned, and the head is still exactly what the host minted
 *    (`mintedRevision`), and no room is live: re-register the fresh expansion.
 *    This keeps re-instantiation as the heal for a child an OLDER host minted —
 *    expansion output changes under a fixed chain version. Lifecycle carries
 *    over (`revisionHashOf` strips it, so an archived-but-pristine child stays
 *    archived).
 *  - `reused` — anything else (edited, a legacy child with no stamp, or a live
 *    room): bound as-is, no write at all.
 *
 * No compensating delete on a later failure: a concurrent request may already
 * have reused a child this request created (architect H3). The worst case is an
 * owned, unreferenced child, as before.
 */
async function commitSubChainChild(
  tenantId: string,
  childDef: WorkflowDefinition,
  childName: string,
): Promise<'created' | 'refreshed' | 'reused'> {
  const id = childDef.workflowId;
  const owned = await getOwned(tenantId, id);
  // grade-code WBCD-2 — decide AND write against one FRESH read, with an atomic
  // swap: deciding from the per-instance cache and then writing blind let an
  // edit made on another instance (or between the read and the write) be
  // replaced by the refresh.
  const fresh = await readRegisteredWorkflowFresh(id);
  const head = owned ? fresh.def : null;
  let toWrite = childDef;
  let outcome: 'created' | 'refreshed' = 'created';
  if (owned && head) {
    const headRevision = revisionHashOf(head);
    // grade-code WBCD-8 — a child minted before `mintedRevision` existed carries
    // no stamp; it is provably pristine when its history is exactly the one
    // revision the mint recorded and the head still is that revision.
    const pristine = owned.mintedRevision !== undefined
      ? headRevision === owned.mintedRevision
      : await isSingleRevisionHead(id, tenantId, headRevision);
    if (!pristine || (await workflowRoomLive(id))) return 'reused';
    const lc = lifecycleOf(head);
    toWrite = withLifecycle(childDef, { transient: lc.transient, archivedAt: lc.archivedAt, generatedBy: lc.generatedBy });
    outcome = 'refreshed';
  }
  if (!(await registerWorkflowIfUnchanged(toWrite, fresh.raw))) return 'reused'; // it moved under us — keep theirs
  await recordRevision(tenantId, toWrite);
  const lc = lifecycleOf(toWrite);
  // grade-data D-7 — a chain-version bump rightly mints a NEW child (the id keys
  // on version), but it must not be a second workflow with the same name: a new
  // child takes a unique name; a child already owned keeps the one it has.
  const name = owned?.name ?? await uniqueOwnedName(tenantId, childName);
  await recordOwnership(tenantId, id, {
    name,
    nodeCount: toWrite.nodes.length,
    ...(lc.transient !== undefined ? { transient: lc.transient } : {}),
    ...(lc.archivedAt !== undefined ? { archivedAt: lc.archivedAt } : {}),
    mintedRevision: revisionHashOf(toWrite),
  });
  return outcome;
}

/** grade-code WBCD-8 — true when `workflowId`'s visible history is exactly one
 *  revision and it is the current head (a legacy, never-edited mint). */
async function isSingleRevisionHead(workflowId: string, tenantId: string, headRevision: string): Promise<boolean> {
  const rows = (await listRevisions(workflowId)).filter((r) => revisionVisibleTo(tenantId, r));
  return rows.length === 1 && rows[0]!.revisionHash === headRevision;
}

export function registerWorkflowRoutes(app: Express, deps: { hostSuite: HostAdapterSuite; storage: Storage }): void {
  // ADR 0369 §6 — the compose-and-run agent tool registers here because this
  // is where its run-starter deps live (core-level capability; ADR 0104
  // grants decide which agents may call it).
  registerWorkflowComposeTool({ storage: deps.storage, hostSuite: deps.hostSuite });
  // ADR 0473 — the propose lane (no run-starter deps by design: proposing can
  // never execute) + the composed-workflow decide handler (which is the ONLY
  // path from a proposal to startWorkflowRun, and runs only on a human claim).
  registerWorkflowProposeTool({ workflowCatalog: deps.hostSuite.workflowCatalog });
  // ADR 0476 §4 — the grounded failure-diagnosis read tool (core-level: runs
  // are core; ADR 0104 grants decide who may call it; default-on baseline).
  registerRunDiagnoseTool({ storage: deps.storage });
  registerComposedWorkflowDecisionHandler({ storage: deps.storage, hostSuite: deps.hostSuite });

  // Tenant-scoped list (ADR 0163 R1): returns only the caller's tenant's owned
  // workflows (list metadata), via the ownership index — NOT the global registry
  // (which would leak every tenant's workflows). The global by-id resolver stays
  // `GET /v1/workflows/{id}` below.
  app.get('/host/openwop-app/workflows', async (req, res, next) => {
    try {
      const owned = await listOwned(tenantOf(req));
      // ADR 0369: archived stays out of the default list. Transient DRAFTS
      // stay VISIBLE here — this is the owner's own scoped list (they must be
      // able to find a draft they navigated away from); the catalog-hiding
      // that matters is the GLOBAL registry consumers (P1). The Draft chip
      // rides the `transient` field.
      const includeArchived = req.query.includeArchived === 'true';
      const visible = owned.filter((o) => includeArchived || !o.archivedAt);
      // ADR 0482 §6 — the dashboard budget chip data, joined via TWO tenant
      // prefix reads total (budget store + today's spend-day rows), never a
      // per-row point-read fan-out. Fail-soft: a budget-store read error
      // renders the list without chips rather than failing the list.
      const [budgetRows, spendToday] = await Promise.all([
        listBudgetsForTenant(tenantOf(req)).catch(() => []),
        listTodaySpendForTenant(tenantOf(req)).catch(() => new Map<string, number>()),
      ]);
      const budgetByWorkflow = new Map(budgetRows.map((b) => [b.workflowId, b]));
      // ADR 0474 P1b — surface "published but edited since": production
      // launches run the published revision, so the owner must SEE when the
      // head has moved past it (the no-half-truth bar).
      const rows = await Promise.all(visible.map(async (o) => {
        let publishedBehindHead: boolean | undefined;
        if (o.publishedRevision) {
          const head = await getRegisteredWorkflowAsync(o.workflowId);
          publishedBehindHead = head ? revisionHashOf(head) !== o.publishedRevision : undefined;
        }
        return {
          workflowId: o.workflowId,
          // ADR 0794 — what the id IS, so no client reads its spelling to find out.
          kind: workflowKind(o.workflowId),
          name: o.name ?? o.workflowId,
          nodeCount: o.nodeCount,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt ?? o.createdAt,
          ...(o.transient ? { transient: true } : {}),
          ...(o.archivedAt ? { archivedAt: o.archivedAt } : {}),
          ...(o.publishedRevision ? { publishedRevision: o.publishedRevision } : {}),
          ...(publishedBehindHead !== undefined ? { publishedBehindHead } : {}),
          // ADR 0596 (`WFAU-2`) — model provenance. This list is the ONLY thing
          // the dashboard and the `/` picker read, so a workflow whose entire
          // content a model wrote was indistinguishable from a hand-built one
          // everywhere in the product.
          ...(o.authoredVia ? { authoredVia: o.authoredVia } : {}),
          // ADR 0482 §6 — the budget chip payload (spend disclosed only when a
          // budget exists; the chip's tooltip discloses debug/eval inclusion).
          ...((): { budget?: { dailyUsd: number; hardCap: boolean }; spentTodayUsd?: number } => {
            const b = budgetByWorkflow.get(o.workflowId);
            if (!b) return {};
            return {
              budget: { dailyUsd: b.dailyUsd, hardCap: b.hardCap },
              spentTodayUsd: spendToday.get(o.workflowId) ?? 0,
            };
          })(),
        };
      }));
      res.json({ workflows: rows });
    } catch (err) {
      next(err);
    }
  });

  // Spec endpoint: GET /v1/workflows/{workflowId} per
  // `api/openapi.yaml operationId=getWorkflow`. Returns the workflow
  // definition (including `id` and `nodes`) for any advertised
  // workflowId — both runtime-registered workflows (via POST
  // /v1/host/openwop-app/workflows) and conformance fixtures auto-loaded
  // from `conformance/fixtures/`. 404 on unknown ids per `rest-
  // endpoints.md §"Error envelope"`.
  app.get('/workflows/:workflowId', async (req, res, next) => {
    try {
      const wf = await deps.hostSuite.workflowCatalog.getWorkflow(req.params.workflowId);
      if (!wf) {
        throw new OpenwopError(
          'workflow_not_found',
          'workflow not found',
          404,
          { workflowId: req.params.workflowId },
        );
      }
      // Tenant-scoping (2026-07 vuln-scan M7): an authored definition (prompts, node
      // config, connection refs) is readable ONLY by its owner — the global registry
      // otherwise leaked it to any caller who guessed the id. A wildcard operator reads
      // across tenants; a def owned by ANOTHER tenant → 404 (no cross-tenant read, no oracle).
      // Reserved PUBLIC namespaces (seeded chains `wf.seed.*`, premade `tmpl.*`, the
      // built-in example `openwop-app.*`) are shared templates — served to any tenant,
      // and short-circuited BEFORE the ownership scan (they're per-tenant-owned yet
      // public, so an un-owning tenant must still read them, and the common template
      // read must NOT pay the O(N) cross-tenant ownership scan).
      // ADR 0440 P4 — one shared cross-tenant predicate (was inlined here; POST
      // had NO equivalent, which was the overwrite hole).
      if (await isForeignOwned(tenantOf(req), req.principal, req.params.workflowId)) {
        throw new OpenwopError('workflow_not_found', 'workflow not found', 404, { workflowId: req.params.workflowId });
      }
      res.json(wf.definition);
    } catch (err) {
      next(err);
    }
  });

  app.post('/host/openwop-app/workflows', async (req, res, next) => {
    try {
      await requireWorkflowWrite(req); // ADR 0770 D1
      const def = validateWorkflowDefinition(req.body);
      await assertNoDisabledPacks(def, tenantOf(req)); // ADR 0194 P3 (403 + disabledPacks)

      // ADR 0440 P4 — the write half of the M7 tenant-isolation fix. Without
      // this, any tenant could OVERWRITE another tenant's definition by POSTing
      // under its id (`registerWorkflow` kv-sets a global-by-id key with no
      // tenant component), injecting content into every future run and `:fork`
      // of it, and minting a second ownership row so both tenants "own" it. The
      // M7 comment on GET named this hole as "separately tracked"; this closes
      // it, with the SAME predicate GET/DELETE use — refuse a foreign-owned id
      // as an indistinguishable 404 (no existence oracle). First-write (no one
      // owns it yet) and self-overwrite (the caller owns it) both pass, so
      // ordinary create and the builder's autosave are unaffected.
      if (await isWriteProtected(tenantOf(req), req.principal, def.workflowId)) {
        throw new OpenwopError('workflow_not_found', 'workflow not found', 404, { workflowId: def.workflowId });
      }

      // ADR 0481 (D2 lock/derive) — while a collab room lives, the ROOM is the
      // head's only writer: a REST save would silently clobber the CRDT
      // authority. Typed 409; clients in the room suspend their autosave.
      if (await workflowRoomLive(def.workflowId)) {
        throw new OpenwopError('conflict', 'This workflow is in a live collaboration session; it saves through the session until everyone leaves.', 409, { workflowId: def.workflowId, reason: 'workflow_room_live' });
      }

      // ADR 0789 — the caller OWNS a shared definition (the guard above refused
      // every other case). Its one row is every seeded tenant's, so this save
      // never reaches it: identical content is an idempotent no-op on the shared
      // id (a Run that re-registers an untouched seeded workflow must not mint a
      // copy), and changed content forks onto the caller's own id. The response
      // carries the fork's id — every client lane adopts the RETURNED id.
      if (isSharedWorkflowId(def.workflowId) && req.principal?.tenants?.includes('*') !== true) {
        const shared = await getRegisteredWorkflowAsync(def.workflowId);
        // The no-op is only for a caller that still OWNS the shared id; one that
        // already forked it (a second tab, an old bookmark) is saving into its
        // fork — so its `If-Match` is judged against the FORK's head: a canvas
        // loaded from the shared original must not silently overwrite edits the
        // fork has since gained (409 → the builder's Reload / Keep mine banner).
        const stillShared = Boolean(await getOwned(tenantOf(req), def.workflowId));
        const expected = parseIfMatch(req.headers['if-match']);
        const priorForkId = stillShared ? undefined : await forkOfShared(tenantOf(req), def.workflowId);
        const priorFork = priorForkId ? await getRegisteredWorkflowAsync(priorForkId) : null;
        // The head this write replaces: the fork once there is one, else the shared row.
        const head = priorForkId ? priorFork : shared;
        if (expected !== undefined && head && revisionHashOf(head) !== expected) {
          throw headMovedConflict(res, priorForkId ?? def.workflowId, revisionHashOf(head));
        }
        const contract = parseFieldContract(req.headers[FIELD_CONTRACT_HEADER]);
        const merged = preserveDroppedFields(def, head ?? null, contract);
        const pristine = req.headers[CANVAS_PRISTINE_HEADER] === '1';
        if (shared && stillShared && (pristine || revisionHashOf(merged.definition) === revisionHashOf(shared))) {
          const revision = revisionHashOf(shared);
          res.setHeader('ETag', `"${revision}"`);
          res.status(201).json({ workflowId: def.workflowId, nodeCount: shared.nodes.length, revision });
          return;
        }
        const fork = await forkSharedWorkflow(tenantOf(req), merged.definition, {
          ...(req.userId ? { createdBy: req.userId } : {}),
          ...(contract ? { declaredFields: [...contract] } : {}),
        });
        res.setHeader('ETag', `"${fork.revision}"`);
        res.status(201).json({
          workflowId: fork.workflowId,
          nodeCount: merged.definition.nodes.length,
          revision: fork.revision,
          forkedFrom: fork.forkedFrom,
          ...(fork.repointFailed.length > 0 ? { repointFailed: fork.repointFailed } : {}),
          ...(merged.preserved.length > 0 ? { preservedFields: merged.preserved } : {}),
        });
        return;
      }

      // ADR 0440 P2 — DISCLOSE, don't refuse. Runs re-resolve their definition
      // by id with no per-run snapshot (ADR 0369), so an edit that drops a node
      // leaves that node's recorded outcomes unmappable: on `:fork` a
      // side-effecting node with no recorded outcome yields the typed
      // `replay_source_missing` failure (executor.ts) rather than re-firing.
      //
      // The ADR originally proposed REFUSING such a write, by analogy to the
      // DELETE guard below. A test (`fork-after-node-removed.test.ts`) falsified
      // that analogy: a delete loses the definition for EVERY run with no
      // recourse, whereas this degrades ONE node and fails closed. Refusing it
      // would make deleting a node from a workflow that has ever run impossible
      // — an unsatisfiable 409 arriving 1.5s after a keystroke, via an autosave
      // the user never triggered. So the write stays allowed and the AUTHOR is
      // told instead.
      //
      // Cost: the registry read is in-memory, and the indexed run probe
      // (idx_runs_workflow) runs ONLY when the node-id set actually shrank — so
      // the common autosave (rename, move, add) pays nothing.
      //
      // SECURITY (grade-pass, two independent audits): this disclosure reads
      // the PRIOR definition out of the workflow registry, which is global by
      // id and NOT tenant-scoped (`workflowOwnership.ts` says so explicitly).
      // Returning it unconditionally would let any caller POST under another
      // tenant's workflowId and read that tenant's node ids back in the 201 —
      // and the run probe would double as a cross-tenant run-existence oracle.
      // The sibling routes all gate first (GET :152, DELETE :228, lifecycle
      // :267 — the 2026-07 vuln-scan M7 fix); so does this. Disclosure is for
      // the OWNER only.
      //
      // §Correction (ADR 0524): a sentence here used to call the
      // `registerWorkflow` below an "unguarded overwrite, pre-existing and
      // separately tracked". True when written (ADR 0440 P1-P3) and false 4.5
      // hours later, when P4 added `isWriteProtected` above — a non-owner now
      // gets an indistinguishable 404 at the guard and never reaches this line.
      // Nobody corrected the note, and it nearly mis-designed the ADR 0524
      // guard. The real residual is narrower: the documented no-CAS race on the
      // FIRST write of a never-registered id.
      const ownsIt = Boolean(await getOwned(tenantOf(req), def.workflowId));
      // ADR 0770 D5 — opt-in optimistic concurrency. With `If-Match` the head
      // is read FRESH from storage (the per-instance cache never expires, so it
      // would 409 a user's own save that landed on another instance) and the
      // write below is an atomic compare-and-swap against exactly that read.
      // Without the header: today's last-writer-wins, for every other lane.
      const expectedRevision = parseIfMatch(req.headers['if-match']);
      const fresh = expectedRevision !== undefined && ownsIt ? await readRegisteredWorkflowFresh(def.workflowId) : undefined;
      const previous = !ownsIt ? null : fresh ? fresh.def : await getRegisteredWorkflowAsync(def.workflowId);
      if (fresh?.def && revisionHashOf(fresh.def) !== expectedRevision) {
        throw headMovedConflict(res, def.workflowId, revisionHashOf(fresh.def));
      }
      const nextIds = new Set(def.nodes.map((n) => n.nodeId));
      const removedNodeIds = previous
        ? previous.nodes.map((n) => n.nodeId).filter((id) => !nextIds.has(id))
        : [];
      // Truthfulness (grade-pass): `hasRunForWorkflow` proves a run EXISTS, not
      // that one recorded these ids — so it cannot carry a claim like "runs
      // recorded this step". Intersect the removed ids with the node ids the
      // run events actually recorded, so the field means what its name says.
      const removedReferencedNodeIds = removedNodeIds.length > 0
        ? await nodeIdsRecordedByRuns(deps.storage, tenantOf(req), def.workflowId, removedNodeIds)
        : [];

      // ADR 0524 — restore fields the client dropped wholesale relative to the
      // head it replaces. Reuses `previous` above: no extra read, no new timing
      // surface. Merges rather than refuses (a 409 on a 1.5s autosave is the
      // failure ADR 0440 P2 already rejected at this same line), and discloses
      // every merge below so it cannot be a silent success.
      // ADR 0524 Phase E0 — a client that DECLARES it models a field is telling
      // us an omission is a deletion, not a bundle limitation, so the heuristic
      // stands down for that field. Absent header ⇒ heuristic, which is the
      // whole population this guard exists for.
      const declaredContract = parseFieldContract(req.headers[FIELD_CONTRACT_HEADER]);
      const preservation = preserveDroppedFields(def, previous, declaredContract);
      const defToPersist = preservation.definition;

      // ADR 0770 D2 — answer only once the definition is durable.
      if (fresh) {
        // A lost swap is a conflict only if the CONTENT moved. The raw string
        // also changes on a lifecycle verb (archive/promote re-register the head
        // with `revisionHashOf` unchanged), which must not read as "someone else
        // saved" (grade-code WBCD-9) — re-read and retry against the new raw.
        let expectedRaw = fresh.raw;
        for (let attempt = 0; ; attempt += 1) {
          if (await registerWorkflowIfUnchanged(defToPersist, expectedRaw)) break;
          const now = await readRegisteredWorkflowFresh(def.workflowId);
          const nowRevision = now.def ? revisionHashOf(now.def) : undefined;
          if (nowRevision !== expectedRevision || attempt >= 2) throw headMovedConflict(res, def.workflowId, nowRevision);
          expectedRaw = now.raw;
        }
      } else {
        await registerWorkflowDurable(defToPersist);
      }
      // ADR 0474 — append the content revision beside ownership (history).
      // MUST be `defToPersist`: the revision store is content-addressed, so
      // recording the pre-merge `def` would hash content that was never the
      // head — and rollback would then offer a revision that restores the very
      // strip this guard just undid.
      await recordRevision(tenantOf(req), defToPersist, {
        ...(req.userId ? { createdBy: req.userId } : {}),
        // ADR 0524 Phase E — stamp WHAT THE WRITER DECLARED, so a later repair
        // can tell a head an old bundle stripped from one a user deliberately
        // cleared. Only the SAVE lane records it: rollback (:724) restores a
        // historical definition and must not inherit the restorer's contract as
        // if the original author had declared it.
        ...(declaredContract ? { declaredFields: [...declaredContract] } : {}),
      });
      // ADR 0163 R3: record tenant ownership so the scoped list reflects it.
      const name = typeof def.metadata?.name === 'string' ? def.metadata.name : undefined;
      const lc = lifecycleOf(def);
      await recordOwnership(tenantOf(req), defToPersist.workflowId, {
        name, nodeCount: defToPersist.nodes.length,
        ...(lc.transient !== undefined ? { transient: lc.transient } : {}),
        ...(lc.archivedAt !== undefined ? { archivedAt: lc.archivedAt } : {}),
      });
      // ADR 0789 — a fork whose re-point hooks failed retries them on each save.
      const repointFailed = await retryPendingRepoints(tenantOf(req), defToPersist.workflowId);
      const revision = revisionHashOf(defToPersist);
      res.setHeader('ETag', `"${revision}"`);
      res.status(201).json({
        workflowId: def.workflowId,
        ...(repointFailed.length > 0 ? { repointFailed } : {}),
        nodeCount: def.nodes.length,
        // ADR 0770 D5 — the head as PERSISTED (post-merge), the next `If-Match`.
        revision,
        // Present ONLY when this save dropped nodes that a run had recorded, so
        // the builder can surface a non-blocking notice. Absent = nothing to say.
        ...(removedReferencedNodeIds.length > 0 ? { removedReferencedNodeIds } : {}),
        // ADR 0524 — owner-gated like the disclosure above (`previous` is null
        // for a non-owner, so this is structurally empty for them).
        ...(preservation.preserved.length > 0 ? { preservedFields: preservation.preserved } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/host/openwop-app/workflows/:workflowId', async (req, res, next) => {
    try {
      const id = req.params.workflowId;
      if (!WORKFLOW_ID_PATTERN.test(id)) {
        throw new OpenwopError('validation_error', 'Invalid workflowId.', 400, { workflowId: id });
      }
      await requireWorkflowWrite(req); // ADR 0770 D1
      // ADR 0163 R2 (IDOR guard): only the owning tenant may delete; a foreign or
      // unknown id is an indistinguishable 404 (no existence leak).
      const owned = await getOwned(tenantOf(req), id);
      if (!owned) {
        throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: id });
      }
      // ADR 0913 — the delete recipe lives in ONE host function, shared with the
      // feature erasure seam (`eraseWorkflowSubject`), so the two cannot drift.
      const outcome = await deleteTenantWorkflow(deps.storage, tenantOf(req), id);
      if (!outcome.deleted) {
        const r = outcome.reason;
        if (r === 'not_owned') throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: id });
        const message = r === 'workflow_referenced' ? 'This workflow has runs that replay against it; archive it instead of deleting.'
          : r === 'workflow_scheduled' ? 'A schedule fires against this workflow; delete the schedule (or archive the workflow) first.'
            : 'This workflow is in a live collaboration session; delete it after everyone leaves.';
        throw new OpenwopError('conflict', message, 409, { workflowId: id, reason: r });
      }
      res.json({ workflowId: id, removed: outcome.removed });
    } catch (err) {
      next(err);
    }
  });

  // ── ADR 0369 lifecycle verbs — archive / unarchive / promote ──────────────
  // Same IDOR posture as DELETE: only the owning tenant; foreign/unknown ids
  // are an indistinguishable 404. Each verb patches definition.metadata.
  // lifecycle (the source of truth), re-registers (write-through to durable),
  // and refreshes the denormalized ownership flags the scoped list renders.
  const lifecycleVerb = (
    verb: 'archive' | 'unarchive' | 'promote',
  ): ((req: Parameters<Parameters<Express['post']>[1]>[0], res: Parameters<Parameters<Express['post']>[1]>[1], next: Parameters<Parameters<Express['post']>[1]>[2]) => void) => (req, res, next) => {
    void (async () => {
      try {
        const id = req.params.workflowId ?? '';
        if (!WORKFLOW_ID_PATTERN.test(id)) {
          throw new OpenwopError('validation_error', 'Invalid workflowId.', 400, { workflowId: id });
        }
        await requireWorkflowWrite(req); // ADR 0770 D1
        const tenantId = tenantOf(req);
        const owned = await getOwned(tenantId, id);
        const def = owned ? await getRegisteredWorkflowAsync(id) : null;
        if (!owned || !def) throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: id });

        // ADR 0481 — lifecycle verbs re-register the head; a live room owns it.
        if (await workflowRoomLive(id)) {
          throw new OpenwopError('conflict', 'This workflow is in a live collaboration session; lifecycle changes wait until everyone leaves.', 409, { workflowId: id, reason: 'workflow_room_live' });
        }

        // ADR 0789 — on a SHARED definition this tenant's lifecycle lives on its
        // ownership row, never on the shared def: start from THAT view, or a
        // promote would read the shared def's (unarchived) state and silently
        // un-archive this tenant's copy.
        let patched = isSharedWorkflowId(id) ? withLifecycle(def, { archivedAt: owned.archivedAt }) : def;
        if (verb === 'archive') {
          patched = withLifecycle(def, { archivedAt: new Date().toISOString() });
        } else if (verb === 'unarchive') {
          patched = withLifecycle(def, { archivedAt: undefined });
        } else {
          // promote: transient → saved, AND (grade-ux #1) re-publish for an
          // already-promoted workflow whose head moved past its published pin.
          // ADR 0474 made publish=pin; without a re-publish verb the only cure
          // for `publishedBehindHead` was rollback — "fixes can't reach
          // production". Same gates either way; a non-transient promote only
          // re-stamps `publishedRevision` (no lifecycle change).
          //
          // Gated on a SUCCESSFUL review run (David's OQ5 decision) — like the
          // delete guard's probe, but a DEBUG subgraph run must not satisfy it
          // (grade-code M4: a one-node 'only'-mode debug run executes a pruned
          // subgraph — it is not a test of the draft). Eval runs still count:
          // a completed eval case is a full fresh run of the definition, and
          // eval QUALITY is the separate evals_failing gate below. Probe the
          // index first, then require a completed run without debug provenance
          // among the tenant's recent runs.
          if (!(await deps.storage.hasRunForWorkflow(id, { status: 'completed' }))) {
            throw new OpenwopError('conflict', 'Run the draft successfully once before saving it.', 409, { workflowId: id, reason: 'workflow_untested' });
          }
          {
            // ADR 0770 D7 (`WBWF-10`) — filter by workflow AT THE SOURCE. This read
            // the tenant's newest 1000 completed runs of ANY workflow and filtered
            // here, so on a busy tenant a green review run older than the 1000th
            // was invisible and promote refused `workflow_untested`.
            const recent = await deps.storage.listRuns({ tenantId, workflowId: id, status: 'completed', limit: 200 });
            const production = recent.some((r) => {
              if (r.workflowId !== id) return false;
              const m = (r.metadata ?? {}) as Record<string, unknown>;
              return m.debug === undefined;
            });
            if (!production) {
              throw new OpenwopError('conflict', 'Run the draft successfully once before saving it (debug runs don’t count).', 409, { workflowId: id, reason: 'workflow_untested' });
            }
          }
          // ADR 0477 §4 — the evals-green gate: every set opted into
          // requiredForPromote must have a COMPLETE latest result with zero
          // failed cases, evaluated against THIS head (stale ≠ green — edits
          // after a green result honestly re-arm the gate). No opt-in ⇒ the
          // gate is exactly the green-run gate above.
          {
            const gateSets = (await listEvalSets(tenantOf(req), id)).filter((es) => es.requiredForPromote);
            if (gateSets.length > 0) {
              const headHash = revisionHashOf(def);
              const failing: string[] = [];
              for (const es of gateSets) {
                const latest = (await listEvalResults(tenantOf(req), id, es.evalSetId))[0];
                const green = latest
                  && latest.status === 'complete'
                  && latest.revisionHash === headHash
                  && latest.cases.every((c) => c.status === 'passed');
                if (!green) failing.push(es.name);
              }
              if (failing.length > 0) {
                throw new OpenwopError(
                  'conflict',
                  `Required eval set(s) are not green for the current draft: ${failing.join(', ')}. Run them (and pass) before saving.`,
                  409,
                  { workflowId: id, reason: 'evals_failing', evalSets: failing },
                );
              }
            }
          }
          // A transient draft graduates; an already-saved workflow keeps its
          // lifecycle untouched — this call is then a pure re-publish.
          // From `patched`, not `def` (ADR 0789): on a shared id `patched` already
          // carries this tenant's archive state from its ownership row.
          patched = lifecycleOf(patched).transient ? withLifecycle(patched, { transient: undefined }) : patched;
        }
        // ADR 0789 — a SHARED definition's lifecycle is every seeded tenant's.
        // Archive/unarchive/promote on one is this tenant's view only: the
        // ownership row (which the scoped list, the builder and the `/` picker
        // render from) carries it, and the shared row is never re-registered.
        const sharedDef = isSharedWorkflowId(id);
        if (!sharedDef) await registerWorkflowDurable(patched); // ADR 0770 D2
        const lc = lifecycleOf(patched);
        const name = typeof patched.metadata?.name === 'string' ? patched.metadata.name : undefined;
        await recordOwnership(tenantId, id, {
          ...(name !== undefined ? { name } : {}),
          nodeCount: patched.nodes.length,
          ...(lc.transient !== undefined ? { transient: lc.transient } : { transient: undefined }),
          ...(lc.archivedAt !== undefined ? { archivedAt: lc.archivedAt } : { archivedAt: undefined }),
          // ADR 0474 — publish = pin: promote records the head's content
          // revision (lifecycle-stripped hash) as the published one.
          ...(verb === 'promote' ? { publishedRevision: revisionHashOf(patched) } : {}),
        });
        res.json({ workflowId: id, lifecycle: lc, ...(verb === 'promote' ? { publishedRevision: revisionHashOf(patched) } : {}) });
      } catch (err) { next(err); }
    })();
  };
  app.post('/host/openwop-app/workflows/:workflowId/archive', lifecycleVerb('archive'));
  app.post('/host/openwop-app/workflows/:workflowId/unarchive', lifecycleVerb('unarchive'));
  app.post('/host/openwop-app/workflows/:workflowId/promote', lifecycleVerb('promote'));

  // ADR 0476 §2 — fleet insights: ONE bounded aggregation over the caller's
  // tenant's run rows (no per-workflow N+1, no durable read-model). The
  // response DISCLOSES the window; the FE labels stats with it.
  app.get('/host/openwop-app/workflows/stats', async (req, res, next) => {
    try {
      res.json(await aggregateFleetStats(deps.storage, tenantOf(req)));
    } catch (err) { next(err); }
  });

  // ADR 0870 §Stopgap — demo-node availability for a portfolio's workflow ids.
  // `?ids=a,b,c` (comma-separated; WORKFLOW_ID_PATTERN has no comma). Each id
  // is read through the SAME catalog + tenant predicate as `GET /workflows/{id}`,
  // so this reveals nothing that read does not. Malformed ids answer
  // `known:false` rather than 400 — a stale portfolio row must not blank a page.
  app.get('/host/openwop-app/workflows/availability', async (req, res, next) => {
    try {
      const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
      const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      const tenantId = tenantOf(req);
      const availability = await assessWorkflowAvailability(ids, {
        readDefinition: async (workflowId) => {
          if (!WORKFLOW_ID_PATTERN.test(workflowId)) return null;
          // The predicate runs whether or not the catalog hits, so a foreign id
          // and an unknown one cost the same reads (as resolveTenantWorkflow).
          const foreign = await isForeignOwned(tenantId, req.principal, workflowId);
          const wf = await deps.hostSuite.workflowCatalog.getWorkflow(workflowId);
          if (!wf || foreign) return null;
          return wf.definition as WorkflowDefinition;
        },
        isResolvable: (typeId) => getNodeRegistry().isResolvable(typeId),
      });
      res.json({ availability });
    } catch (err) { next(err); }
  });

  // ADR 0476 §3 — pre-run cost estimate (owner-gated 404 posture): the
  // workflow's HISTORICAL run costs (terminal stamps in the stats window) +
  // a STATIC order-of-magnitude floor from the head's AI-node composition.
  app.get('/host/openwop-app/workflows/:workflowId/estimate', async (req, res, next) => {
    try {
      const id = req.params.workflowId ?? '';
      const owned = id ? await getOwned(tenantOf(req), id) : null;
      const def = owned ? await getRegisteredWorkflowAsync(id) : null;
      if (!owned || !def) throw new OpenwopError('workflow_not_found', 'Workflow not found in this catalog.', 404, { workflowId: id });
      res.json(await estimateWorkflowCost(deps.storage, tenantOf(req), id, def));
    } catch (err) { next(err); }
  });

  // ADR 0770 D5 — the head's revision hash, read FRESH from storage (the
  // revisions list's `isHead` is unreliable: `recordRevision` swallows its own
  // failures, so a head can lack a row). The builder's `If-Match` base.
  // Owner-gated, the same 404 posture as the revisions read.
  // Registered at the canonical `/host/openwop-app/…` root (ADR 0652).
  app.get('/host/openwop-app/workflows/:workflowId/head', async (req, res, next) => {
    try {
      const id = req.params.workflowId ?? '';
      if (!WORKFLOW_ID_PATTERN.test(id)) throw new OpenwopError('validation_error', 'Invalid workflowId.', 400, { workflowId: id });
      if (!(await getOwned(tenantOf(req), id))) throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: id });
      const { def } = await readRegisteredWorkflowFresh(id);
      if (!def) throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: id });
      const revision = revisionHashOf(def);
      res.setHeader('ETag', `"${revision}"`);
      // grade-code WBCD-1 — the definition and its revision come from ONE fresh
      // read. Loading the content from the cache-first by-id route and the base
      // from here let a stale canvas carry a current base, which the save
      // precondition then waved through.
      res.json({ workflowId: id, revision, definition: def });
    } catch (err) { next(err); }
  });

  // ADR 0474 — revision history (owner-gated; the lifecycle-verb IDOR posture:
  // foreign/unknown ids are an indistinguishable 404).
  app.get('/host/openwop-app/workflows/:workflowId/revisions', async (req, res, next) => {
    try {
      const id = req.params.workflowId ?? '';
      if (!WORKFLOW_ID_PATTERN.test(id)) throw new OpenwopError('validation_error', 'Invalid workflowId.', 400, { workflowId: id });
      const tenantId = tenantOf(req);
      const owned = await getOwned(tenantId, id);
      if (!owned) throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: id });
      const head = await getRegisteredWorkflowAsync(id);
      const headHash = head ? revisionHashOf(head) : undefined;
      // Review M5 — defense-in-depth against the (separately tracked) unguarded
      // overwrite: foreign-tenant rows never surface in the owner's history.
      //
      // REV-VIS-1 — plus HOST-attributed rows. A seeded definition (`wf.seed.*`) is
      // a single GLOBAL `wfreg:` row every tenant runs, but `seedWorkflows` records
      // its revision only on FIRST seed, so every later tenant saw an EMPTY drawer —
      // which reads as "this workflow has no history" when the truth is "its history
      // is host-owned". ADR 0507's migration made that uniform by recording as
      // `'host'`, so without this the drawer is honest for nobody.
      //
      // Safe because `'host'` is UNFORGEABLE by a tenant: all `recordRevision` call
      // sites pass a resolved scope value (`tenantOf(req)`, `scope.tenantId`, …) and
      // none takes it from request input; the only literal is the host-level seeder.
      // The tenant fold rewrites `tenantId` on these rows (`planHostExtRekey`) but
      // only between two REAL tenant ids, never to the sentinel. Foreign-TENANT rows
      // are still excluded — that is the property M5 exists for and the one the
      // negative test pins.
      const rows = (await listRevisions(id))
        .filter((r) => revisionVisibleTo(tenantId, r))
        .slice(0, 100);
      // ADR 0773 G-03g — the author's DISPLAY name (tenant-scoped, fail-soft), so
      // the builder can say WHO changed a value a suggestion now conflicts with
      // instead of guessing. One lookup per distinct author, not per row.
      const authorNames = new Map<string, string | null>();
      for (const r of rows) {
        if (r.createdBy && !authorNames.has(r.createdBy)) authorNames.set(r.createdBy, await resolveCallerDisplayName(tenantId, r.createdBy));
      }
      res.json({
        items: rows.map((r) => ({
          revisionHash: r.revisionHash,
          createdAt: r.createdAt,
          ...(r.name !== undefined ? { name: r.name } : {}),
          nodeCount: r.nodeCount,
          ...(r.supersedes !== undefined ? { supersedes: r.supersedes } : {}),
          ...(r.createdBy !== undefined ? { createdBy: r.createdBy } : {}),
          ...(r.createdBy && authorNames.get(r.createdBy) ? { createdByName: authorNames.get(r.createdBy) } : {}),
          published: owned.publishedRevision === r.revisionHash,
          isHead: headHash === r.revisionHash,
        })),
      });
    } catch (err) { next(err); }
  });

  // ADR 0474 — the run-detail revision chip's read: which revision did this
  // run pin, and has the head moved since? Owner-gated via the shared
  // loadOwnedRun seam (404 posture for foreign/unknown runs).
  app.get('/host/openwop-app/runs/:runId/revision', async (req, res, next) => {
    try {
      const run = await loadOwnedRun(req, deps.storage, req.params.runId ?? '', 'runs:read');
      const meta = (run.metadata ?? {}) as Record<string, unknown>;
      const pinned = typeof meta.definitionRevision === 'string' ? meta.definitionRevision : undefined;
      const resolvedFrom = typeof meta.definitionResolvedFrom === 'string' ? meta.definitionResolvedFrom : undefined;
      let headMoved: boolean | undefined;
      if (pinned) {
        const head = await getRegisteredWorkflowAsync(run.workflowId);
        headMoved = head ? revisionHashOf(head) !== pinned : undefined;
      }
      // ADR 0475 — the same read doubles as the run PROVENANCE surface: the
      // launch/debug/redrive stamps the normative RunSnapshot deliberately
      // omits (run.metadata is host-internal). The FE debug session + the
      // runs-index redrive column read these.
      const launch = meta.launch === 'draft' ? 'draft' : undefined;
      const launchResolved = typeof meta.launchResolved === 'string' ? meta.launchResolved : undefined;
      const debug = meta.debug && typeof meta.debug === 'object' && !Array.isArray(meta.debug)
        ? (meta.debug as Record<string, unknown>) : undefined;
      const redriveOf = typeof meta.redriveOf === 'string' ? meta.redriveOf : undefined;
      res.json({
        runId: run.runId,
        workflowId: run.workflowId,
        ...(pinned ? { definitionRevision: pinned } : {}),
        ...(resolvedFrom ? { definitionResolvedFrom: resolvedFrom } : {}),
        ...(headMoved !== undefined ? { headMoved } : {}),
        ...(launch ? { launch } : {}),
        ...(launchResolved ? { launchResolved } : {}),
        ...(debug ? { debug } : {}),
        ...(redriveOf ? { redriveOf } : {}),
      });
    } catch (err) { next(err); }
  });

  // ADR 0474 — rollback: restore a prior revision AS THE NEW HEAD through the
  // SAME validated write discipline as the builder save (validate + disabled-
  // pack choke + owner write-guard via getOwned + removed-node disclosure +
  // recordRevision — history is append-only; the restored row re-heads by seq).
  app.post('/host/openwop-app/workflows/:workflowId/rollback', async (req, res, next) => {
    try {
      const id = req.params.workflowId ?? '';
      if (!WORKFLOW_ID_PATTERN.test(id)) throw new OpenwopError('validation_error', 'Invalid workflowId.', 400, { workflowId: id });
      const revisionHash = (req.body as { revisionHash?: unknown } | undefined)?.revisionHash;
      if (typeof revisionHash !== 'string' || revisionHash.length === 0) {
        throw new OpenwopError('validation_error', 'revisionHash is required.', 400, {});
      }
      await requireWorkflowWrite(req); // ADR 0770 D1
      const tenantId = tenantOf(req);
      const owned = await getOwned(tenantId, id);
      if (!owned) throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: id });
      // ADR 0481 — a live room owns the head; rollback waits.
      if (await workflowRoomLive(id)) {
        throw new OpenwopError('conflict', 'This workflow is in a live collaboration session; restore a version after everyone leaves.', 409, { workflowId: id, reason: 'workflow_room_live' });
      }
      const row = await getRevision(id, revisionHash);
      if (!row || row.tenantId !== tenantId) throw new OpenwopError('not_found', 'revision not found', 404, { workflowId: id });
      // Re-validate on the way back in — the registration contract may have
      // tightened since this content was first accepted.
      const validated = validateWorkflowDefinition(row.definition);
      await assertNoDisabledPacks(validated, tenantId);
      const current = await getRegisteredWorkflowAsync(id);
      // Review H2 — rollback restores CONTENT, never the snapshot's stale
      // lifecycle: a promoted workflow must not become a hidden transient (or
      // re-archived, GC-exposed) draft because its rev-1 snapshot predates the
      // promote. The CURRENT head's lifecycle carries over; since
      // revisionHashOf strips lifecycle, the appended revision still upserts
      // the same content row (no history noise).
      const currentLc = lifecycleOf(current ?? validated);
      const def = withLifecycle(validated, {
        transient: currentLc.transient,
        archivedAt: currentLc.archivedAt,
        generatedBy: currentLc.generatedBy,
      });
      const removedNodeIds = current ? current.nodes.map((n) => n.nodeId).filter((nid) => !def.nodes.some((n) => n.nodeId === nid)) : [];
      const removedReferencedNodeIds = removedNodeIds.length > 0
        ? await nodeIdsRecordedByRuns(deps.storage, tenantId, id, removedNodeIds)
        : [];
      // ADR 0789 — restoring a revision of a SHARED definition is a tenant write
      // like any save: it forks onto the caller's own id, never re-heads the
      // row every other seeded tenant runs.
      if (isSharedWorkflowId(id)) {
        // Restoring content identical to the shared head is not an edit: no fork.
        if (current && revisionHashOf(def) === revisionHashOf(current)) {
          res.json({ workflowId: id, restoredRevision: revisionHash, revision: revisionHashOf(current) });
          return;
        }
        const fork = await forkSharedWorkflow(tenantId, def, { ...(req.userId ? { createdBy: req.userId } : {}) });
        res.json({
          workflowId: fork.workflowId, forkedFrom: fork.forkedFrom, restoredRevision: revisionHash, revision: fork.revision,
          ...(fork.repointFailed.length > 0 ? { repointFailed: fork.repointFailed } : {}),
        });
        return;
      }
      await registerWorkflowDurable(def); // ADR 0770 D2
      await recordRevision(tenantId, def, { ...(req.userId ? { createdBy: req.userId } : {}) });
      const name = typeof def.metadata?.name === 'string' ? def.metadata.name : undefined;
      const lc = lifecycleOf(def);
      await recordOwnership(tenantId, id, {
        ...(name !== undefined ? { name } : {}),
        nodeCount: def.nodes.length,
        ...(lc.transient !== undefined ? { transient: lc.transient } : {}),
        ...(lc.archivedAt !== undefined ? { archivedAt: lc.archivedAt } : {}),
      });
      // ADR 0770 D5 — `revision` is the new head's hash: the builder adopts it as
      // its `If-Match` base, so the user's OWN rollback never 409s their next save.
      res.json({ workflowId: id, restoredRevision: revisionHash, revision: revisionHashOf(def), ...(removedReferencedNodeIds.length > 0 ? { removedReferencedNodeIds } : {}) });
    } catch (err) { next(err); }
  });


  // ── ADR 0163 Phase 2 — workflow-chain pack templates ("Use template") ──

  // Discovery: the installed workflow-chain packs (RFC 0013), host-global like the
  // node-catalog (authed, but not tenant data). Feeds the builder template gallery.
  app.get('/host/openwop-app/workflow-chains', (_req, res, next) => {
    try {
      // Day-1 UX P3 — per-chain requirements feed the template pre-flight
      // (uninstalled node types + named connection bindings). Host-global
      // derivation only; the caller's own connection status joins client-side.
      const catalog = buildNodeCatalog();
      const known = new Set(catalog.map((n) => n.typeId));
      // ADR 0766 D3 — a pin the installed version cannot honour is an install gap.
      const installedNode = new Map(catalog.map((n) => [n.typeId, n] as const));
      // RFC 0135 — composition-only chains (internal: true, e.g. an RFC 0133 sub-chain
      // child) MUST be omitted from the default template listing. They stay loadable,
      // resolvable, composable, and from-chain-instantiable by id (presentational only).
      const chains = listChains().filter(({ chain }) => chain.internal !== true).map(({ packName, chain, category }) => ({
        chainId: chain.chainId,
        packName,
        label: chain.label,
        description: chain.description,
        parameters: chain.parameters,
        requirements: chainRequirements(
          chain,
          known,
          (id) => getProvider(id) != null,
          // Toggle-GATED features only: getToggleDefault returns null for
          // always-on surfaces (e.g. kb), which then drop out of requiredFeatures.
          (id) => { const def = getToggleDefault(id); return def ? { label: def.label ?? id } : null; },
          (typeId) => installedNode.get(typeId),
        ),
        ...(category ? { category } : {}),
        ...(chain.capabilities ? { capabilities: chain.capabilities } : {}),
        ...(chain.outputs ? { outputs: chain.outputs } : {}),
      }));
      res.json({ chains });
    } catch (err) {
      next(err instanceof OpenwopError ? err : new OpenwopError('internal_error', String(err), 500));
    }
  });

  // Instantiate a chain as a REAL, owned, editable workflow ("Use template").
  // Expands (RFC 0013, ADR 0152) → mints a FRESH unique workflowId per instance
  // (R2; not the deterministic chainId:expansionId) → registers + records tenant
  // ownership. Unresolved node typeIds are returned as `warnings` (install/connect
  // prompts) — NOT a hard failure (ADR 0163 R6: invitation, not breakage).
  app.post('/host/openwop-app/workflows/from-chain', async (req, res, next) => {
    try {
      await requireWorkflowWrite(req); // ADR 0770 D1
      const body = (req.body ?? {}) as { chainId?: unknown; params?: unknown; deferred?: unknown; subject?: unknown };
      if (typeof body.chainId !== 'string') {
        throw new OpenwopError('validation_error', 'chainId is required.', 400, {});
      }
      // ADR 0913 — an optional feature-owned label the caller can later erase by.
      if (body.subject !== undefined && (typeof body.subject !== 'string' || !WORKFLOW_SUBJECT_PATTERN.test(body.subject))) {
        throw new OpenwopError('validation_error', 'subject must look like `<feature>:<id>` (lowercase feature prefix, then up to 200 of [A-Za-z0-9:._-]).', 400, { field: 'subject' });
      }
      const subject = typeof body.subject === 'string' ? body.subject : undefined;
      const found = getChain(body.chainId);
      if (!found) {
        throw new OpenwopError('not_found', 'workflow chain not found', 404, { chainId: body.chainId });
      }
      const params = (body.params ?? {}) as Record<string, unknown>;
      // RFC 0013 Path A (default): supplied params are FROZEN into the expanded
      // definition — the persisted workflow carries no `{{params.*}}` tokens, so it
      // is portable to any conformant host. Re-parameterize by re-POSTing with new
      // params; `metadata.expandedFrom` records what this one was frozen from.
      //
      // RFC 0124 deferred mode (`deferred: true`): params are materialized as
      // run-overridable `variables[]` (+ a `configurableSchema` bare-param alias)
      // and whole-value input tokens become variable-sourced PortValues — one owned
      // workflow re-runnable with different values per run, still token-free/portable.
      // A `x-openwop-sensitive` param is fail-closed unless deferred (SR-1 at-rest).
      const deferred = body.deferred === true;
      // RFC 0133 §1 — a chain composing sub-chains co-expands + co-REGISTERS each
      // child as its own owned workflow (children first, so the parent's rewritten
      // config.workflowId resolves) and rewrites config.subChainRef → the minted
      // child id. `OPENWOP_CHAIN_SUBCHAINS=0` flips off runtime child dispatch so the
      // conformance `chain.subchain.unsupported-refused` scenario is witnessable.
      let expanded;
      let coRegisteredChildIds: string[] = [];
      // ADR 0770 D3 — STAGE, CHECK, then COMMIT. `coRegisterSubChains` keeps its
      // deps interface, but `register`/`own` now only COLLECT: nothing is written
      // until the parent and every child have expanded and passed the disabled-
      // pack gate. Before, children were registered + owned first and the gate
      // ran after (children never at all), so a refusal left owned orphans in
      // `/builder` and the `/` picker.
      const staged: Array<{ def: WorkflowDefinition; name: string }> = [];
      if (found.chain.subChains?.length) {
        try {
          // §Correction (grade-code MEDIUM-3 / grade-ux TPI-15 / grade-data DOC-1):
          // this comment used to claim the route ENFORCES required params and
          // refuses with `chain_missing_required_param`. It does NOT — that
          // enforcement was reverted in the same commit because it broke "Use
          // template = just copy", and the error code exists nowhere in the
          // codebase. Both branches are permissive by design; the config check
          // below is a REPORT only. Left corrected rather than deleted so the
          // next reader knows the honesty gap is still open, not half-closed.
          const result = await coRegisterSubChains(found.chain, { params, deferred, tenantId: tenantOf(req), requiredConfigKeysFor }, {
            register: (childDef) => {
              if (!staged.some((st) => st.def.workflowId === childDef.workflowId)) staged.push({ def: childDef, name: childDef.workflowId });
            },
            own: async (wid, nm) => {
              const st = staged.find((x) => x.def.workflowId === wid);
              if (st) st.name = nm;
            },
            supported: process.env.OPENWOP_CHAIN_SUBCHAINS !== '0',
          });
          expanded = result.definition;
          coRegisteredChildIds = result.registeredChildIds;
        } catch (err) {
          if (err instanceof SubChainError) {
            const status = err.code === 'sub_chain_unsupported' ? 422 : 400;
            throw new OpenwopError('validation_error', err.message, status, { code: err.code });
          }
          throw err;
        }
      } else {
        // §Correction (code-review HIGH #1) — the config REPORT must cover this
        // branch: 167 of 169 shipped chains have no sub-chains, including
        // `exec-ops.daily-briefing` (the incident chain), so wiring it only to
        // the sub-chain branch left the check unreachable for the case that
        // motivated it.
        //
        // Required-param ENFORCEMENT is deliberately NOT applied here. It was,
        // briefly, and it broke a documented product contract: "Use template =
        // just copy — copies without a form" (this route's own test) and the
        // preflight modal's "Confirm never blocks on blanks". A template must be
        // copyable with blanks and completed in the builder. The incident is
        // fixed by the AI nodes carrying real defaults, not by refusing the copy.
        expanded = expandChain(found.chain, { params, deferred, requiredConfigKeysFor });
      }
      // R2 — a fresh owned instance id (the published chain id is not the instance id).
      const workflowId = await mintUnique(() => copyWorkflowId(found.chain.chainId), async (id) => Boolean(await getRegisteredWorkflowAsync(id)));
      // Preserve the template's name; on a collision with an existing owned
      // workflow append -2/-3/… (never the raw workflowId). Stamp the resolved
      // name on BOTH the definition (builder canvas) and the ownership record
      // (dashboard list) so the two surfaces never disagree.
      const baseName = (typeof expanded.metadata?.name === 'string' && expanded.metadata.name.trim())
        ? expanded.metadata.name : found.chain.label;
      const name = await uniqueOwnedName(tenantOf(req), baseName);
      const def = { ...expanded, workflowId, metadata: { ...expanded.metadata, name } };
      // ADR 0194 P3 — the POST choke, now over the parent AND every child, and
      // BEFORE anything is written (ADR 0770 D3, `WBWF-7`/`WBWF-8`).
      for (const d of [...staged.map((st) => st.def), def]) await assertNoDisabledPacks(d, tenantOf(req));
      // Children first (depth-first staging order), so the parent's rewritten
      // `config.workflowId` always resolves.
      const reusedChildIds: string[] = [];
      for (const st of staged) {
        const outcome = await commitSubChainChild(tenantOf(req), st.def, st.name);
        if (outcome === 'reused') reusedChildIds.push(st.def.workflowId);
      }
      await registerWorkflowDurable(def); // ADR 0770 D2
      // ADR 0474 — the instantiation IS the first revision.
      await recordRevision(tenantOf(req), def, { ...(req.userId ? { createdBy: req.userId } : {}) });
      const lc2 = lifecycleOf(def);
      await recordOwnership(tenantOf(req), workflowId, {
        name, nodeCount: def.nodes.length,
        ...(lc2.transient !== undefined ? { transient: lc2.transient } : {}),
        ...(lc2.archivedAt !== undefined ? { archivedAt: lc2.archivedAt } : {}),
        // ADR 0913 — the parent only. Sub-chain children are shared across
        // instantiations (their id keys on the chain version), so labelling one
        // would let one subject's erasure delete another's child.
        ...(subject ? { subject } : {}),
      });
      // R6 — surface node types not installed on this host (best-effort heads-up).
      const catalog = buildNodeCatalog();
      const known = new Set(catalog.map((n) => n.typeId));
      const installedNode = new Map(catalog.map((n) => [n.typeId, n] as const));
      // ADR 0766 D3 — installed, but not at the version the chain pinned. Kept
      // out of `warnings` (grade-ux U-2): that list means "not installed", and
      // the client renders it as such — a mismatch needs both versions named.
      const pinGaps = pinMismatches(found.chain.nodePins, (typeId) => installedNode.get(typeId)?.version)
        .map((m) => ({ ...m, label: installedNode.get(m.typeId)?.label ?? m.typeId }));
      const warnings = [...new Set(def.nodes.map((n) => n.typeId).filter((t) => !known.has(t)))];
      // §Correction (grade-ux TPI-3) — TELL THE CLIENT WHAT IS STILL MISSING.
      // The host already computed this and only `log.warn`ed it, so a template
      // copied with blanks landed in the builder looking complete: no badge, no
      // banner, an enabled Run button. "Just copy" is the right behaviour; going
      // silent about the consequence is not. Same shape as `warnings` above, so
      // no wire change beyond an additive field.
      const incompleteNodes = findMissingRequiredConfig(def.nodes, requiredConfigKeysFor, found.chain.chainId)
        .map((f) => ({ nodeId: f.nodeId, typeId: f.typeId, missing: f.missing }));
      // ADR 0504 — the template params that never froze. `incompleteNodes` above
      // CANNOT see these: an absent param resolves to `undefined` and the key is
      // dropped from the minted node, so the missing-config check inspects a node
      // that looks like it was simply authored that way. Verified live on
      // 2026-07-29 — an instantiation whose search node had no `query` returned
      // `incompleteNodes` empty and every run of it then failed naming an
      // internal node. Additive field, same "tell the client" intent.
      const unfilledParams = [...new Set(findUnfilledExpansionParams(def).map((u) => u.param))].sort();
      res.status(201).json({
        workflowId,
        nodeCount: def.nodes.length,
        ...(coRegisteredChildIds.length ? { subChainWorkflowIds: coRegisteredChildIds } : {}),
        // ADR 0770 D3 — children this tenant had EDITED, bound as-is (not rebuilt).
        ...(reusedChildIds.length ? { reusedSubChainWorkflowIds: reusedChildIds } : {}),
        ...(warnings.length ? { warnings } : {}),
        ...(pinGaps.length ? { pinMismatches: pinGaps } : {}),
        ...(incompleteNodes.length ? { incompleteNodes } : {}),
        ...(unfilledParams.length ? { unfilledParams } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // Install a workflow-chain pack from the registry (packs.openwop.dev) AT RUNTIME
  // — the in-app marketplace (ADR 0163 follow-on). Reuses the same Ed25519 + SHA-256
  // SRI-verified installer the boot path uses (ADR 0163 Phase 7), then HOT-RELOADS
  // the chain registry so the pack's chains appear as templates with no restart.
  //
  // Superadmin-gated: installing a pack mutates GLOBAL host state (the shared chain
  // registry across all tenants), so it is an operator action — the same gate as
  // feature-toggle/governance administration, NOT a per-tenant write. Scoped to
  // `kind:"workflow-chain"` packs (the loader kind-filters; node/agent runtime
  // install needs a catalog rebuild and stays deferred).
  app.post('/host/openwop-app/workflow-chain-packs/install', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Installing workflow packs');
      const body = (req.body ?? {}) as { name?: unknown; version?: unknown };
      // ADR 0660 D4 → ADR 0826 D4 — this lane once had none of its siblings'
      // hardening; it now shares their ONE install lane (path-safe name, SemVer,
      // tombstone, revoked version, configured registry + keys) and its error
      // mapping, so no raw installer message — registry URL included — reaches
      // the client (`MKT2-29`).
      const target = assertInstallable({ name: body.name, version: body.version });
      const before = new Set(listChains().map((c) => c.chain.chainId));
      const result = await installFromConfiguredRegistry(target);
      // Hot-reload so a just-installed (or already-present) chain pack is listable
      // without restart; report the chainIds this install made newly available.
      const { errors } = reloadWorkflowChainPacks();
      // CBW-1 — re-sweep the host-default sub-chain binds after a runtime reload
      // (the boot sweep alone would miss a dangling bind an install introduces or
      // cures; error-logged per bind, never a request failure).
      validateChainBackedSubChainBinds();
      const newChains = listChains().map((c) => c.chain.chainId).filter((id) => !before.has(id));
      res.status(result.installed ? 201 : 200).json({
        installed: result.installed,
        ...(result.reason ? { reason: result.reason } : {}),
        newChains,
        ...(errors.length ? { loadWarnings: errors } : {}),
      });
    } catch (err) {
      next(err);
    }
  });
}
