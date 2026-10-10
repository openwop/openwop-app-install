/**
 * Backend-backed workflow persistence for the builder dashboard (ADR 0163 Phase 3).
 *
 * Makes "Your workflows" REAL: the backend per-tenant ownership index
 * (`GET/POST/DELETE /host/openwop-app/workflows`, ADR 0163 Phase 1) is the
 * source of truth; localStorage demotes to a draft/offline cache.
 *
 * **Additive by design (architect review R-A):** the sync `localStore.ts` API is
 * left untouched — chat's `@workflow` mention picker + other consumers still read
 * it. This module is the new async backend path the dashboard + BuilderTab use;
 * every write is write-through (backend + local cache) and every read falls back
 * to the local cache when the backend is unavailable — so a user never loses work
 * (R-D). Migration COPIES localStorage → backend (never deletes; R-C).
 *
 * @see src/host/workflowOwnership.ts (the tenant-scoped backend index)
 */

import { assertSynced, authedHeaders, config, fetchOpts, isOfflineError } from '../../client/config.js';
import i18n from '../../i18n/index.js';
import { getWorkflowDefinitionRaw } from '../../client/workflowsClient.js';
import { listWorkflowSummaries } from '../../workflows/workflowsClient.js';
import { serializeWorkflow } from '../schema/serialize.js';
import { CanonicalParseError, fromCanonicalDefinition } from '../schema/deserialize.js';
import { loadDynamicCatalog } from '../palette/catalogRegistry.js';
import type { SavedWorkflow } from '../schema/workflow.js';
import { definitionMetadataFor, stripBuilderOwnedKeys } from './definitionMetadata.js';
import { fieldContractHeader } from './fieldContract.js';
import {
  listSavedWorkflows,
  getSavedWorkflow,
  upsertSavedWorkflow,
  deleteSavedWorkflow,
} from './localStore.js';

/** Dashboard list-card shape (the scoped backend summary). */
export interface WorkflowSummary {
  id: string;
  name: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
  /** ADR 0369 — set when the workflow is archived (only present when the
   *  caller asked for archived rows). */
  archivedAt?: string;
  /** ADR 0369 §5 — an unpromoted builder draft (owner-visible with a Draft chip). */
  transient?: boolean;
  publishedRevision?: string;
  publishedBehindHead?: boolean;
  /** ADR 0596 (`WFAU-2`) — set when a model authored this workflow. */
  authoredVia?: string;
  /** ADR 0482 — daily budget + today's spend (present only when a budget is set). */
  budget?: { dailyUsd: number; hardCap: boolean };
  spentTodayUsd?: number;
}

/** An installed workflow-chain pack template (RFC 0013) — the gallery source. */
export interface ChainTemplate {
  chainId: string;
  packName: string;
  label: string;
  description: string;
  /** Presentational category (the pack's first keyword), for the gallery chip. */
  category?: string;
  parameters?: { type?: string; required?: string[]; properties?: Record<string, ChainParamSpec> };
  capabilities?: string[];
  /** Host-derived pre-flight requirements (day-1 UX P3): node types this host
   *  lacks + the connection bindings the chain names. Caller connection status
   *  joins client-side (TemplatePreflightModal). */
  requirements?: {
    /** Node types this host does not have at all. */
    missingNodeTypeIds: string[];
    /** ADR 0766 D3 — nodes the host HAS, but not at the version the template
     *  pinned (grade-ux U-1). Optional: an older backend omits it. */
    pinMismatches?: PinMismatch[];
    connections: Array<{ ref: string; providerId: string; providerInstalled: boolean }>;
    /** Human-approval gates in the chain — the pre-flight trust line (P12/F2). */
    approvalGateCount?: number;
    /** How many steps the chain draws (ADR 0773 P11). Optional: an older backend omits it. */
    nodeCount?: number;
    /** Toggle-gated `ctx.features.<id>` surfaces the chain reads (ADR 0191
     *  Phase 2). Always-on features are omitted by the host. Caller enablement
     *  joins client-side (TemplatePreflightModal, via useAllFeatureAccess). */
    requiredFeatures?: Array<{ id: string; label: string }>;
  };
}
/** A node the template pinned that this host has at another version. */
export interface PinMismatch {
  typeId: string;
  label: string;
  pinned: string;
  installed: string;
}
export interface ChainParamSpec {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
}

