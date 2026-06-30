/**
 * App-builder canvas editor client (ADR 0153 Phase 2b). Wraps the host-ext editor
 * routes (`/v1/host/openwop-app/app-builder/orgs/:orgId/*`): the closed component
 * catalog (palette), opening a run artifact into an editable `host.canvas` working
 * copy, reading it, and saving with optimistic concurrency. The canvas store is
 * tenant-scoped server-side; `orgId` is the auth context (any org the caller belongs to).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const root = `${config.baseUrl}/v1/host/openwop-app/app-builder`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

export interface Org { orgId: string; name: string }

export interface ComponentPropDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'color' | 'longtext';
  label?: string;
  options?: string[];
  default?: string | number | boolean;
  required?: boolean;
}
export interface ComponentDef {
  type: string;
  label: string;
  description?: string;
  category: string;
  acceptsChildren?: boolean;
  props?: ComponentPropDef[];
}
export interface CatalogResponse { canvasTypeId: string; components: ComponentDef[]; promptSchema: string }

export interface CanvasRecord {
  canvasId: string;
  canvasTypeId: string;
  name?: string;
  projectId?: string;
  ownerSubject?: { kind: string; id: string };
  state: Record<string, unknown>;
  version: number;
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    const err = new Error(detail || `${ctx} returned ${res.status}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/** List the orgs the caller belongs to (to pick the auth-context org). Tolerates
 *  both the `{ orgs: [...] }` envelope and a bare array. */
export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ orgs?: Org[] } | Org[]>(res, 'list orgs');
  return Array.isArray(body) ? body : (body.orgs ?? []);
}

export async function getCatalog(orgId: string): Promise<CatalogResponse> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/catalog`, fetchOpts({ headers: authedHeaders() }));
  return asJson<CatalogResponse>(res, 'get catalog');
}

export async function getCanvas(orgId: string, canvasId: string): Promise<CanvasRecord> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<CanvasRecord>(res, 'get canvas');
}

/** Open a run's canvas.* artifact into an editable working copy (idempotent). */
export async function seedFromArtifact(orgId: string, artifactKey: string): Promise<CanvasRecord> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/from-artifact`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ artifactKey }) }));
  return asJson<CanvasRecord>(res, 'seed canvas');
}

/** Save the whole canvas state with optimistic concurrency. Throws on a version
 *  conflict (status 409 / code canvas_version_conflict) so the editor can prompt a reload. */
export async function saveCanvas(orgId: string, canvasId: string, state: Record<string, unknown>, expectedVersion: number): Promise<{ canvasId: string; newVersion: number }> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ state, expectedVersion }) }));
  return asJson<{ canvasId: string; newVersion: number }>(res, 'save canvas');
}
