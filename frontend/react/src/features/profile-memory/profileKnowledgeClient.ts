/**
 * Personal Knowledge client (ADR 0042) — the human counterpart of the agent
 * knowledge client. Drives /v1/host/openwop-app/profiles/me/knowledge: view, bind /
 * create / unbind a KB collection, ingest a text document, delete a document, and a
 * read-only retrieve over the caller's OWN corpus (bound docs + personal notes).
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface KnowledgeDoc { documentId: string; title: string; chunkCount: number; createdAt: string; contentTrust?: 'trusted' | 'untrusted' }
export interface KnowledgeCollection { collectionId: string; orgId: string; name: string; documentCount: number; chunkCount: number; documents: KnowledgeDoc[] }
export interface ProfileKnowledgeView { userId: string; collections: KnowledgeCollection[]; noteCount: number }
export interface RetrieveResult { chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust?: 'trusted' | 'untrusted' }>; hasResults: boolean }
export interface Org { orgId: string; name: string }

const base = `${config.baseUrl}/v1/host/openwop-app/profiles/me/knowledge`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw new Error(`${ctx} failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function getProfileKnowledge(): Promise<ProfileKnowledgeView> {
  return asJson<ProfileKnowledgeView>(await fetch(base, fetchOpts({ headers: authedHeaders() })), 'getProfileKnowledge');
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

export async function createCollection(orgId: string, name: string): Promise<ProfileKnowledgeView> {
  await asJson(await fetch(`${base}/collections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, name }) })), 'createCollection');
  return getProfileKnowledge();
}

export async function unbindCollection(collectionId: string): Promise<void> {
  const res = await fetch(`${base}/bindings/${encodeURIComponent(collectionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`unbindCollection failed (${res.status})`);
}

export async function ingestText(orgId: string, collectionId: string, title: string, text: string): Promise<ProfileKnowledgeView> {
  await asJson(await fetch(`${base}/collections/${encodeURIComponent(collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, title, text }) })), 'ingestText');
  return getProfileKnowledge();
}

export async function deleteDocument(orgId: string, collectionId: string, documentId: string): Promise<void> {
  const res = await fetch(`${base}/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ method: 'DELETE', headers: jsonHeaders(), body: JSON.stringify({ orgId }) }));
  if (!res.ok) throw new Error(`deleteDocument failed (${res.status})`);
}

export async function retrieve(query: string): Promise<RetrieveResult> {
  return asJson<RetrieveResult>(await fetch(`${base}/retrieve`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ query }) })), 'retrieve');
}