const CHAINS_URL = `${config.baseUrl}/host/openwop-app/workflow-chains`;
const INSTALL_CHAIN_PACK_URL = `${config.baseUrl}/host/openwop-app/workflow-chain-packs/install`;
const FROM_CHAIN_URL = `${config.baseUrl}/host/openwop-app/workflows/from-chain`;
const LIST_URL = `${config.baseUrl}/host/openwop-app/workflows`;
const DELETE_URL = (id: string) => `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(id)}`;

/** A summary view of the local cache (R-D fallback + parity with the backend list). */
function localSummaries(): WorkflowSummary[] {
  return listSavedWorkflows().map((w) => ({ id: w.id, name: w.name, nodeCount: w.nodes.length, createdAt: w.createdAt, updatedAt: w.updatedAt }));
}

/**
 * The caller's tenant-scoped workflows (backend SoT). Falls back to the local
 * cache when the backend is unreachable so the dashboard never goes blank (R-D).
 */
export async function listWorkflows(opts: { includeArchived?: boolean } = {}): Promise<WorkflowSummary[]> {
  try {
    // Delegates to the shared neutral client (R-extract) + adds the dashboard's
    // offline fallback.
    const rows = await listWorkflowSummaries(opts);
    return rows.map((w) => ({
      id: w.workflowId, name: w.name, nodeCount: w.nodeCount, createdAt: w.createdAt, updatedAt: w.updatedAt,
      ...(w.archivedAt ? { archivedAt: w.archivedAt } : {}),
      ...(w.authoredVia ? { authoredVia: w.authoredVia } : {}),
      ...(w.transient ? { transient: true } : {}),
      // ADR 0482 — the dashboard budget chip payload.
      ...(w.budget ? { budget: w.budget, spentTodayUsd: w.spentTodayUsd ?? 0 } : {}),
    }));
  } catch (err) {
    // ADR 0434 — this used to catch EVERYTHING, so a 401 (session expired) or
    // 429 (the documented per-IP fan-out hazard) rendered this device's local
    // drafts AS IF they were the account's workflow list. That is a lie about
    // whose data you are looking at. Only a true transport failure earns the
    // offline fallback; a refused read must surface.
    if (!isOfflineError(err)) throw err;
    return localSummaries(); // offline / backend-down: degrade to the local cache
  }
}

/** ADR 0770 D6 — the backend REFUSED the definition read (any status: 401,
 *  403, 429, 5xx, or an HTML rewrite the SDK reports as `invalid_json`). The
 *  workflow may well exist; the caller must NOT treat this as "not found" and
 *  mint a blank canvas under its id — the first autosave would overwrite it. */
export class LoadRefusedError extends Error {
  constructor() {
    super(i18n.t('builder:loadRefused'));
    this.name = 'LoadRefusedError';
  }
}

/** ADR 0770 D6 — genuinely offline AND this device holds no copy. Distinct from
 *  not-found for the same reason as {@link LoadRefusedError}. */
export class LoadOfflineError extends Error {
  constructor() {
    super(i18n.t('builder:loadOffline'));
    this.name = 'LoadOfflineError';
  }
}

/** Load a full definition (backend-first, then the local draft cache).
 *
 *  Returns `null` ONLY on an authoritative not-found (the server answered and
 *  holds no such definition, and this device has no draft) — the one case where
 *  a blank canvas under this id is correct. Throws `CanonicalParseError` when
 *  the backend HAS the definition but the builder can't materialize it,
 *  `LoadRefusedError` when the read was refused, and `LoadOfflineError` when
 *  offline with no local copy. Only a genuine transport failure (`isOfflineError`)
 *  degrades to the local cache.
 *
 *  ADR 0770 D6 (`WBWF-5`) — every non-parse error used to fall through to the
 *  local cache or `null`, and `BuilderTab` turned `null` into a blank canvas
 *  under the EXISTING id: a 401/429/5xx on a device without a local copy opened
 *  an empty canvas, and the first edit's autosave overwrote the real workflow. */
