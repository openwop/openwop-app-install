/**
 * Media library API client (ADR 0007). Org-scoped — every call targets a path
 * `:orgId`. Mirrors /host/openwop-app/media/orgs/:orgId/* and reuses the
 * accessControl org list to populate the org picker.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { blobToBase64 } from '../../client/blobToBase64.js';

export interface Org {
  orgId: string;
  name: string;
}
export interface MediaCollection {
  collectionId: string;
  orgId: string;
  name: string;
  createdAt: string;
}
/** ADR 0352 — typed marketing facet + crop geometry (see the backend owner). */
export interface MediaMarketing { product?: string; sku?: string; angle?: string; background?: string; industry?: string; personaIds?: string[]; useCase?: string; palette?: string[] }
export interface MediaCropBox { x: number; y: number; w: number; h: number }
/** ADR 0363 P1 — alt-text provenance (see the backend owner `mediaService`). */
export type MediaAltTextSource = 'human' | 'ai' | 'decorative';

export interface MediaAsset {
  assetId: string;
  orgId: string;
  collectionId?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  tags: string[];
  marketing?: MediaMarketing;
  renditions?: Partial<Record<'16:9' | '1:1' | '9:16', MediaCropBox>>;
  /** ADR 0363 P1 — accessibility alt text; `decorative` pairs with empty text. */
  altText?: string;
  altTextSource?: MediaAltTextSource;
  deduplicated?: boolean;
  usageCount: number;
  lastUsedAt?: string;
  serveUrl: string;
  /** The opaque serve token consumers store as a reference (CMS sections). */
  serveToken?: string;
  createdAt: string;
  updatedAt: string;
}

/** A document referencing an asset (ADR 0206 B4 — the "used by" graph). */
export interface MediaUsageRef {
  assetId: string;
  refKind: 'cms-page' | 'campaign' | 'creative-brief';
  refId: string;
  refLabel: string;
  lastSeenAt: string;
}

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The asset serve URL is relative; absolutize it for `<img src>`. */
export function absoluteServeUrl(serveUrl: string): string {
  return serveUrl.startsWith('http') ? serveUrl : `${config.baseUrl}${serveUrl}`;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ orgs: Org[] }>(res, 'listOrgs');
  return body.orgs;
}

const orgBase = (orgId: string): string => `${root}/media/orgs/${encodeURIComponent(orgId)}`;

export async function listCollections(orgId: string): Promise<MediaCollection[]> {
  const res = await fetch(`${orgBase(orgId)}/collections`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ collections: MediaCollection[] }>(res, 'listCollections')).collections;
}

export async function createCollection(orgId: string, name: string): Promise<MediaCollection> {
  const res = await fetch(`${orgBase(orgId)}/collections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name }) }));
  return asJson<MediaCollection>(res, 'createCollection');
}

export async function deleteCollection(orgId: string, collectionId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/collections/${encodeURIComponent(collectionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await asJson<unknown>(res, 'deleteCollection');
}

export async function listAssets(orgId: string, filter: { collectionId?: string; q?: string; tag?: string } = {}): Promise<MediaAsset[]> {
  const params = new URLSearchParams();
  if (filter.collectionId) params.set('collectionId', filter.collectionId);
  if (filter.q) params.set('q', filter.q);
  if (filter.tag) params.set('tag', filter.tag);
  const qs = params.toString();
  const res = await fetch(`${orgBase(orgId)}/assets${qs ? `?${qs}` : ''}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ assets: MediaAsset[] }>(res, 'listAssets')).assets;
}

export async function uploadAsset(orgId: string, file: File, collectionId?: string): Promise<MediaAsset> {
  const contentBase64 = await blobToBase64(file);
  const res = await fetch(
    `${orgBase(orgId)}/assets`,
    fetchOpts({
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ contentBase64, contentType: file.type || 'application/octet-stream', name: file.name, ...(collectionId ? { collectionId } : {}) }),
    }),
  );
  return asJson<MediaAsset>(res, 'uploadAsset');
}

export async function updateAsset(orgId: string, assetId: string, patch: { name?: string; tags?: string[]; collectionId?: string | null; marketing?: MediaMarketing | null; renditions?: MediaAsset['renditions'] | null; altText?: string | null; altTextSource?: MediaAltTextSource }): Promise<MediaAsset> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<MediaAsset>(res, 'updateAsset');
}

/** The documents referencing an asset (asset "used by" — ADR 0206 B4). */
export async function listAssetUsage(orgId: string, assetId: string): Promise<MediaUsageRef[]> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}/usage`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ usage: MediaUsageRef[] }>(res, 'listAssetUsage')).usage;
}

export async function deleteAsset(orgId: string, assetId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson<unknown>(res, 'deleteAsset');
}

/** ADR 0352 P3 — request an AI tagging PROPOSAL (apply it via updateAsset). */
export async function autotagAsset(orgId: string, assetId: string): Promise<{ proposal: { tags: string[]; marketing: MediaMarketing; renditions: MediaAsset['renditions'] } }> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}/autotag`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  return asJson(res, 'autotagAsset');
}

/** ADR 0363 P1 — request an AI alt-text PROPOSAL (apply it via updateAsset).
 *  Returns `altText:''` when the model judged the image decorative. */
export async function generateAltText(orgId: string, assetId: string): Promise<{ proposal: { assetId: string; altText: string } }> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}/alt-text`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  return asJson(res, 'generateAltText');
}

/** ADR 0352 P4 — deterministic weighted selection over the org's image library. */
export async function selectAssets(orgId: string, criteria: { product?: string; industry?: string; useCase?: string; personaIds?: string[]; collectionId?: string; limit?: number }): Promise<{ assets: Array<{ asset: MediaAsset & { serveUrl: string }; score: number; matched: string[] }>; fallbackLevel: number; needsAsset?: { criteria: Record<string, unknown> } }> {
  const res = await fetch(`${orgBase(orgId)}/assets/select`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(criteria) }));
  return asJson(res, 'selectAssets');
}

// ── ADR 0401 — AI image generation (media owns the routes + the bytes) ───────

export interface ImageProviderOption { provider: string; credentialRefs: string[]; ops: string[] }

export async function listImageProviders(orgId: string): Promise<ImageProviderOption[]> {
  const res = await fetch(`${orgBase(orgId)}/image-providers`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ providers: ImageProviderOption[] }>(res, 'listImageProviders')).providers;
}

export async function generateImageAssets(orgId: string, req: { prompt: string; provider: string; model?: string; size?: string; n?: number; credentialRef?: string; collectionId?: string }): Promise<MediaAsset[]> {
  const res = await fetch(`${orgBase(orgId)}/assets/generate`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(req) }));
  return (await asJson<{ assets: MediaAsset[] }>(res, 'generateImageAssets')).assets;
}

export type ImageEditOp = 'edit' | 'inpaint' | 'background-remove';

export async function aiEditAsset(orgId: string, assetId: string, req: { op: ImageEditOp; prompt?: string; maskBase64?: string; provider?: string; model?: string }): Promise<MediaAsset[]> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}/ai-edit`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(req) }));
  return (await asJson<{ assets: MediaAsset[] }>(res, 'aiEditAsset')).assets;
}

export async function aiUpscaleAsset(orgId: string, assetId: string, req: { scale: 2 | 4; provider?: string; model?: string }): Promise<MediaAsset[]> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}/ai-upscale`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(req) }));
  return (await asJson<{ assets: MediaAsset[] }>(res, 'aiUpscaleAsset')).assets;
}
