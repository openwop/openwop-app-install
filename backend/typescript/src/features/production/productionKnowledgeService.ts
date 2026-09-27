/**
 * Vendor Directory → KB auto-indexer (ADR 0172 Phase 4).
 *
 * Mirrors each org's vendors into a managed 'Vendor Directory KB' collection so
 * the Production Planner agent (and any Board of Advisors) can RETRIEVE vendor
 * capability/pricing context (via the existing per-agent knowledge binding, ADR
 * 0038). A thin composition over `kbService` — the `strategyKnowledgeService` /
 * `priorityMatrixKnowledgeService` precedent — no new store, no new vector surface.
 *
 * Invariants (the strategy-KB pattern):
 *  - BEST-EFFORT / FAIL-OPEN: every entry point swallows + logs its own errors; a
 *    KB failure MUST NOT break vendor CRUD. A partial failure self-heals on the
 *    next mutation (upsert is keyed by the vendor's stable id).
 *  - GATED ON THE *INDEX* SIDE ONLY: indexing runs only when the `production`
 *    toggle is enabled (KB is always-on). REMOVAL is deliberately NOT gated —
 *    `strategyKnowledgeService.ts:153-164` calls out the same hazard: a toggle
 *    that is off (or flips off between index and delete) must never be able to
 *    strand a deleted entity's document in a collection agents still retrieve
 *    from. `KBC-5`(i) was exactly that. The reachable form is not "the toggle is
 *    globally off" — the DELETE route is itself toggle-gated, so it would 404 —
 *    it is the SUBJECT MISMATCH between the two resolutions: the route resolves
 *    with `toggleSubjectOf(req)` = `{tenantId, userId}` while `gateOpen` resolves
 *    `{tenantId}` alone, so under a CLOSED BETA (`status:'beta'` + a `betaCohort`
 *    naming the user) the route says ENABLED and this file says DISABLED for the
 *    same request. The vendor row went, and its capabilities, region, past-project
 *    names and free-text `notes` stayed searchable by anything bound to
 *    `mgd-production-<org>`. Pinned by `test/production-kb-lifecycle.test.ts`.
 *  - CONTENT = DESCRIPTIVE TEXT: the indexed doc is the vendor's synthesized
 *    capability/pricing description (content the org authored) — `contentTrust`
 *    left to the KB default. Portfolio-MEDIA byte extraction (OCR/transcription)
 *    rides the existing `ingestDocument(mediaToken)` path + the ADR 0108 pipeline
 *    and is a documented follow-on, not built here.
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 */

import { createLogger } from '../../observability/logger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createCollection, deleteDocument, getCollection, getDocument, listDocuments, upsertDocument } from '../kb/kbService.js';
import { kbMutated, type KbEmitOptions } from '../kb/emit.js'; // ADR 0643 D3 — silent per-row sweep + ONE batch event
import { getVendor, listVendors, type Vendor } from './productionService.js';

const log = createLogger('production-kb');

const MANAGED = 'production' as const;
const COLLECTION_NAME = 'Vendor Directory KB';
/** Deterministic per-org id ⇒ point-lookup resolution, no scan. */
const collectionIdFor = (orgId: string): string => `mgd-production-${orgId}`;
/** Stable per-vendor doc id ⇒ upsert is a deterministic delete+re-ingest. */
const docIdFor = (vendorId: string): string => `vendor:${vendorId}`;

async function gateOpen(tenantId: string): Promise<boolean> {
  const production = await resolveOne('production', { tenantId });
  return Boolean(production?.enabled);
}

/** Synthesize the searchable description indexed for a vendor.
 *  Raw price figures are NEVER indexed (ADR 0356 P6): KB retrieval carries no
 *  per-reader capability check, so `min`/`max` in the doc text would leak
 *  pricing to any agent binding regardless of the editors+ redaction rule.
 *  Index only WHICH capabilities have pricing on file — enough for retrieval
 *  ("who can quote video?"); the figures stay behind the gated vendor read. */