export async function loadWorkflow(id: string): Promise<SavedWorkflow | null> {
  return (await loadWorkflowWithHead(id)).workflow;
}

/** The definition and its head revision from ONE server read (grade-code
 *  WBCD-1). An owned workflow is read through `GET …/workflows/:id/head`, which
 *  reads storage fresh and returns both; anything else (a public template, a
 *  never-saved id) falls back to the by-id read with no revision, so its first
 *  save carries no precondition. Taking the content from the by-id read (a
 *  per-instance cache server-side) and the base from `/head` separately let a
 *  STALE canvas carry a CURRENT base — which the precondition then waved through. */
async function readDefinitionWithHead(id: string): Promise<{ def: unknown; headRevision?: string } | null> {
  const res = await fetch(`${LIST_URL}/${encodeURIComponent(id)}/head`, fetchOpts({ headers: authedHeaders() }));
  if (res.ok) {
    const body = (await res.json()) as { definition?: unknown; revision?: unknown };
    return { def: body.definition, ...(typeof body.revision === 'string' ? { headRevision: body.revision } : {}) };
  }
  if (res.status !== 404) await assertSynced(res); // a refusal — typed, never "not found"
  const def = await getWorkflowDefinitionRaw(id);
  return def ? { def } : null;
}

/** {@link loadWorkflow}, plus the head revision the canvas edits against (the
 *  save's `If-Match` base — ADR 0770 D5). Same error contract. */
export async function loadWorkflowWithHead(id: string): Promise<{ workflow: SavedWorkflow | null; headRevision?: string }> {
  let headRevision: string | undefined;
  try {
    // Pack-declared typeIds resolve through the dynamic catalog. Deserializing
    // before it settles made every pack-instantiated template open as a blank
    // canvas (all typeIds unresolved → throw → swallowed). The catalog load is
    // memoized and never rejects, so this is an ordering guarantee, not an
    // extra request per open.
    await loadDynamicCatalog();
    // ADR 0730 C.4 — the shared major-2 definition read. A not-found yields
    // `null` and a transport failure throws; both land on the local cache
    // below, which is what the old `if (res.ok)` fall-through did.
    const read = await readDefinitionWithHead(id);
    headRevision = read?.headRevision;
    const def = (read?.def ?? null) as ({ name?: unknown; metadata?: Record<string, unknown> & { name?: unknown; lifecycle?: { transient?: boolean; generatedBy?: string } } } | null);
    if (def) {
      const d = fromCanonicalDefinition(def);
      const now = new Date().toISOString();
      const local = getSavedWorkflow(id);
      // Builder-authored definitions OMIT the display name by design (it
      // lives in the ownership record — serialize.ts), so `d.name` here can
      // be the deserializer's FILE-IMPORT fallback ("Imported workflow").
      // Resolve from explicit sources only: the embedded name → the local
      // draft → the ownership summary → the id. (Deferred-work fix: opening
      // a builder-authored workflow on a fresh device showed the fallback.)
      const embedded = (typeof def.name === 'string' && def.name.trim())
        ? def.name
        : (typeof def.metadata?.name === 'string' && def.metadata.name.trim() ? def.metadata.name : '');
      let name = embedded || local?.name || '';
      if (!name) {
        try {
          name = (await listWorkflowSummaries()).find((w) => w.workflowId === id)?.name ?? '';
        } catch { /* summaries unreadable — fall through to the id */ }
      }
      const workflow: SavedWorkflow = {
        id,
        name: name || id,
        version: local?.version ?? '1.0.0',
        nodes: d.nodes,
        edges: d.edges,
        ...(d.defaultInputs ? { defaultInputs: d.defaultInputs } : {}),
        ...(d.inputSchema ? { inputSchema: d.inputSchema } : {}),
        // Coupled to node `inputs` — deferred-mode `{type:'variable'}` refs
        // inside them resolve against the bag seeded from `variables[]`, and
        // `ui/RunInputsForm` renders the run-inputs form from it. Carrying the
        // refs while dropping the declarations would leave both broken.
        ...(d.variables !== undefined ? { variables: d.variables } : {}),
        ...(d.configurableSchema !== undefined ? { configurableSchema: d.configurableSchema } : {}),
        createdAt: local?.createdAt ?? now,
        updatedAt: now,
        ...(def.metadata?.lifecycle && typeof def.metadata.lifecycle === 'object'
          ? { lifecycle: def.metadata.lifecycle }
          : {}),
        // ADR 0440 P1 — carry the definition's metadata VERBATIM so a builder
        // round trip preserves keys the builder doesn't model. `name` and
        // `lifecycle` are re-overlaid from their builder-owned homes on save
        // (mergeDefinitionMetadata), so stripping them here keeps ONE writer
        // each and prevents a stale copy shadowing a rename.
        ...(def.metadata && typeof def.metadata === 'object'
          ? { metadata: stripBuilderOwnedKeys(def.metadata) }
          : {}),
      };
      return { workflow, ...(headRevision ? { headRevision } : {}) };
    }
  } catch (err) {
    if (err instanceof CanonicalParseError) throw err; // a real definition we can't open — surface it
    if (!isOfflineError(err)) throw new LoadRefusedError();
    const local = getSavedWorkflow(id);
    if (local) return { workflow: local }; // offline: this device's copy is the honest fallback
    throw new LoadOfflineError();
  }
  // Authoritative not-found: a never-synced local draft, else genuinely new.
  return { workflow: getSavedWorkflow(id) ?? null };
}

