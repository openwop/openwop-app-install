/**
 * Media library API client (ADR 0007). Org-scoped — every call targets a path
 * `:orgId`. Mirrors /v1/host/openwop-app/media/orgs/:orgId/* and reuses the
 * accessControl org list to populate the org picker.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { blobToBase64 } from '../../chat/hooks/useAudioRecorder.js';

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
export interface MediaAsset {
  assetId: string;
  orgId: string;
  collectionId?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  tags: string[];
  usageCount: number;
  lastUsedAt?: string;
  serveUrl: string;
  createdAt: string;
  updatedAt: string;
}

const root = `${config.baseUrl}/v1/host/openwop-app`;
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

export async function updateAsset(orgId: string, assetId: string, patch: { name?: string; tags?: string[]; collectionId?: string | null }): Promise<MediaAsset> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<MediaAsset>(res, 'updateAsset');
}

export async function deleteAsset(orgId: string, assetId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/assets/${encodeURIComponent(assetId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson<unknown>(res, 'deleteAsset');
}
