/**
 * Creative Briefs client (ADR 0353) — typed fetch wrappers over
 * `/host/openwop-app/creative-briefs/orgs/:orgId/*`.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type CreativeBriefStatus = 'draft' | 'review' | 'approved';

export interface CreativeDirection { label: string; rationale?: string }
export interface MoodBoardItem { mediaAssetId: string; note?: string }
export interface PlatformSpec { platform?: string; format?: string; textRulePct?: number }

export interface CreativeBrief {
  briefId: string;
  orgId: string;
  campaignBriefId?: string;
  title: string;
  assetType: string;
  sceneDescription: string;
  composition?: string;
  cameraAngle?: string;
  lighting?: string;
  brandPalette?: string[];
  messagingIntent?: string;
  platformSpec?: PlatformSpec;
  directions: CreativeDirection[];
  moodBoard: MoodBoardItem[];
  needsAssetNote?: string;
  status: CreativeBriefStatus;
  version: number;
  updatedAt: string;
  issues?: Array<{ field: string; severity: 'error' | 'warning'; message: string }>;
}

export interface CreativeBriefVersion {
  versionId: string; version: number; capturedAt: string; capturedBy: string;
  snapshot: Record<string, unknown>;
}

export interface Org { orgId: string; name: string }

const root = `${config.baseUrl}/host/openwop-app`;
const base = (orgId: string): string => `${root}/creative-briefs/orgs/${encodeURIComponent(orgId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

export async function listBriefs(orgId: string): Promise<CreativeBrief[]> {
  const res = await fetch(`${base(orgId)}/briefs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ briefs: CreativeBrief[] }>(res, 'listBriefs')).briefs;
}

export async function getBrief(orgId: string, briefId: string): Promise<CreativeBrief> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'getBrief');
}

export type BriefContent = Partial<Pick<CreativeBrief, 'title' | 'assetType' | 'sceneDescription' | 'composition' | 'cameraAngle' | 'lighting' | 'brandPalette' | 'messagingIntent' | 'directions' | 'moodBoard' | 'campaignBriefId'>> & {
  /** R2 CRB-SP-7 — `null` is the explicit CLEAR sentinel (absent = keep). */
  platformSpec?: PlatformSpec | null;
};

export async function createBrief(orgId: string, content: BriefContent): Promise<CreativeBrief> {
  const res = await fetch(`${base(orgId)}/briefs`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(content) }));
  return asJson(res, 'createBrief');
}

export async function updateBrief(orgId: string, briefId: string, content: BriefContent): Promise<CreativeBrief> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(content) }));
  return asJson(res, 'updateBrief');
}

export async function transitionBrief(orgId: string, briefId: string, status: CreativeBriefStatus): Promise<CreativeBrief> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/transition`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ status }) }));
  return asJson(res, 'transitionBrief');
}

export async function deleteBrief(orgId: string, briefId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson(res, 'deleteBrief');
}

export async function listVersions(orgId: string, briefId: string): Promise<CreativeBriefVersion[]> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/versions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ versions: CreativeBriefVersion[] }>(res, 'listVersions')).versions;
}

export async function diffBriefVersions(orgId: string, briefId: string, from: number, to: number): Promise<Array<{ field: string; from: unknown; to: unknown }>> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/diff?from=${from}&to=${to}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ changes: Array<{ field: string; from: unknown; to: unknown }> }>(res, 'diffBriefVersions')).changes;
}

export async function assembleMoodBoard(orgId: string, briefId: string, criteria: { product?: string; industry?: string; useCase?: string; limit?: number }): Promise<CreativeBrief> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/moodboard`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(criteria) }));
  return asJson(res, 'assembleMoodBoard');
}

/** Trigger the browser download of the brief's PDF. */
export async function downloadPdf(orgId: string, briefId: string, title: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/pdf`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  if (!res.ok) throw new Error(`pdf export returned ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^\w.-]+/g, '_').slice(0, 80)}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── ADR 0399 — ad-layout renders ─────────────────────────────────────────────