/**
 * What the server reported about the save (ADR 0440 P2). `removedReferencedNodeIds`
 * is present only when THIS save dropped nodes that a run actually recorded — the
 * author should know their run history no longer maps to those steps, but the
 * write is deliberately still allowed (see the route comment: refusing it would
 * make deleting a node from a workflow that has ever run impossible).
 *
 * The metadata composition itself lives in `definitionMetadata.ts` — the ONE
 * writer, shared with the three run paths that also POST a definition.
 */
export interface SaveOutcome {
  removedReferencedNodeIds?: string[];
  /** ADR 0770 D5 — the head as persisted; the next save's `If-Match` base.
   *  Absent when offline (nothing reached the server). */
  revision?: string;
  /** ADR 0789 — the id the server PERSISTED under. Differs from the saved id only
   *  when this was a shared (seeded) workflow: the server forks an edit onto the
   *  tenant's own id and never writes the shared one, so the caller must adopt it. */
  workflowId?: string;
  /** ADR 0789 — the shared id this save forked away from (set only on a fork). */
  forkedFrom?: string;
  /** ADR 0789 — the fork landed, but some linked items (schedules, cards, …)
   *  could not be re-pointed and still reference the original. */
  repointFailed?: boolean;
}

/** ADR 0770 D5 — the 409 reason a stale `If-Match` earns. */
export const HEAD_MOVED_REASON = 'workflow_head_moved';

/** Save (write-through): backend ownership index + local cache. Best-effort on
 *  the backend (the local cache is always written so work is never lost; R-D). */
