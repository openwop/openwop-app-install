/**
 * Canvas framework — the editor-client factory (ADR 0310, extracted from the
 * app-builder's canvasEditorClient.ts / ADR 0153 Phase 2b). Wraps a canvas
 * type's host-ext editor routes (`<basePath>/orgs/:orgId/*`): the component
 * catalog (palette), opening a run artifact into an editable `host.canvas`
 * working copy, reading it, saving with optimistic concurrency, version
 * history, and delete. The canvas store is tenant-scoped server-side; `orgId`
 * is the auth context (any org the caller belongs to). Type-specific verbs
 * (export, publish) stay in the type's own client module, riding `asJson`.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import type { CanvasPaletteItem, CanvasPropDef } from './types.js';

const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

export interface Org { orgId: string; name: string }

export type ComponentPropDef = CanvasPropDef;
export type ComponentDef = CanvasPaletteItem;
export interface FrameTemplateDto {
  id: string;
  name: string;
  description: string;
  /** Tree-trait templates: the frame's root node list (app-builder screens). */
  components?: { type: string; props?: Record<string, unknown>; children?: unknown[] }[];
  /** Fixed-schema templates (ADR 0310 Phase B): merged into the new frame verbatim
   *  (slides: `{ layout, title, … }`). Takes precedence over `components`. */
  content?: Record<string, unknown>;
}
export interface CanvasKitVariableDto {
  name: string;
  type: 'string' | 'color';
  label?: string;
  default?: string;
  description?: string;
}
/** ADR 0347 5a — a pack-distributed multi-frame kit (screens + relations +
 *  typed template variables), instantiated client-side into the ONE document. */
export interface CanvasKitDto {
  kitId: string;
  version: string;
  label: string;
  description?: string;
  canvasTypeId: string;
  variables?: CanvasKitVariableDto[];
  screens: Record<string, unknown>[];
  connectors?: Record<string, unknown>[];
  catalogDependencies?: string[];
}
export interface CatalogResponse {
  canvasTypeId: string;
  components: ComponentDef[];
  promptSchema: string;
  templates?: FrameTemplateDto[];
  /** ADR 0347 5a (additive): pack-distributed kits for this canvas type. */
  kits?: CanvasKitDto[];
  /** Pack-declared editor hints (ADR 0310 Phase D) — see canvas/packDefinition. */
  editor?: unknown;
}

export interface CanvasRecord {
  canvasId: string;
  canvasTypeId: string;
  name?: string;
  projectId?: string;
  ownerSubject?: { kind: string; id: string };
  state: Record<string, unknown>;
  version: number;
}

export interface CanvasVersionRow { versionId: string; version: number; capturedBy: string; capturedAt: string }
export interface SaveWarning { path: string; message: string }

export async function asJson<T>(res: Response, ctx: string): Promise<T> {
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
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ orgs?: Org[] } | Org[]>(res, 'list orgs');
  return Array.isArray(body) ? body : (body.orgs ?? []);
}

export interface CanvasClient {
  /** The type's route root — type-specific verbs build on this. */
  root: string;
  getCatalog(orgId: string): Promise<CatalogResponse>;
  getCanvas(orgId: string, canvasId: string): Promise<CanvasRecord>;
  /** Create a BLANK canvas of this type (ADR 0314 — the creation gallery). */
  createCanvas(orgId: string, input: { name: string; projectId?: string }): Promise<CanvasRecord>;
  seedFromArtifact(orgId: string, artifactKey: string): Promise<CanvasRecord>;
  deleteCanvas(orgId: string, canvasId: string): Promise<void>;
  listVersions(orgId: string, canvasId: string): Promise<CanvasVersionRow[]>;
  getVersion(orgId: string, canvasId: string, versionId: string): Promise<CanvasVersionRow & { snapshot: Record<string, unknown> }>;
  restoreVersion(orgId: string, canvasId: string, versionId: string): Promise<{ canvasId: string; newVersion: number }>;
  saveCanvas(orgId: string, canvasId: string, state: Record<string, unknown>, expectedVersion: number): Promise<{ canvasId: string; newVersion: number; warnings?: SaveWarning[] }>;
}

