/**
 * Personal Knowledge client (ADR 0042) — the human counterpart of the agent
 * knowledge client. Drives /host/openwop-app/profiles/me/knowledge: view, bind /
 * create / unbind a KB collection, ingest a text document, delete a document, and a
 * read-only retrieve over the caller's OWN corpus (bound docs + personal notes).
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { apiErrorFrom } from '../../client/errorEnvelope.js';
import i18n from '../../i18n/index.js';

export interface KnowledgeDoc { documentId: string; title: string; chunkCount: number; createdAt: string; contentTrust?: 'trusted' | 'untrusted' }
export interface KnowledgeCollection { collectionId: string; orgId: string; name: string; documentCount: number; chunkCount: number; documents: KnowledgeDoc[] }
export interface ProfileKnowledgeView { userId: string; collections: KnowledgeCollection[]; noteCount: number }
/** `failedSources` (ADR 0583 / KB-UX-3) — see `projectKnowledgeClient`: the
 *  composition's per-source fault is swallowed for the run, so without this a
 *  backend error and an empty corpus were the same value and the panel said
 *  "No matches" for both. Non-empty ⇒ the answer is PARTIAL. */
export interface RetrieveResult { chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust?: 'trusted' | 'untrusted' }>; hasResults: boolean; failedSources?: Array<'kb' | 'memory'> }
export interface Org { orgId: string; name: string }

const base = `${config.baseUrl}/host/openwop-app/profiles/me/knowledge`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

// TWIN-UX-6 — localize at the throw site; prefer the backend's own prose (this
// surface's most useful message is the binding cap: "Your profile already has the
// maximum 20 bound collections. Unbind one first.").
async function asJson<T>(res: Response, fallbackKey: string): Promise<T> {
  if (!res.ok) throw await apiErrorFrom(res, i18n.t(`knowledge:${fallbackKey}`, { status: res.status }));
  return res.json() as Promise<T>;
}

export async function getProfileKnowledge(): Promise<ProfileKnowledgeView> {
  return asJson<ProfileKnowledgeView>(await fetch(base, fetchOpts({ headers: authedHeaders() })), 'loadError');
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'loadError')).orgs;
}

export async function createCollection(orgId: string, name: string): Promise<ProfileKnowledgeView> {
  await asJson(await fetch(`${base}/collections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, name }) })), 'actionError');
  return getProfileKnowledge();
}

export async function unbindCollection(collectionId: string): Promise<void> {
  const res = await fetch(`${base}/bindings/${encodeURIComponent(collectionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw await apiErrorFrom(res, i18n.t('knowledge:actionError'));
}

export async function ingestText(orgId: string, collectionId: string, title: string, text: string): Promise<ProfileKnowledgeView> {
  await asJson(await fetch(`${base}/collections/${encodeURIComponent(collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, title, text }) })), 'actionError');
  return getProfileKnowledge();
}

export async function deleteDocument(orgId: string, collectionId: string, documentId: string): Promise<void> {
  const res = await fetch(`${base}/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ method: 'DELETE', headers: jsonHeaders(), body: JSON.stringify({ orgId }) }));
  if (!res.ok) throw await apiErrorFrom(res, i18n.t('knowledge:actionError'));
}

export async function retrieve(query: string): Promise<RetrieveResult> {
  return asJson<RetrieveResult>(await fetch(`${base}/retrieve`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ query }) })), 'actionError');
}
