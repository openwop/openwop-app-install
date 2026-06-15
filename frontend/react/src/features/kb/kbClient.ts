/**
 * Knowledge Base API client (ADR 0011). Org-scoped under
 * /v1/host/openwop-app/kb/orgs/:orgId. Sources are pasted text or Media-Library
 * tokens; retrieval returns scored chunks + citations.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }

export interface KbCollection {
  collectionId: string;
  name: string;
  description?: string;
  documentCount: number;
  chunkCount: number;
  updatedAt: string;
}

export interface KbDocument {
  documentId: string;
  title: string;
  source: { kind: 'text' } | { kind: 'media' };
  chunkCount: number;
  createdAt: string;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  chunkIndex: number;
  text: string;
  score: number;
}

export interface RagResult {
  query: string;
  contexts: SearchHit[];
  citations: Array<{ documentId: string; title: string }>;
  augmentedPrompt: string;
}

const root = `${config.baseUrl}/v1/host/openwop-app`;
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

const base = (orgId: string): string => `${root}/kb/orgs/${encodeURIComponent(orgId)}`;
const col = (orgId: string, collectionId: string): string => `${base(orgId)}/collections/${encodeURIComponent(collectionId)}`;

export async function listCollections(orgId: string): Promise<KbCollection[]> {
  const res = await fetch(`${base(orgId)}/collections`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ collections: KbCollection[] }>(res, 'listCollections')).collections;
}

export async function createCollection(orgId: string, name: string, description?: string): Promise<KbCollection> {
  const res = await fetch(`${base(orgId)}/collections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...(description ? { description } : {}) }) }));
  return asJson<KbCollection>(res, 'createCollection');
}

export async function deleteCollection(orgId: string, collectionId: string): Promise<void> {
  // 204 No Content is `res.ok`, so a plain !ok check is correct + clearer.
  const res = await fetch(col(orgId, collectionId), fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteCollection returned ${res.status}`);
}

export async function listDocuments(orgId: string, collectionId: string): Promise<KbDocument[]> {
  const res = await fetch(`${col(orgId, collectionId)}/documents`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ documents: KbDocument[] }>(res, 'listDocuments')).documents;
}

export async function ingestText(orgId: string, collectionId: string, title: string, text: string): Promise<KbDocument> {
  const res = await fetch(`${col(orgId, collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ title, text }) }));
  return asJson<KbDocument>(res, 'ingestText');
}

export async function ingestMedia(orgId: string, collectionId: string, title: string, mediaToken: string): Promise<KbDocument> {
  const res = await fetch(`${col(orgId, collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ title, mediaToken }) }));
  return asJson<KbDocument>(res, 'ingestMedia');
}

export async function deleteDocument(orgId: string, collectionId: string, documentId: string): Promise<void> {
  const res = await fetch(`${col(orgId, collectionId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteDocument returned ${res.status}`);
}

export async function search(orgId: string, collectionId: string, query: string, topK = 8): Promise<SearchHit[]> {
  const res = await fetch(`${col(orgId, collectionId)}/search`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ query, topK }) }));
  return (await asJson<{ results: SearchHit[] }>(res, 'search')).results;
}

export async function ragQuery(orgId: string, collectionId: string, query: string, topK = 8): Promise<RagResult> {
  const res = await fetch(`${col(orgId, collectionId)}/rag`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ query, topK }) }));
  return asJson<RagResult>(res, 'ragQuery');
}