function vendorToText(v: Vendor): string {
  const caps = v.capabilities.map((c) => `${c.name} (${c.category}${c.qualityRating ? `, quality ${c.qualityRating}/5` : ''})`).join('; ');
  const prices = v.priceRanges.map((p) => `${p.capability} (${p.unit})`).join('; ');
  const past = v.pastProjects.map((p) => p.name).join('; ');
  return [
    `Vendor: ${v.name} (${v.type}, ${v.contractStatus})`,
    v.region ? `Region: ${v.region}` : '',
    caps ? `Capabilities: ${caps}` : '',
    prices ? `Pricing on file for: ${prices}` : '',
    past ? `Past projects: ${past}` : '',
    v.notes ? `Notes: ${v.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function getOrCreateCollection(tenantId: string, orgId: string, actor: string) {
  const id = collectionIdFor(orgId);
  const existing = await getCollection(tenantId, orgId, id);
  if (existing) return existing;
  return createCollection(tenantId, orgId, actor, { name: COLLECTION_NAME }, { collectionId: id, managed: MANAGED });
}

/** Index (or re-index) one vendor. Best-effort. */
export async function indexVendor(tenantId: string, orgId: string, actor: string, vendor: Vendor, emit: KbEmitOptions = {}): Promise<void> {
  try {
    if (!(await gateOpen(tenantId))) return;
    await getOrCreateCollection(tenantId, orgId, actor);
    await upsertDocument(tenantId, orgId, collectionIdFor(orgId), docIdFor(vendor.vendorId), actor, {
      title: vendor.name,
      text: vendorToText(vendor),
      ...emit, // ADR 0643 D3 — the backfill sweep passes `{ silent: true }`
    });
  } catch (err) {
    log.warn('production_kb_index_failed', { orgId, vendorId: vendor.vendorId, err: String(err) });
  }
}

/**
 * Remove a vendor's KB doc (on delete). Idempotent — a no-op when the collection
 * or the doc never existed, so it tolerates deleting a never-indexed vendor.
 *
 * `KBC-5`(i) / ADR 0643 D6 — NEVER gated on the `production` toggle. The old
 * `if (!(await gateOpen(tenantId))) return;` made a *retention* guarantee
 * conditional on a *feature* switch: with the toggle off the vendor row was
 * deleted and its KB mirror silently kept, retrievable again the moment the
 * toggle returned. Copied from `strategyKnowledgeService.removeStrategy`, which
 * documents the same refusal.
 *
 * Returns the OUTCOME rather than only swallowing it (the strategy shape):
 * `true` ⇒ the doc is provably absent; `false` ⇒ the attempt FAILED and a
 * document may still be sitting in the org's shared collection, so the caller
 * (and the operator reading the log) can act. Never throws — a KB failure must
 * not break vendor CRUD.
 */
export async function removeVendor(tenantId: string, orgId: string, vendorId: string): Promise<boolean> {
  try {
    const collectionId = collectionIdFor(orgId);
    if (!(await getCollection(tenantId, orgId, collectionId))) return true;
    if (!(await getDocument(tenantId, orgId, collectionId, docIdFor(vendorId)))) return true; // never indexed / already gone
    await deleteDocument(tenantId, orgId, collectionId, docIdFor(vendorId));
    return true;
  } catch (err) {
    log.warn('production_kb_remove_failed', { orgId, vendorId, err: String(err) });
    return false;
  }
}

/** Bound on ONE sweep pass. The sweep is synchronous inside the request and ADR 0643
 *  D6 singled it out as "the only sweep" — then it was wired to a plain route, so an
 *  org with a large managed collection would hold a request open for an unbounded
 *  walk. A pass that hits this cap does real work and reports `complete:false`; the
 *  operator re-runs. Deliberately NOT a background job: that would be a second
 *  scheduler, which the ADR's boundaries audit forbids. */
const MAX_SWEEP_DOCS = 1000;

export interface ProductionKbSweep {
  /** Live vendors (re-)indexed this pass. Zero when the index gate is closed. */
  vendors: number;
  /** `vendor:` docs with no backing vendor, deleted this pass. */
  removedOrphans: number;
  /** Docs examined by the orphan half. */
  scanned: number;
  /** Per-item failures that were logged and stepped over. */
  failures: number;
  /**
   * TRUE ⇒ the pass walked everything it intended to and the counts ARE the
   * on-demand drift signal. FALSE ⇒ they are NOT: the walk was cut short by the
   * `MAX_SWEEP_DOCS` cap or by a throw, so `removedOrphans: 0` means "did not
   * finish looking", not "nothing to fix". Reporting a partial sweep as a clean
   * one is a false all-clear on a retention surface, which is why this flag
   * exists and why the route surfaces it verbatim.
   */
  complete: boolean;
}

/**
 * Reconcile the org's vendors against the managed collection — BOTH directions,
 * the `backfillDocsKb` shape:
 *   - every live vendor is (re-)upserted (the content-hash guard makes an
 *     unchanged vendor free, so re-runs are cheap and idempotent);
 *   - every `vendor:`-keyed KB doc with no backing vendor is REMOVED.
 *
 * `KBC-5`(ii) / ADR 0643 D6 — this used to have zero callers (`git grep
 * backfillProductionKb` returned the definition line only), so the repair path
 * for a drifted mirror was reachable only by editing code. It is now driven by
 * `POST …/production/orgs/:orgId/reindex-kb`, matching the `strategy` and
 * `priority-matrix` siblings.
 *
 * ─── ORPHANHOOD IS DECIDED BY POINT READ, NEVER BY THE LISTING ───────────────
 * The first version built a live-id Set from `listVendors`, and that inverted the
 * polarity of a read authority documented as LOSSY. `listVendors` goes through
 * `vendors.listForTenantIndexed`, whose contract says "the worst case is a missing
 * marker (the row is simply not enumerated this pass — retention is delayed, not
 * lost)" (`hostExtPersistence.ts:261-266`). That guarantee is written for a
 * RETENTION consumer, where a miss costs a delay. Used as the liveness oracle for a
 * DELETE it means the opposite: a missing marker makes a LIVE vendor's KB document
 * look orphaned and destroys it — and re-running the repair cannot heal it, because
 * the same missing marker also excludes that vendor from the index half. So each
 * candidate is confirmed dead by `getVendor`, a point `get` on the PRIMARY store
 * (`productionService.ts:200-203`) that the secondary index cannot lose. The listing
 * is kept only for the index half, where a miss has its documented, benign polarity.
 *
 * ─── WHAT ACTUALLY PRODUCES AN ORPHAN (the contradiction this docblock used to
 * carry) ─────────────────────────────────────────────────────────────────────
 * This used to justify the orphan half with "a vendor deleted while the toggle was
 * off", which contradicts `removeVendor`'s own note that the globally-off case is
 * unreachable — the DELETE route is toggle-gated and would 404. `removeVendor` is
 * right; that phrasing was wrong. The three REAL sources are:
 *   (a) the pre-fix subject mismatch — the route resolved `{tenantId, userId}` and
 *       `gateOpen` resolved `{tenantId}`, so under a closed beta the delete landed
 *       and the mirror was kept (fixed here; historical rows remain);
 *   (b) a KB removal that FAILED — `removeVendor` returns `false` and the vendor row
 *       is already gone. Still live by design: CRUD must not break on a KB fault;
 *   (c) `clearDemoProduction` (`host/demoProductionSeed.ts:164`) calls `deleteVendor`
 *       DIRECTLY and never calls `removeVendor`, so demo teardown strands every
 *       mirrored demo vendor. Still live, and outside this feature's files — filed,
 *       not silently fixed here.
 *
 * Indexing stays toggle-gated (`indexVendor`); the orphan sweep does NOT, for the same
 * reason `removeVendor` does not — retention must not depend on a feature switch. Only
 * `vendor:`-prefixed ids are swept, so a doc some future lane adds is never collateral.
 */
export async function backfillProductionKb(tenantId: string, orgId: string, actor: string): Promise<ProductionKbSweep> {
  const out: ProductionKbSweep = { vendors: 0, removedOrphans: 0, scanned: 0, failures: 0, complete: true };
  try {
    if (await gateOpen(tenantId)) {
      const live = await listVendors(tenantId, orgId);
      // ADR 0643 D3 — a BULK lane: silent per row, ONE `document.ingested { count }`.
      for (const v of live) await indexVendor(tenantId, orgId, actor, v, { silent: true }); // self-catching
      out.vendors = live.length;
      if (live.length > 0) await kbMutated({ entity: 'document', verb: 'ingested', tenantId, orgId, collectionId: collectionIdFor(orgId), count: live.length });
    }
    const collectionId = collectionIdFor(orgId);
    // Sweep only an EXISTING collection — never create one just to find it empty.
    if (await getCollection(tenantId, orgId, collectionId)) {
      const docs = await listDocuments(tenantId, orgId, collectionId);
      if (docs.length > MAX_SWEEP_DOCS) out.complete = false; // truthful: we will not see them all
      for (const doc of docs.slice(0, MAX_SWEEP_DOCS)) {
        if (!doc.documentId.startsWith('vendor:')) continue;
        out.scanned++;
        try {
          // Point read on the primary store — the non-lossy oracle. Present ⇒ live.
          if (await getVendor(tenantId, orgId, doc.documentId.slice('vendor:'.length))) continue;
          await deleteDocument(tenantId, orgId, collectionId, doc.documentId, undefined, { silent: true }); // ADR 0643 D3 — bulk lane
          out.removedOrphans++;
        } catch (err) {
          // Step over one bad doc rather than abandoning the sweep — but the pass is
          // no longer a clean signal. `assertNoLiveReindex`'s 409 (a reindex running
          // for this collection, the very condition ADR 0643 D1 exists for) lands here.
          out.failures++;
          out.complete = false;
          log.warn('production_kb_sweep_doc_failed', { orgId, documentId: doc.documentId, err: String(err) });
        }
      }
    }
  } catch (err) {
    out.complete = false;
    log.warn('production_kb_backfill_failed', { orgId, err: String(err) });
  }
  return out;
}
