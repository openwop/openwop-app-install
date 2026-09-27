/**
 * KB workflow surface (ADR 0014 Phase 1) — the reference `ctx.features.kb` that
 * a workflow node calls. A THIN adapter over `kbService` (the single source of
 * truth shared with the REST face); it adds no domain logic. Tenant comes from
 * the run scope; `orgId`/`collectionId` are node-supplied and the SERVICE
 * enforces the tenant+org key (CTI-1) — a cross-tenant id is simply not found.
 * Intended to be called from `role:action` pack nodes (Phase 2), whose outputs
 * are recorded → replay/fork-safe.
 */

import { OpenwopError } from '../../types.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { HostEventOrigin } from '../../host/hostEventDispatcher.js';
import { PREAUTHORIZED_CALLER, type SubjectCaller } from '../../host/subjectAccess.js';
import { surfaceStr as str, surfaceOptCount, type FeatureSurface } from '../../host/featureSurfaces.js';
import {
  drainReindex, getCollection, getReindexJob, kbReindexSliceChunks, kbReindexWorkflowId,
  listCollections, ragQuery, resolveRetrievalMode, search,
  tenantRetrieve, type RetrievalMode,
} from './kbService.js';

export function buildKbSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  /**
   * KBC-1 (ADR 0643 D2 precondition) — WHO this run is retrieving as.
   *
   * `scope.actingUserId` is the run owner's durable principal, and it is ABSENT
   * for a system run (schedule-fired, inbound webhook) BY CONSTRUCTION — the
   * field's own contract calls that "the correct fail-closed signal". This
   * surface takes it at its word: an unauthenticated run reads every ordinary
   * org collection exactly as before, and reads NOTHING that is bound to a
   * membership-scoped Subject, because it has no membership to resolve. A
   * project's private corpus is not org data, and a run with no human behind it
   * cannot be a member of that project.
   *
   * The gate itself is in `kbService` (the single composition owner), not here —
   * so these four verbs inherit it rather than each re-implementing it, and so
   * do `ctx.knowledge`, the REST doors and any surface added later.
   */
  const caller: SubjectCaller = { ...(scope.actingUserId ? { subject: scope.actingUserId } : {}) };
  // ADR 0617 D1a / ADR 0643 D3 — the run's origin rides every lifecycle event this
  // surface causes, so a binding on the emitting run's own workflow is skipped.
  const origin: HostEventOrigin = {
    ...(scope.runId ? { runId: scope.runId } : {}),
    ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
    ...(scope.chainId ? { chainId: scope.chainId } : {}),
  };
  return {
    /** Search within one collection — honors the collection's configured retrieval
     *  mode (ADR 0113), so a workflow's kb.search inherits hybrid/rerank like every
     *  other consumer; an explicit `mode` arg overrides per-call. */
    search: async (args) => {
      const orgId = str(args.orgId);
      const collectionId = str(args.collectionId);
      const override: RetrievalMode | undefined =
        args.mode === 'dense' || args.mode === 'hybrid' || args.mode === 'hybrid+rerank' ? args.mode : undefined;
      const col = await getCollection(tenantId, orgId, collectionId, caller);
      const mode = override ?? (col ? resolveRetrievalMode(col) : 'dense');
      const results = await search(tenantId, orgId, collectionId, args.query, args.topK, mode, caller);
      return { results };
    },
    /** Retrieve → augmented prompt + citations (generation is the node's job). */
    rag: async (args) => {
      const r = await ragQuery(tenantId, str(args.orgId), str(args.collectionId), args.query, args.topK,
        typeof args.minScore === 'number' ? { minScore: args.minScore } : undefined, caller);
      // ADR 0351 P2 — coverage + embedding ride the surface so generation nodes
      // can gate (strict) and label (honesty) without a second retrieval path.
      return { query: r.query, contexts: r.contexts, citations: r.citations, augmentedPrompt: r.augmentedPrompt, coverage: r.coverage, embedding: r.embedding };
    },
    /** Tenant-wide retrieval across the tenant's collections (the host.knowledge
     *  shape); returns empty when the tenant has none. */
    retrieve: async (args) => {
      const res = await tenantRetrieve(tenantId, {
        query: str(args.query),
        ...(Array.isArray(args.collectionIds) ? { collectionIds: (args.collectionIds as unknown[]).map(str) } : {}),
        ...(typeof args.resultLimit === 'number' ? { resultLimit: args.resultLimit } : {}),
      }, caller);
      const r = res ?? { chunks: [], sources: [], latencyMs: 0, hasResults: false };
      return { chunks: r.chunks, sources: r.sources, latencyMs: r.latencyMs, hasResults: r.hasResults };
    },
    /** List the org's collections (read). */
    listCollections: async (args) => {
      return { collections: await listCollections(tenantId, str(args.orgId), caller) };
    },

    /**
     * ADR 0643 D2 — drive ONE bounded slice of an ALREADY-STARTED reindex.
     *
     * ── WHY THIS VERB'S AUTHORIZATION IS STRUCTURAL AND NOT A SHARED PREDICATE ──
     *
     * Everywhere else in this repo the rule is "one helper, route and tool both
     * call it". That rule cannot be applied here, and saying why is the whole
     * design. The REST door is `requireOrgScope(req, 'host:org:manage')` — the
     * highest gate in the feature, chosen because a reindex spends provider
     * budget and REWRITES a vector namespace. `requireOrgScope` needs a `req`,
     * and this verb's entire purpose is to be reachable from a SCHEDULE-FIRED
     * run, which has no request and no acting user at all. There is no principal
     * to hand the predicate. Sharing it is not "harder", it is impossible.
     *
     * What is left, if nothing replaces it, is the worst shape in the ADR: a
     * `side-effect` node any workflow author in the tenant could drop into any
     * chain. `drainReindex`'s terminal branch flips `activeSignature` and DELETES
     * the old namespace's vectors, so an arbitrary chain could force-complete or
     * race-cancel an administrator's rebuild — no exploit needed, just the node.
     *
     * So the authorization is two structural facts, BOTH required:
     *
     *   (a) a `running`/`paused` job already exists for this collection. Only
     *       `startReindex` creates one, and the only door to `startReindex` is
     *       the `host:org:manage` REST route. The admin gate is not shared — it
     *       is CONSUMED, and its residue (the job row) is what this verb checks.
     *   (b) the executing run's `workflowId` is the host-minted
     *       `kbReindexWorkflowId(tenantId, orgId, collectionId)`. Only
     *       `ensureKbReindexDriver` mints that id, only for a collection whose
     *       reindex was just started, and the id is tenant-qualified so it cannot
     *       be squatted from another tenant. A tenant chain the author registered
     *       has the author's own workflowId and fails here.
     *
     * (b) is checked FIRST, before any store read: an arbitrary chain must not be
     * able to use this verb's error to probe whether a collection is reindexing.
     *
     * Neither fact is "the caller is an admin" — that check has already happened,
     * once, at the door that could perform it. This verb only proves it is the
     * MECHANISM that check authorized.
     */
    reindexDrain: async (args) => {
      const orgId = str(args.orgId);
      const collectionId = str(args.collectionId);
      if (!orgId || !collectionId) {
        throw new OpenwopError('validation_error', '`orgId` and `collectionId` are required.', 400, { orgId, collectionId });
      }
      assertReindexWorkflow(scope, tenantId, orgId, collectionId, 'reindexDrain');
      // `PREAUTHORIZED_CALLER` (KBC-1): the two structural facts above ARE this
      // lane's authorization, and a schedule-fired run has no acting user to
      // resolve a project membership with. Without the marker the run's
      // fail-closed default would refuse every reindex of a project-bound
      // corpus — a gate with no exit, which is the defect this repo has paid for
      // before.
      const before = await getReindexJob(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER);
      if (!before || (before.status !== 'running' && before.status !== 'paused')) {
        throw new OpenwopError(
          'conflict',
          'No reindex is in progress for this collection — a reindex is started through the admin door, never by running this node.',
          409,
          { collectionId, reindexStatus: before?.status ?? '(none)' },
        );
      }
      const maxChunks = surfaceOptCount(args.maxChunks) ?? kbReindexSliceChunks();
      const job = await drainReindex(tenantId, orgId, collectionId, Math.min(4096, maxChunks), PREAUTHORIZED_CALLER, { origin });
      if (!job) {
        // The job vanished between the two reads (a concurrent cancel that also
        // GC'd it). A typed failure, never `success` over a missing outcome.
        throw new OpenwopError('conflict', 'The reindex job disappeared while draining it.', 409, { collectionId });
      }
      // Terminal ⇒ the per-collection workflow + scheduler job + ownership row
      // are already gone: `drainReindex` reaps them, so EVERY lane that can end a
      // reindex (this node, the SPA's interactive loop, the cancel button, D1a's
      // lease expiry) tears the driver down, not just this one.
      const done = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
      return {
        status: job.status,
        embeddedChunks: job.embeddedChunks,
        totalChunks: job.totalChunks,
        done,
        ...(job.error ? { error: job.error } : {}),
      };
    },

    /** ADR 0643 D2 — the reindex job's progress, for the same workflow that is
     *  draining it. Same structural gate as `reindexDrain` (minus the live-job
     *  requirement, since reading a TERMINAL status is exactly what a drain
     *  workflow needs to know it is finished). */
    reindexStatus: async (args) => {
      const orgId = str(args.orgId);
      const collectionId = str(args.collectionId);
      if (!orgId || !collectionId) {
        throw new OpenwopError('validation_error', '`orgId` and `collectionId` are required.', 400, { orgId, collectionId });
      }
      assertReindexWorkflow(scope, tenantId, orgId, collectionId, 'reindexStatus');
      const job = await getReindexJob(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER);
      return { job: job ?? null };
    },
  };
}

