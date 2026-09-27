/**
 * App-builder canvas editor client — the framework verbs (catalog, from-artifact,
 * get/save with optimistic concurrency, versions, delete) delegate to the canvas
 * framework's `createCanvasClient` (ADR 0310 Phase A; extracted from here, where
 * it originated as ADR 0153 Phase 2b). Wire paths are byte-identical
 * (`/host/openwop-app/app-builder/orgs/:orgId/*`). The app-builder-specific
 * verbs — code export (ADR 0173) and GitHub publish (ADR 0306) — stay here.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { asJson, createCanvasClient } from '../../canvas/canvasClient.js';
import type { FrameTemplateDto } from '../../canvas/canvasClient.js';

export type {
  Org,
  ComponentPropDef,
  ComponentDef,
  CatalogResponse,
  CanvasRecord,
  CanvasVersionRow,
  SaveWarning,
} from '../../canvas/canvasClient.js';
export { listOrgs } from '../../canvas/canvasClient.js';

/** Screen templates are the app-builder's name for frame templates. */
export type ScreenTemplateDto = FrameTemplateDto;

const client = createCanvasClient({ basePath: '/host/openwop-app/app-builder' });
const root = client.root;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

export const getCatalog = client.getCatalog;
export const getCanvas = client.getCanvas;
export const createCanvas = client.createCanvas;
export const seedFromArtifact = client.seedFromArtifact;
export const deleteCanvas = client.deleteCanvas;
export const listVersions = client.listVersions;
export const getVersion = client.getVersion;
export const restoreVersion = client.restoreVersion;
export const saveCanvas = client.saveCanvas;

// ── GitHub publish (ADR 0306) ──
export interface PublishResult { repoUrl: string; repo: 'created' | 'reused'; filesPushed: number; partial?: boolean; warnings: string[] }
export async function publishCanvas(orgId: string, canvasId: string, args: { target: ExportTarget; repo: string; private: boolean }): Promise<PublishResult> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/publish`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(args) }));
  return asJson<PublishResult>(res, 'publish canvas');
}

// ── Two-way GitHub sync (ADR 0393 Lane A) ──
export interface SyncBindingView { canvasId: string; owner: string; repo: string; branch: string; target: ExportTarget; webhookId: string; boundBy: string; boundAt: string }
export interface SyncPushResult { outcome: 'pushed' | 'noop' | 'ref_conflict'; repoUrl: string; branch: string; commitSha?: string; filesPushed: number; deletedStale: number; modelVersion: number; warnings: string[] }

export async function getSyncBinding(orgId: string, canvasId: string): Promise<SyncBindingView | null> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/sync-binding`, fetchOpts({ headers: authedHeaders() }));
  const out = await asJson<{ binding: SyncBindingView | null }>(res, 'read sync binding');
  return out.binding;
}

/** Admin-only (`host:code-sync:manage`) — the webhook secret returns exactly once here. */
export async function bindSyncRepo(orgId: string, canvasId: string, args: { owner: string; repo: string; branch: string; target: ExportTarget }): Promise<{ binding: SyncBindingView; webhookSecret: string }> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/sync-binding`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(args) }));
  return asJson<{ binding: SyncBindingView; webhookSecret: string }>(res, 'bind sync repo');
}

export async function unbindSyncRepo(orgId: string, canvasId: string): Promise<void> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/sync-binding`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson(res, 'unbind sync repo');
}

export async function syncCanvasNow(orgId: string, canvasId: string): Promise<SyncPushResult> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/sync`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson<SyncPushResult>(res, 'sync canvas');
}

/** ADR 0173 — export code targets. */
export type ExportTarget = 'react-tailwind' | 'react-styled' | 'vue-tailwind' | 'html-css' | 'react-native' | 'flutter' | 'nextjs';
export const EXPORT_TARGETS: readonly ExportTarget[] = ['react-tailwind', 'react-styled', 'vue-tailwind', 'html-css', 'react-native', 'flutter', 'nextjs'];
/** A deterministic warning from the target-capability comparison. The export
 * is still useful, but this says exactly which authored semantics it omits. */
export interface ExportPreflightNote { code: string; message: string; count?: number }
export interface ExportResult {
  assetToken: string; serveUrl: string; fileName: string; fileCount: number; sizeBytes: number;
  warnings: string[];
  /** Additive on older hosts; callers must keep export functional if absent. */
  preflight?: ExportPreflightNote[];
}

/** Generate framework-native source; returns a capability-token download (`serveUrl`
 *  is relative to `config.baseUrl`). Gated by the `code-export` toggle (404 when off). */
export async function exportCanvasCode(orgId: string, canvasId: string, target: ExportTarget): Promise<ExportResult> {
  const res = await fetch(`${root}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/export`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ target }) }));
  return asJson<ExportResult>(res, 'export canvas');
}

/** The absolute URL to download a generated asset (same-origin → cookies included). */
export function exportDownloadUrl(serveUrl: string): string {
  return `${config.baseUrl}${serveUrl}`;
}
