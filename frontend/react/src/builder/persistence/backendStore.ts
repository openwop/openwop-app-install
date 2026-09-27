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
    missingNodeTypeIds: string[];
    connections: Array<{ ref: string; providerId: string; providerInstalled: boolean }>;
    /** Human-approval gates in the chain — the pre-flight trust line (P12/F2). */
    approvalGateCount?: number;
    /** Toggle-gated `ctx.features.<id>` surfaces the chain reads (ADR 0191
     *  Phase 2). Always-on features are omitted by the host. Caller enablement
     *  joins client-side (TemplatePreflightModal, via useAllFeatureAccess). */
    requiredFeatures?: Array<{ id: string; label: string }>;
  };
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

/** Load a full definition (backend-first, then the local draft cache).
 *  Throws `CanonicalParseError` when the backend HAS the definition but the
 *  builder can't materialize it (unknown node typeIds, zero nodes) — callers
 *  surface that instead of silently blank-minting over a real definition.
 *  Network failures still degrade to the local cache. */
export async function loadWorkflow(id: string): Promise<SavedWorkflow | null> {
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
    const def = (await getWorkflowDefinitionRaw(id)) as ({ name?: unknown; metadata?: Record<string, unknown> & { name?: unknown; lifecycle?: { transient?: boolean; generatedBy?: string } } } | null);
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
      return {
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
    }
  } catch (err) {
    if (err instanceof CanonicalParseError) throw err; // a real definition we can't open — surface it
    /* network: fall through to local */
  }
  return getSavedWorkflow(id) ?? null;
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
}

/** Save (write-through): backend ownership index + local cache. Best-effort on
 *  the backend (the local cache is always written so work is never lost; R-D). */
export async function saveWorkflow(wf: SavedWorkflow): Promise<SaveOutcome> {
  upsertSavedWorkflow(wf); // local cache first — durable regardless of network
  try {
    const def = serializeWorkflow(wf);
    const res = await fetch(LIST_URL, fetchOpts({
      method: 'POST',
      // ADR 0524 Phase E0 — the builder store DOES model node `inputs`,
      // `variables` and `configurableSchema`, so it declares them: an omission
      // from here is a real deletion, not a bundle that cannot serialize them.
      // Only lanes whose SOURCE models the fields may send this — see
      // `fieldContract.ts`; the localStorage-sourced lanes must not.
      headers: authedHeaders({ 'content-type': 'application/json', ...fieldContractHeader() }),
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
    const body = (await res.json().catch(() => undefined)) as { removedReferencedNodeIds?: unknown } | undefined;
    const removed = body?.removedReferencedNodeIds;
    if (Array.isArray(removed) && removed.every((v): v is string => typeof v === 'string') && removed.length > 0) {
      return { removedReferencedNodeIds: removed };
    }
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

/** List installed workflow-chain pack templates (host-global, authed). Empty on error. */
export async function listChainTemplates(): Promise<ChainTemplate[]> {
  try {
    const res = await fetch(CHAINS_URL, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) throw new Error(`chains_${res.status}`);
    return ((await res.json()) as { chains: ChainTemplate[] }).chains;
  } catch {
    return [];
  }
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

/** Instantiate a chain template into a fresh owned workflow ("Use template"). */
export async function instantiateChain(
  chainId: string,
  params?: Record<string, unknown>,
): Promise<{ workflowId: string; nodeCount: number; subChainWorkflowIds?: string[]; warnings?: string[]; incompleteNodes?: Array<{ nodeId: string; typeId: string; missing: string[] }> }> {
  const res = await fetch(FROM_CHAIN_URL, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ chainId, ...(params ? { params } : {}) }),
  }));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`instantiate_failed_${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<{ workflowId: string; nodeCount: number; subChainWorkflowIds?: string[]; warnings?: string[]; incompleteNodes?: Array<{ nodeId: string; typeId: string; missing: string[] }> }>;
}

/** True when the host DERIVED this template's requirements and they are empty —
 *  no connection bindings, no uninstalled node types (day-1 UX P6: the gallery
 *  "Start here" promise). Distinct from the preload predicate below ("no
 *  required params" = instantiable blind); absent requirements (older backend)
 *  honestly reads false, never overpromises. */
export function runsWithZeroConnections(c: ChainTemplate): boolean {
  return c.requirements != null
    && c.requirements.connections.length === 0
    && c.requirements.missingNodeTypeIds.length === 0;
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