/**
 * ADR 0643 D2 — fact (b) of the structural gate, factored so the two verbs
 * cannot spell it differently. A refusal is a TYPED failure that names neither
 * the expected id nor whether the collection exists: an arbitrary chain learns
 * only that it is not the reindex workflow, which it already knew.
 */
function assertReindexWorkflow(scope: BundleScope, tenantId: string, orgId: string, collectionId: string, verb: string): void {
  const expected = kbReindexWorkflowId(tenantId, orgId, collectionId);
  // ADR 0643 R3 review (Should 4) — fact (c): NO acting user. A schedule fire has none by
  // construction (`BundleScope.actingUserId` is absent for a system run); a human-started
  // run ALWAYS carries one. Without this, any run-creating member who could see the
  // driver workflow could POST a run of it, and that run passed (a)+(b) and drained
  // PREAUTHORIZED. The definition is now also `transient` (hidden from the gallery and
  // the picker), but a hidden id is not a secret — this check is what makes the claim
  // "callable only from the workflow `startReindex` instantiated" true.
  if (scope.workflowId !== expected || scope.actingUserId) {
    throw new OpenwopError(
      'validation_error',
      `ctx.features.kb.${verb} is callable only from the host-minted reindex workflow for this collection — it is not a general-purpose verb. Start a reindex through the admin door; the host registers and drives the workflow itself.`,
      403,
      { collectionId, verb },
    );
  }
}
