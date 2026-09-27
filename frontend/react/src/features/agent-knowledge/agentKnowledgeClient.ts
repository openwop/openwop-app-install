/**
 * Agent Knowledge API client (ADR 0038). Per-agent knowledge curation under
 * /host/openwop-app/agents/:id/knowledge — bind/create KB collections (cited
 * documents), ingest documents, add private notes (recalled memory), and a
 * read-only retrieve. Every route is toggle + RBAC + IDOR + profile-policy gated
 * server-side; the client surfaces the server's message on a non-2xx.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

/** A bound KB collection with its documents (for the panel listing). */
export interface BoundCollectionDoc {
  documentId: string;
  title: string;
  source: { kind: 'text' } | { kind: 'media' };
  chunkCount: number;
  createdAt: string;
  /** Content-trust provenance (ADR 0038 §C). `'untrusted'` = provider/trigger-
   *  derived (Google Drive import, webhook auto-ingest) → fenced when the agent
   *  reads it, never followed as instructions. Absent ⇒ trusted (manual). */
  contentTrust?: 'trusted' | 'untrusted';
}
export interface BoundCollection {
  collectionId: string;
  orgId: string;
  name: string;
  documentCount: number;
  chunkCount: number;
  documents: BoundCollectionDoc[];
}

export interface AgentKnowledgeView {
  agentId: string;
  knowledgeEnabled: boolean;
  memoryWritable: boolean;
  collections: BoundCollection[];
  noteCount: number;
}

export interface RetrieveResult {
  chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust?: 'trusted' | 'untrusted' }>;
  hasResults: boolean;
  /** ADR 0583 / KB-UX-3 — the sources whose retrieval leg FAULTED. The server
   *  composition swallows these so a live agent turn survives, which made
   *  `hasResults:false` indistinguishable from an empty corpus; this panel used
   *  to render an internal error as "No matches". Non-empty ⇒ PARTIAL answer. */
  failedSources?: Array<'kb' | 'memory'>;
}

const base = (agentId: string): string =>
  `${config.baseUrl}/host/openwop-app/agents/${encodeURIComponent(agentId)}/knowledge`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getAgentKnowledge(agentId: string): Promise<AgentKnowledgeView> {
  const res = await fetch(base(agentId), fetchOpts({ headers: authedHeaders() }));
  return asJson<AgentKnowledgeView>(res, 'getAgentKnowledge');
}

export async function createBoundCollection(agentId: string, orgId: string, name: string, description?: string): Promise<unknown> {
  const res = await fetch(`${base(agentId)}/collections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, name, ...(description ? { description } : {}) }) }));
  return asJson<unknown>(res, 'createBoundCollection');
}

export async function bindCollection(agentId: string, collectionId: string): Promise<AgentKnowledgeView> {
  const res = await fetch(`${base(agentId)}/bindings`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ collectionId }) }));
  return asJson<AgentKnowledgeView>(res, 'bindCollection');
}

export async function unbindCollection(agentId: string, collectionId: string): Promise<void> {
  const res = await fetch(`${base(agentId)}/bindings/${encodeURIComponent(collectionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`unbindCollection returned ${res.status}`);
}

export async function ingestText(agentId: string, orgId: string, collectionId: string, title: string, text: string): Promise<unknown> {
  const res = await fetch(`${base(agentId)}/collections/${encodeURIComponent(collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, title, text }) }));
  return asJson<unknown>(res, 'ingestText');
}

/** Import a document from the acting user's connected provider (ADR 0038
 *  follow-on). `ref` is a provider link or id (e.g. a Google Drive URL). Fails
 *  closed with `credential_required` (409) when the provider isn't connected. */
export async function importFromConnection(agentId: string, orgId: string, collectionId: string, provider: string, ref: string): Promise<unknown> {
  const res = await fetch(`${base(agentId)}/collections/${encodeURIComponent(collectionId)}/documents/from-connection`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, provider, ref }) }));
  return asJson<unknown>(res, 'importFromConnection');
}

export async function deleteDocument(agentId: string, orgId: string, collectionId: string, documentId: string): Promise<void> {
  const res = await fetch(`${base(agentId)}/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ method: 'DELETE', headers: jsonHeaders(), body: JSON.stringify({ orgId }) }));
  if (!res.ok) throw new Error(`deleteDocument returned ${res.status}`);
}

export async function setMemoryWritable(agentId: string, writable: boolean): Promise<AgentKnowledgeView> {
  const res = await fetch(`${base(agentId)}/memory-writable`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ writable }) }));
  return asJson<AgentKnowledgeView>(res, 'setMemoryWritable');
}

export async function addNote(agentId: string, content: string): Promise<AgentKnowledgeView> {
  const res = await fetch(`${base(agentId)}/notes`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ content }) }));
  return asJson<AgentKnowledgeView>(res, 'addNote');
}

/** A curated memory entry (ADR 0041) — the row the Memory tab lists. */
export interface MemoryNote {
  id: string;
  content: string;
  contentTrust: 'trusted' | 'untrusted';
  /** ADR 0587 provenance. Absent on rows written before the field existed. */
  source?: 'user' | 'auto-extract';
  createdAt: string;
}

/**
 * List the agent's curated memories AND the MEM-UX-1 recall-only count — ONE
 * request, because the route already returns both in one response.
 *
 * REPLACES a `listNotes()` + `countNotesRecallOnly()` pair that hit the identical
 * URL twice from two separate effects (review finding F5). See the twin docblock
 * on `profileMemoryClient.listMemoriesWithRecall` for the full reasoning; the
 * short version is that each extra call re-runs a full `listMemoryEntries` scan
 * against a per-IP read budget, and two responses can disagree, so the tab could
 * disclose a count computed over a list the user is not looking at.
 *
 * `recallOnlyCount` is `undefined` when the server did not send a number — the
 * caller must then disclose NOTHING rather than assert a zero it never read.
 */
export async function listNotesWithRecall(agentId: string): Promise<{ notes: MemoryNote[]; recallOnlyCount?: number }> {
  const res = await fetch(`${base(agentId)}/notes`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ notes: MemoryNote[]; recallOnlyCount?: number }>(res, 'listNotes');
  return typeof body.recallOnlyCount === 'number'
    ? { notes: body.notes, recallOnlyCount: body.recallOnlyCount }
    : { notes: body.notes };
}

/** List the agent's curated memories (newest first) for the Memory tab. */
export async function listNotes(agentId: string): Promise<MemoryNote[]> {
  return (await listNotesWithRecall(agentId)).notes;
}

/** Delete a curated memory by id. */
export async function deleteNote(agentId: string, noteId: string): Promise<void> {
  const res = await fetch(`${base(agentId)}/notes/${encodeURIComponent(noteId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteNote failed (${res.status})`);
}

export async function retrieve(agentId: string, query: string): Promise<RetrieveResult> {
  const res = await fetch(`${base(agentId)}/retrieve`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ query }) }));
  return asJson<RetrieveResult>(res, 'retrieve');
}

/** Orgs available for creating a collection (reuses the KB orgs list). */
export interface Org { orgId: string; name: string }
export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}