export async function saveWorkflow(
  wf: SavedWorkflow,
  opts: {
    /** ADR 0770 D5 — the head this edit was made against. A server head that
     *  moved since is refused 409 `workflow_head_moved` instead of overwritten. */
    baseRevision?: string;
    /** ADR 0770 D6 — `pagehide` flush: the request must outlive the page. */
    keepalive?: boolean;
    /** ADR 0789 — the canvas is unchanged since load (a shared workflow's save
     *  is then a same-id no-op instead of a fork). */
    pristine?: boolean;
  } = {},
): Promise<SaveOutcome> {
  upsertSavedWorkflow(wf); // local cache first — durable regardless of network
  try {
    const def = serializeWorkflow(wf);
    const res = await fetch(LIST_URL, fetchOpts({
      method: 'POST',
      ...(opts.keepalive ? { keepalive: true } : {}),
      // ADR 0524 Phase E0 — the builder store DOES model node `inputs`,
      // `variables` and `configurableSchema`, so it declares them: an omission
      // from here is a real deletion, not a bundle that cannot serialize them.
      // Only lanes whose SOURCE models the fields may send this — see
      // `fieldContract.ts`; the localStorage-sourced lanes must not.
      headers: authedHeaders({
        'content-type': 'application/json',
        ...fieldContractHeader(),
        ...(opts.baseRevision ? { 'if-match': `"${opts.baseRevision}"` } : {}),
        ...(opts.pristine ? { 'x-openwop-canvas-pristine': '1' } : {}),
      }),
      // ADR 0369 — the lifecycle MUST round-trip: an autosave that dropped the
      // flag would silently promote the draft on the backend.
      body: JSON.stringify({ ...def, metadata: definitionMetadataFor(wf) }),
    }));
    // ADR 0434 — `res.ok` was never read here, so a 401/403/429/5xx looked
    // exactly like a success: the workflow stayed in THIS browser's cache
    // while the UI reported saved, and no other device ever saw it. A refused
    // write is data loss, not offline — surface it. The local copy is kept
    // either way so nothing is destroyed by the throw.
    await assertSynced(res);
    // ADR 0440 P2 — the server reports (never refuses) a save that dropped
    // nodes a run had recorded, so the builder can tell the author their run
    // history no longer maps to those steps.
    const body = (await res.json().catch(() => undefined)) as { removedReferencedNodeIds?: unknown; revision?: unknown; workflowId?: unknown; forkedFrom?: unknown; repointFailed?: unknown } | undefined;
    const removed = body?.removedReferencedNodeIds;
    const revision = typeof body?.revision === 'string' ? body.revision : undefined;
    const forkedFrom = typeof body?.forkedFrom === 'string' ? body.forkedFrom : undefined;
    const persistedId = typeof body?.workflowId === 'string' ? body.workflowId : undefined;
    if (forkedFrom && persistedId && persistedId !== wf.id) {
      // ADR 0789 — re-key the local cache: the shared id is no longer this
      // tenant's, and a cached copy under it would resurrect it on the next sync.
      deleteSavedWorkflow(wf.id);
      upsertSavedWorkflow({ ...wf, id: persistedId });
    }
    return {
      ...(persistedId ? { workflowId: persistedId } : {}),
      ...(forkedFrom ? { forkedFrom } : {}),
      ...(Array.isArray(body?.repointFailed) && body.repointFailed.length > 0 ? { repointFailed: true } : {}),
      ...(Array.isArray(removed) && removed.every((v): v is string => typeof v === 'string') && removed.length > 0
        ? { removedReferencedNodeIds: removed }
        : {}),
      ...(revision ? { revision } : {}),
    };
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    /* genuinely offline: the local cache holds it; a later save syncs it */
  }
  return {};
}

