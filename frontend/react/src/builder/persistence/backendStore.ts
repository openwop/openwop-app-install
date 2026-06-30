/**
 * Backend-backed workflow persistence for the builder dashboard (ADR 0163 Phase 3).
 *
 * Makes "Your workflows" REAL: the backend per-tenant ownership index
 * (`GET/POST/DELETE /v1/host/openwop-app/workflows`, ADR 0163 Phase 1) is the
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

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { listWorkflowSummaries } from '../../workflows/workflowsClient.js';
import { serializeWorkflow } from '../schema/serialize.js';
import { fromCanonicalDefinition } from '../schema/deserialize.js';
import type { SavedWorkflow } from '../schema/workflow.js';
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
}

/** An installed workflow-chain pack template (RFC 0013) — the gallery source. */
export interface ChainTemplate {
  chainId: string;
  packName: string;
  label: string;
  description: string;
  parameters?: { type?: string; required?: string[]; properties?: Record<string, ChainParamSpec> };
  capabilities?: string[];
}
export interface ChainParamSpec {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
}

const CHAINS_URL = `${config.baseUrl}/v1/host/openwop-app/workflow-chains`;
const INSTALL_CHAIN_PACK_URL = `${config.baseUrl}/v1/host/openwop-app/workflow-chain-packs/install`;
const FROM_CHAIN_URL = `${config.baseUrl}/v1/host/openwop-app/workflows/from-chain`;
const LIST_URL = `${config.baseUrl}/v1/host/openwop-app/workflows`;
const DEF_URL = (id: string) => `${config.baseUrl}/v1/workflows/${encodeURIComponent(id)}`;
const DELETE_URL = (id: string) => `${config.baseUrl}/v1/host/openwop-app/workflows/${encodeURIComponent(id)}`;

/** A summary view of the local cache (R-D fallback + parity with the backend list). */
function localSummaries(): WorkflowSummary[] {
  return listSavedWorkflows().map((w) => ({ id: w.id, name: w.name, nodeCount: w.nodes.length, createdAt: w.createdAt, updatedAt: w.updatedAt }));
}

/**
 * The caller's tenant-scoped workflows (backend SoT). Falls back to the local
 * cache when the backend is unreachable so the dashboard never goes blank (R-D).
 */
export async function listWorkflows(): Promise<WorkflowSummary[]> {
  try {
    // Delegates to the shared neutral client (R-extract) + adds the dashboard's
    // offline fallback.
    const rows = await listWorkflowSummaries();
    return rows.map((w) => ({ id: w.workflowId, name: w.name, nodeCount: w.nodeCount, createdAt: w.createdAt, updatedAt: w.updatedAt }));
  } catch {
    return localSummaries(); // offline / backend-down: degrade to the local cache
  }
}

/** Load a full definition (backend-first, then the local draft cache). */
export async function loadWorkflow(id: string): Promise<SavedWorkflow | null> {
  try {
    const res = await fetch(DEF_URL(id), fetchOpts({ headers: authedHeaders() }));
    if (res.ok) {
      const def = (await res.json()) as { metadata?: { name?: unknown } };
      const d = fromCanonicalDefinition(def);
      const now = new Date().toISOString();
      const local = getSavedWorkflow(id);
      return {
        id,
        name: d.name || (typeof def.metadata?.name === 'string' ? def.metadata.name : id),
        version: local?.version ?? '1.0.0',
        nodes: d.nodes,
        edges: d.edges,
        ...(d.defaultInputs ? { defaultInputs: d.defaultInputs } : {}),
        createdAt: local?.createdAt ?? now,
        updatedAt: now,
      };
    }
  } catch {
    /* fall through to local */
  }
  return getSavedWorkflow(id) ?? null;
}

/** Save (write-through): backend ownership index + local cache. Best-effort on
 *  the backend (the local cache is always written so work is never lost; R-D). */
export async function saveWorkflow(wf: SavedWorkflow): Promise<void> {
  upsertSavedWorkflow(wf); // local cache first — durable regardless of network
  try {
    const def = serializeWorkflow(wf);
    await fetch(LIST_URL, fetchOpts({
      method: 'POST',
      headers: authedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ ...def, metadata: { ...(def as { metadata?: object }).metadata, name: wf.name } }),
    }));
  } catch {
    /* offline: the local cache holds it; a later save/migration syncs it */
  }
}

/** Delete from both the backend (IDOR-guarded) and the local cache. */
export async function removeWorkflow(id: string): Promise<void> {
  try {
    await fetch(DELETE_URL(id), fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  } catch {
    /* offline: still drop the local copy */
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
): Promise<{ workflowId: string; nodeCount: number; warnings?: string[] }> {
  const res = await fetch(FROM_CHAIN_URL, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ chainId, ...(params ? { params } : {}) }),
  }));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`instantiate_failed_${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<{ workflowId: string; nodeCount: number; warnings?: string[] }>;
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
        body: JSON.stringify({ ...def, metadata: { ...(def as { metadata?: object }).metadata, name: wf.name } }),
      })).catch(() => undefined);
    }
    localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
  } catch {
    /* migration is best-effort; localStorage remains the safety net */
  }
}
