/**
 * CAD mesh-asset resolution + cache (ADR 0388 P1). A `mesh` solid carries only
 * an `assetRef`; this store resolves it → meta (org-scoped route) → canonical
 * bytes (the capability serve URL) → a parsed triangle soup (the meshCodec
 * twin), cached per assetRef for the session. Consumers subscribe via
 * `useMesh` (useSyncExternalStore) so viewers re-render when bytes land.
 *
 * Org resolution mirrors the CanvasEditorPage/csm convention: every feature
 * that needs `listOrgs` keeps its OWN thin copy against the shared orgs route
 * (checked precedent — never a cross-feature client import).
 *
 * Viewer budget (architect R5): `sampleForView` returns at most
 * `VIEW_TRIANGLE_BUDGET` triangles via DETERMINISTIC stride sampling; export
 * always uses the full-fidelity cached mesh.
 */
import { useSyncExternalStore } from 'react';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { parseStl, type ParsedMesh } from './meshCodec.js';

export const VIEW_TRIANGLE_BUDGET = 8000;

export interface MeshMeta {
  meshId: string;
  serveUrl: string;
  triangleCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  dropped: string[];
  name: string;
}

export interface MeshEntry {
  status: 'loading' | 'ready' | 'error';
  meta?: MeshMeta;
  mesh?: ParsedMesh;
  error?: string;
}

const cache = new Map<string, MeshEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// CAD2-M7 (R3) — this used to take `orgs[0]` from the tenant-wide org list and
// memoize even a FAILED read for the whole session: in a two-org workspace a
// member of the second org 403'd on every mesh read forever (the agent lane
// already refused with `org_required` — the two paths disagreed and the UI was
// the looser one). The mesh's org is not known client-side, so `load` now tries
// EVERY listed org (first 2xx wins and becomes the preferred first candidate),
// and a failed/empty org-list read is never memoized — the next read retries.
let orgsPromise: Promise<string[]> | null = null;
let preferredOrgId: string | null = null;
async function resolveOrgIds(): Promise<string[]> {
  orgsPromise ??= (async () => {
    try {
      const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
      if (!res.ok) return [];
      const body = (await res.json()) as { orgs?: Array<{ orgId?: string }> } | Array<{ orgId?: string }>;
      const orgs = Array.isArray(body) ? body : body.orgs ?? [];
      return orgs.map((o) => o.orgId).filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch {
      return [];
    }
  })();
  const ids = await orgsPromise;
  if (ids.length === 0) orgsPromise = null; // a failure is a retry, not a session verdict
  return ids;
}

async function load(assetRef: string): Promise<void> {
  try {
    const orgIds = await resolveOrgIds();
    if (orgIds.length === 0) throw new Error('no org');
    const candidates = preferredOrgId && orgIds.includes(preferredOrgId)
      ? [preferredOrgId, ...orgIds.filter((o) => o !== preferredOrgId)]
      : orgIds;
    let metaRes: Response | null = null;
    let lastStatus = 0;
    for (const orgId of candidates) {
      const res = await fetch(
        `${config.baseUrl}/host/openwop-app/cad/orgs/${encodeURIComponent(orgId)}/meshes/${encodeURIComponent(assetRef)}`,
        fetchOpts({ headers: authedHeaders() }),
      );
      if (res.ok) { metaRes = res; preferredOrgId = orgId; break; }
      lastStatus = res.status;
    }
    if (!metaRes) throw new Error(`mesh meta ${lastStatus || 'unreachable'}`);
    const meta = (await metaRes.json()) as MeshMeta;
    const bytesRes = await fetch(`${config.baseUrl}${meta.serveUrl}`, fetchOpts({ headers: authedHeaders() }));
    if (!bytesRes.ok) throw new Error(`mesh bytes ${bytesRes.status}`);
    const mesh = parseStl(new Uint8Array(await bytesRes.arrayBuffer()));
    cache.set(assetRef, { status: 'ready', meta, mesh });
  } catch (err) {
    cache.set(assetRef, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  notify();
}

/** Peek without loading (pure callers, e.g. footprint labels). */
export function peekMesh(assetRef: string): MeshEntry | undefined {
  return cache.get(assetRef);
}

function getSnapshot(assetRef: string): MeshEntry {
  let entry = cache.get(assetRef);
  if (!entry) {
    entry = { status: 'loading' };
    cache.set(assetRef, entry);
    void load(assetRef);
  }
  return entry;
}

/** Subscribe to one mesh asset (loads on first use; session-cached). */
export function useMesh(assetRef: string | undefined): MeshEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (assetRef ? getSnapshot(assetRef) : undefined),
    () => (assetRef ? cache.get(assetRef) : undefined),
  );
}

/** Imperative get-or-load (for callers resolving a VARIABLE number of refs —
 *  hooks can't loop; pair with `useMeshStoreVersion` to re-render on load). */
export function ensureMesh(assetRef: string): MeshEntry {
  return getSnapshot(assetRef);
}

let version = 0;
listeners.add(() => { version += 1; });

/** Re-render trigger: bumps whenever ANY mesh entry changes. */
export function useMeshStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Deterministic stride sample for the hand-rolled viewer (architect R5):
 *  every Nth triangle so the preview stays responsive; `sampled` flags the
 *  simplified-preview badge. Export always uses the full mesh. */
export function sampleForView(mesh: ParsedMesh): { positions: Float32Array; shown: number; total: number; sampled: boolean } {
  const total = mesh.triangleCount;
  if (total <= VIEW_TRIANGLE_BUDGET) {
    return { positions: mesh.positions, shown: total, total, sampled: false };
  }
  const stride = Math.ceil(total / VIEW_TRIANGLE_BUDGET);
  const shown = Math.floor((total + stride - 1) / stride);
  const out = new Float32Array(shown * 9);
  let w = 0;
  for (let t = 0; t < total; t += stride) {
    for (let v = 0; v < 9; v += 1) out[w * 9 + v] = mesh.positions[t * 9 + v] ?? 0;
    w += 1;
  }
  return { positions: out.subarray(0, w * 9) as Float32Array, shown: w, total, sampled: true };
}

/** The active org id for cad routes (import UI). Prefers the org that last
 *  served a mesh; falls back to the first listed. */
export async function cadOrgId(): Promise<string | null> {
  const ids = await resolveOrgIds();
  return preferredOrgId && ids.includes(preferredOrgId) ? preferredOrgId : ids[0] ?? null;
}

/** Test seam. */
export function __clearMeshCache(): void {
  orgsPromise = null;
  preferredOrgId = null;
  cache.clear();
}