/** Delete from both the backend (IDOR-guarded) and the local cache. */
export async function removeWorkflow(id: string): Promise<void> {
  try {
    const res = await fetch(DELETE_URL(id), fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
    // ADR 0369 — the backend REFUSES deletion while runs reference the
    // definition (409 reason: workflow_referenced). 404 = already gone, which
    // is the desired end state. Anything else the server refused is surfaced.
    await assertSynced(res, [404]);
  } catch (err) {
    // ADR 0434 — previously ANY non-`workflow_referenced` failure still fell
    // through to the local delete, so a 401/429 deleted the workflow on THIS
    // device while it survived on the backend and every other device. The
    // local copy is now dropped only when the server actually confirmed the
    // delete, or when we are genuinely offline (where the next sync reconciles).
    if (!isOfflineError(err)) throw err;
  }
  deleteSavedWorkflow(id);
}

/** List installed workflow-chain pack templates (host-global, authed).
 *
 *  ADR 0770 D8 — THROWS on failure. It used to return `[]` on any error, so a
 *  401/5xx rendered the gallery's "no templates installed" empty state — a
 *  false statement about the host, with no way to retry. */
export async function listChainTemplates(): Promise<ChainTemplate[]> {
  const res = await fetch(CHAINS_URL, fetchOpts({ headers: authedHeaders() }));
  await assertSynced(res);
  return ((await res.json()) as { chains: ChainTemplate[] }).chains;
}

export interface InstallPackResult {
  installed: boolean;
  reason?: string;
  newChains: string[];
}

/** Install a workflow-chain pack from the registry (packs.openwop.dev) at runtime
 *  (ADR 0163 follow-on — the in-app marketplace). Operator-only on the backend
 *  (superadmin gate); throws with the canonical status code in the message so the
 *  caller can show a precise reason (403 operator-only, 404 not found, 422
 *  verification failed). On success the host hot-reloads its chain registry, so a
 *  subsequent listChainTemplates() reflects the new templates with no restart. */
export async function installChainPack(name: string, version: string): Promise<InstallPackResult> {
  const res = await fetch(INSTALL_CHAIN_PACK_URL, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ name, version }),
  }));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`install_failed_${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<InstallPackResult>;
}

/** What a "Use template" instantiation reports back. */
export interface InstantiateResult {
  workflowId: string;
  nodeCount: number;
  subChainWorkflowIds?: string[];
  /** ADR 0770 D3 — sub-chain children this workspace had EDITED, bound as-is. */
  reusedSubChainWorkflowIds?: string[];
  /** Node types this host does not have at all. */
  warnings?: string[];
  /** Nodes installed at a version other than the template pinned (ADR 0766 D3). */
  pinMismatches?: PinMismatch[];
  incompleteNodes?: Array<{ nodeId: string; typeId: string; missing: string[] }>;
}

/** Instantiate a chain template into a fresh owned workflow ("Use template").
 *  Throws `SyncFailureError` (status + domain reason) so the caller can tell a
 *  view-only member (`forbidden_scope`) from a disabled pack from a fault. */
export async function instantiateChain(
  chainId: string,
  params?: Record<string, unknown>,
): Promise<InstantiateResult> {
  const res = await fetch(FROM_CHAIN_URL, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ chainId, ...(params ? { params } : {}) }),
  }));
  await assertSynced(res);
  return res.json() as Promise<InstantiateResult>;
}

/** True when the host DERIVED this template's requirements and they are empty —
 *  no connection bindings, no uninstalled node types, no node installed at a
 *  version other than the one it pinned (day-1 UX P6: the gallery
 *  "Start here" promise). Distinct from the preload predicate below ("no
 *  required params" = instantiable blind); absent requirements (older backend)
 *  honestly reads false, never overpromises. */
export function runsWithZeroConnections(c: ChainTemplate): boolean {
  return c.requirements != null
    && c.requirements.connections.length === 0
    && c.requirements.missingNodeTypeIds.length === 0
    && (c.requirements.pinMismatches ?? []).length === 0;
}

const MIGRATED_KEY = 'openwop-app.builder.migratedToBackend';


/**
 * One-shot, best-effort COPY of the caller's localStorage workflows into the
 * backend ownership index (R-C). Idempotent (stable workflowId → the ownership
 * upsert dedupes); never deletes localStorage. Re-runs harmlessly after an
 * anon→signed-in transition (re-claims drafts under the now-current tenant).
 */
export async function migrateLocalToBackend(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const local = listSavedWorkflows();
    for (const wf of local) {
      const def = serializeWorkflow(wf);
      await fetch(LIST_URL, fetchOpts({
        method: 'POST',
        headers: authedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ...def, metadata: definitionMetadataFor(wf) }),
      })).catch(() => undefined);
    }
    localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
  } catch {
    /* migration is best-effort; localStorage remains the safety net */
  }
}