/** The editable pack-declared canvas types (ADR 0314 — the creation gallery's
 *  pack cards). Gated server-side by the `canvas-packs` toggle; a disabled
 *  toggle surfaces as an error, which gallery callers treat as "no pack types". */
export interface PackCanvasTypeRow { canvasTypeId: string; title: string }
export async function listPackCanvasTypes(orgId: string): Promise<PackCanvasTypeRow[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/canvas-packs/orgs/${encodeURIComponent(orgId)}/types`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ types: PackCanvasTypeRow[] }>(res, 'list pack canvas types')).types;
}

/** Build the editor client for one canvas type. `basePath` is the type's
 *  host-ext root relative to the API base, e.g. `/host/openwop-app/app-builder` —
 *  wire paths stay byte-identical to the pre-framework per-type clients. */
export function createCanvasClient(opts: { basePath: string }): CanvasClient {
  const root = `${config.baseUrl}${opts.basePath}`;

  return {
    root,

    async getCatalog(orgId: string): Promise<CatalogResponse> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/catalog`, fetchOpts({ headers: authedHeaders() }));
      return asJson<CatalogResponse>(res, 'get catalog');
    },

    async getCanvas(orgId: string, canvasId: string): Promise<CanvasRecord> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}`, fetchOpts({ headers: authedHeaders() }));
      return asJson<CanvasRecord>(res, 'get canvas');
    },

    async createCanvas(orgId: string, input: { name: string; projectId?: string }): Promise<CanvasRecord> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
      return asJson<CanvasRecord>(res, 'create canvas');
    },

    /** Open a run's canvas.* artifact into an editable working copy (idempotent). */
    async seedFromArtifact(orgId: string, artifactKey: string): Promise<CanvasRecord> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/from-artifact`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ artifactKey }) }));
      return asJson<CanvasRecord>(res, 'seed canvas');
    },

    /** Delete a canvas (cascades versions + share links server-side — grade pass DATA-3). */
    async deleteCanvas(orgId: string, canvasId: string): Promise<void> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
      if (!res.ok) await asJson(res, 'delete canvas');
    },

    // ── version history (ADR 0305 Phase E) ──
    async listVersions(orgId: string, canvasId: string): Promise<CanvasVersionRow[]> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/versions`, fetchOpts({ headers: authedHeaders() }));
      return (await asJson<{ versions: CanvasVersionRow[] }>(res, 'list versions')).versions;
    },

    async getVersion(orgId: string, canvasId: string, versionId: string): Promise<CanvasVersionRow & { snapshot: Record<string, unknown> }> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/versions/${encodeURIComponent(versionId)}`, fetchOpts({ headers: authedHeaders() }));
      return asJson<CanvasVersionRow & { snapshot: Record<string, unknown> }>(res, 'get version');
    },

    async restoreVersion(orgId: string, canvasId: string, versionId: string): Promise<{ canvasId: string; newVersion: number }> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/versions/${encodeURIComponent(versionId)}/restore`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
      return asJson<{ canvasId: string; newVersion: number }>(res, 'restore version');
    },

    /** Save the whole canvas state with optimistic concurrency. Throws on a version
     *  conflict (status 409 / code canvas_version_conflict) so the editor can prompt a reload. */
    async saveCanvas(orgId: string, canvasId: string, state: Record<string, unknown>, expectedVersion: number): Promise<{ canvasId: string; newVersion: number; warnings?: SaveWarning[] }> {
      const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ state, expectedVersion }) }));
      return asJson<{ canvasId: string; newVersion: number; warnings?: SaveWarning[] }>(res, 'save canvas');
    },
  };
}