export interface SafeZoneRect { id: string; x: number; y: number; w: number; h: number; label: string }
export interface TemplateLayer {
  id: string; kind: 'image' | 'text' | 'shape';
  box: { x: number; y: number; w: number; h: number }; z: number;
}
export interface AdLayoutTemplate {
  templateId: string; version: number; platform: string; format: string;
  width: number; height: number; safeZones: SafeZoneRect[]; layers: TemplateLayer[];
}
export interface RenderWarning { code: string; layerId?: string; message: string; overlapPct?: number; safeZoneId?: string }
export interface LayerNudge { dx?: number; dy?: number; scale?: number }
export interface CreativeRender {
  renderId: string; briefId: string; briefVersion: number;
  templateId: string; templateVersion: number; directionIndex?: number;
  overrides?: Record<string, LayerNudge>;
  copy: { headline: string; body?: string; cta?: string };
  /** The image assets each layer consumed (background/product) — so a nudge
   *  re-render can preserve the chosen/generated layers (ADR 0399 §a). */
  layerAssets?: Partial<Record<string, { mediaAssetId: string; sha256: string }>>;
  warnings: RenderWarning[]; compositeHash: string; mediaAssetId: string; createdAt: string;
  /** ADR 0399 OQ-2 — present when the render is an animated GIF. */
  animation?: { preset: 'reveal'; frames: number; fps: number };
  /** ADR 0411 P3 — present when the render is a generated REEL (video); its
   *  `mediaAssetId` is the video asset (rendered as <video>, not <img>). */
  reel?: { prompt: string; durationSeconds?: number; aspectRatio?: string; provider?: string };
}
export interface RenderRequest {
  templateId?: string; templateIds?: string[]; directionIndex?: number;
  copy?: { headline?: string; body?: string; cta?: string };
  layers?: { background?: string; product?: string };
  overrides?: Record<string, LayerNudge>; brandId?: string;
  /** ADR 0399 OQ-2 — request an animated GIF (reveal preset). */
  animate?: boolean | { preset: 'reveal'; frames?: number; fps?: number };
}

export async function listRenderTemplates(orgId: string): Promise<AdLayoutTemplate[]> {
  const res = await fetch(`${base(orgId)}/render-templates`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ templates: AdLayoutTemplate[] }>(res, 'listRenderTemplates')).templates;
}

export async function listRenders(orgId: string, briefId: string): Promise<CreativeRender[]> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/renders`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ renders: CreativeRender[] }>(res, 'listRenders')).renders;
}

/** One template ⇒ a CreativeRender; templateIds ⇒ the variant fan-out shape. */
export async function createRenders(orgId: string, briefId: string, req: RenderRequest): Promise<{ renders: CreativeRender[]; failures: Array<{ templateId: string; error: string }> }> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/renders`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(req) }));
  const body = await asJson<CreativeRender | { renders: CreativeRender[]; failures: Array<{ templateId: string; error: string }> }>(res, 'createRenders');
  return 'renders' in body ? body : { renders: [body], failures: [] };
}

/** ADR 0411 P3b — launch the "generate reel" RUN (async; video is slow). Returns
 *  the run id to poll (via the shared runsClient `getRun`); on completion the
 *  reel render appears in the brief's renders list. */
export async function generateReel(orgId: string, briefId: string, opts: { aspectRatio?: string; durationSeconds?: number; directionIndex?: number } = {}): Promise<{ runId: string; statusUrl: string }> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/reel`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(opts) }));
  return asJson<{ runId: string; statusUrl: string }>(res, 'generateReel');
}

export async function deleteRender(orgId: string, briefId: string, renderId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/briefs/${encodeURIComponent(briefId)}/renders/${encodeURIComponent(renderId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson(res, 'deleteRender');
}
