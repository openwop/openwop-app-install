/**
 * Project knowledge client (ADR 0046 follow-on) — the project counterpart of the
 * profile knowledge client, over the GENERIC subject binding. Drives
 * /v1/host/openwop-app/projects/:id/knowledge: view, create / unbind a KB
 * collection, ingest a text document, delete a document, and a read-only retrieve
 * over the project's corpus (bound docs + project notes).
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface KnowledgeDoc { documentId: string; title: string; chunkCount: number; createdAt: string; contentTrust?: 'trusted' | 'untrusted' }
export interface KnowledgeCollection { collectionId: string; orgId: string; name: string; documentCount: number; chunkCount: number; documents: KnowledgeDoc[] }
export interface ProjectKnowledgeView { projectId: string; collections: KnowledgeCollection[]; noteCount: number }
export interface RetrieveResult { chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust?: 'trusted' | 'untrusted' }>; hasResults: boolean }
export interface Org { orgId: string; name: string }

const baseFor = (projectId: string): string => `${config.baseUrl}/v1/host/openwop-app/projects/${encodeURIComponent(projectId)}/knowledge`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw new Error(`${ctx} failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function getProjectKnowledge(projectId: string): Promise<ProjectKnowledgeView> {
  return asJson<ProjectKnowledgeView>(await fetch(baseFor(projectId), fetchOpts({ headers: authedHeaders() })), 'getProjectKnowledge');
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

export async function createCollection(projectId: string, orgId: string, name: string): Promise<ProjectKnowledgeView> {
  await asJson(await fetch(`${baseFor(projectId)}/collections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, name }) })), 'createCollection');
  return getProjectKnowledge(projectId);
}

export async function unbindCollection(projectId: string, collectionId: string): Promise<void> {
  const res = await fetch(`${baseFor(projectId)}/bindings/${encodeURIComponent(collectionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`unbindCollection failed (${res.status})`);
}

export async function ingestText(projectId: string, orgId: string, collectionId: string, title: string, text: string): Promise<ProjectKnowledgeView> {
  await asJson(await fetch(`${baseFor(projectId)}/collections/${encodeURIComponent(collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, title, text }) })), 'ingestText');
  return getProjectKnowledge(projectId);
}

export async function deleteDocument(projectId: string, orgId: string, collectionId: string, documentId: string): Promise<void> {
  const res = await fetch(`${baseFor(projectId)}/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ method: 'DELETE', headers: jsonHeaders(), body: JSON.stringify({ orgId }) }));
  if (!res.ok) throw new Error(`deleteDocument failed (${res.status})`);
}

export async function retrieve(projectId: string, query: string): Promise<RetrieveResult> {
  return asJson<RetrieveResult>(await fetch(`${baseFor(projectId)}/retrieve`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ query }) })), 'retrieve');
}
