/**
 * Agent-knowledge curation service (ADR 0038) — the thin composition layer over
 * three EXISTING owners; it adds no new store and no parallel architecture:
 *
 *   - Documents (file / long paste) → a KB collection BOUND to the agent
 *     (`kbService`, ADR 0011 — chunked, embedded, cited, org-scoped/shareable).
 *   - Notes / facts (short text)      → the agent's RFC-0004 memory namespace
 *     (`agentMemoryAdapter`, `agent:<id>` — private, auto-recalled by dispatch).
 *   - The binding + capability        → `agentProfile.knowledge` + the core
 *     `knowledge` capability (`agentProfileService`).
 *
 * One mental model ("Agent Knowledge"), two honest backings. Tenant isolation
 * (CTI-1) is enforced by each owner — every call threads the caller's `tenantId`.
 * The route layer enforces toggle + RBAC + `requireOwnedAgent` IDOR + ADR 0036
 * policy BEFORE any method here runs (fail-closed).
 *
 * @see docs/adr/0038-per-agent-knowledge-memory.md
 */

import { OpenwopError } from '../../types.js';
import type { AgentProfile } from '../../types.js';
import {
  getAgentProfile,
  setAgentKnowledge,
} from '../../host/agentProfileService.js';
import { createAgentMemoryPort, agentMemoryScope } from '../../host/agentMemoryAdapter.js';
import {
  addSubjectNote,
  listSubjectNotes,
  removeSubjectNote,
  countSubjectNotes,
  type SubjectNote,
} from '../../host/subjectMemory.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { fetchKnowledgeSource } from '../../host/knowledgeSourceFetch.js';
import type { Storage } from '../../storage/storage.js';
import {
  createCollection,
  getCollection,
  ingestDocument,
  listDocuments,
  deleteDocument,
  listAllTenantCollections,
} from '../kb/kbService.js';
import { resolveAgentKnowledgeRetrieve } from '../../host/agentKnowledgeComposition.js';

/** A bound knowledge collection projected for the curation UI. */
export interface BoundCollection {
  collectionId: string;
  orgId: string;
  name: string;
  documentCount: number;
  chunkCount: number;
}

/** The full curation view for one agent: its capability flag, bound collections
 *  (with the docs in each), the private-note count, and the binding knobs. */
export interface AgentKnowledgeView {
  agentId: string;
  knowledgeEnabled: boolean;
  memoryWritable: boolean;
  collections: Array<BoundCollection & { documents: Awaited<ReturnType<typeof listDocuments>> }>;
  noteCount: number;
}

/** A minimal autonomy init for a freshly-created profile: inherit the agent's
 *  roster `roleKey` (so a lazily-created profile doesn't diverge from the roster —
 *  ADR 0036 policy/derivation reads `roleKey`), and the most-restrictive autonomy
 *  (draft-only) so binding knowledge never silently widens an agent's autonomy.
 *  Falls back to `'unknown'` only when the agent has no roster entry. */
async function profileInitFor(agentId: string): Promise<{ roleKey: string; autonomy: { specLevel: 'draft-only' } }> {
  const entry = await getRosterEntry(agentId);
  return { roleKey: entry?.roleKey ?? 'unknown', autonomy: { specLevel: 'draft-only' } };
}

/** Curated notes (NOTE_TAG, NOTE_CAP) are owned by `host/subjectMemory.ts` (ADR
 *  0041) so agents and humans share one validator + cap. This feature owns only
 *  the agent-specific binding cap below. */
const BINDING_CAP = 20;

/** An agent is just a `MemorySubject` of kind `agent` (ADR 0041). */
const agentSubject = (agentId: string) => ({ kind: 'agent' as const, id: agentId });

async function mustOwnedCollectionBound(
  tenantId: string,
  profile: AgentProfile | null,
  orgId: string,
  collectionId: string,
): Promise<void> {
  if (!profile || !(profile.knowledge?.collectionIds ?? []).includes(collectionId)) {
    throw new OpenwopError('not_found', 'Collection is not bound to this agent.', 404, { collectionId });
  }
  // The collection must also exist + be owned by the caller's tenant/org (the KB
  // service is the IDOR authority; a cross-tenant id simply isn't found).
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
}

/** The agent's full knowledge view (read). The note count + memory live in the
 *  agent's RFC-0004 namespace; collections in KB. The `documents` projection per
 *  collection is what the panel lists with citations. */
export async function getAgentKnowledge(tenantId: string, agentId: string): Promise<AgentKnowledgeView> {
  const profile = await getAgentProfile(tenantId, agentId);
  const knowledgeEnabled = Boolean(profile && (profile.capabilities ?? []).includes('knowledge'));
  const collectionIds = profile?.knowledge?.collectionIds ?? [];

  // The binding is a flat collectionId[] (the ADR data model); KB keys are
  // tenant+org+collection, so each id is resolved back to its org via KB (no
  // second store). Resolve the whole tenant's collections ONCE (not per id — a
  // per-binding full scan), then index by id. A deleted collection self-heals out.
  const byId = new Map((await listAllTenantCollections(tenantId)).map((c) => [c.collectionId, c]));
  const collections: AgentKnowledgeView['collections'] = [];
  const liveIds: string[] = [];
  for (const collectionId of collectionIds) {
    const col = byId.get(collectionId);
    if (!col) continue; // a deleted collection self-heals out of the view
    liveIds.push(collectionId);
    const documents = await listDocuments(tenantId, col.orgId, collectionId);
    collections.push({
      collectionId: col.collectionId,
      orgId: col.orgId,
      name: col.name,
      documentCount: col.documentCount,
      chunkCount: col.chunkCount,
      documents,
    });
  }
  // Self-heal: a collection deleted via the kb feature leaves a dangling binding
  // (functionally inert — retrieval already ignores it — but it accretes). Prune
  // the dead ids from the stored profile binding on read.
  if (profile && liveIds.length < collectionIds.length) {
    await setAgentKnowledge(tenantId, agentId, { collectionIds: liveIds }, await profileInitFor(agentId));
  }

  // Count ONLY user-curated notes — dispatch turn summaries share this namespace
  // (written with tag `[agentId]`), so an unfiltered count would inflate and grow
  // every run. Tag-aware count via the shared subject-memory module (ADR 0041).
  const noteCount = await countSubjectNotes(tenantId, agentSubject(agentId));

  return {
    agentId,
    knowledgeEnabled,
    memoryWritable: Boolean(profile?.knowledge?.memoryWritable),
    collections,
    noteCount,
  };
}

/** Resolve a bound collection across the tenant's orgs (a binding stores only the
 *  collectionId per the ADR data model; KB keys are tenant+org+collection). */
async function findBoundCollection(tenantId: string, collectionId: string): Promise<BoundCollection | null> {
  // getCollection needs an orgId; the binding stores only the id (the ADR data
  // model). Recover the org via KB's tenant-wide list (single source of truth).
  const all = await listAllTenantCollections(tenantId);
  const col = all.find((c) => c.collectionId === collectionId);
  if (!col) return null;
  return {
    collectionId: col.collectionId,
    orgId: col.orgId,
    name: col.name,
    documentCount: col.documentCount,
    chunkCount: col.chunkCount,
  };
}

/** Ingest a document into a collection BOUND to the agent, resolving the org from
 *  the binding (no orgId supplied). Used by the workflow/trigger **ingest node**
 *  (ADR 0038 §B): a trigger (RFC 0099 webhook/email/form) → workflow → this →
 *  cited KB document. Writes the **KB-document side only** — the agent's RFC-0004
 *  memory/notes namespace stays read-only/user-curated (ADR 0038 §9), so this is a
 *  host-extension feature write (no RFC), NOT a `ctx.memory` write. The collection
 *  MUST be bound; cross-tenant is impossible (`tenantId` is scope-baked). */
export async function ingestDocToBoundCollection(
  tenantId: string,
  actor: string,
  agentId: string,
  collectionId: string,
  input: { title?: unknown; text?: unknown; contentTrust?: 'trusted' | 'untrusted' },
): Promise<Awaited<ReturnType<typeof ingestDocument>>> {
  const found = await findBoundCollection(tenantId, collectionId);
  if (!found) throw new OpenwopError('not_found', 'Bound collection not found.', 404, { collectionId });
  const profile = await getAgentProfile(tenantId, agentId);
  await mustOwnedCollectionBound(tenantId, profile, found.orgId, collectionId);
  return ingestDocument(tenantId, found.orgId, actor, collectionId, input);
}

/** Create a NEW KB collection for this agent and bind it (the "create a source"
 *  affordance). Pure reuse of `kbService.createCollection` + a binding patch. */
export async function createBoundCollection(
  tenantId: string,
  orgId: string,
  actor: string,
  agentId: string,
  input: { name?: unknown; description?: unknown },
): Promise<BoundCollection> {
  const col = await createCollection(tenantId, orgId, actor, input);
  await bindCollection(tenantId, agentId, col.collectionId);
  return { collectionId: col.collectionId, orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount };
}

/** Bind an EXISTING KB collection (owned by the caller's tenant) to the agent.
 *  Idempotent; activates the `knowledge` capability. */
export async function bindCollection(tenantId: string, agentId: string, collectionId: string): Promise<void> {
  const found = await findBoundCollection(tenantId, collectionId);
  if (!found) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  const profile = await getAgentProfile(tenantId, agentId);
  const current = profile?.knowledge?.collectionIds ?? [];
  if (current.includes(collectionId)) return;
  if (current.length >= BINDING_CAP) {
    throw new OpenwopError('validation_error', `This agent already has the maximum ${BINDING_CAP} bound collections. Unbind one first.`, 400, { cap: BINDING_CAP });
  }
  await setAgentKnowledge(tenantId, agentId, { collectionIds: [...current, collectionId] }, await profileInitFor(agentId));
}

/** Unbind a collection from the agent (does NOT delete the KB collection — it
 *  may be shared by other twins). */
export async function unbindCollection(tenantId: string, agentId: string, collectionId: string): Promise<void> {
  const profile = await getAgentProfile(tenantId, agentId);
  const current = profile?.knowledge?.collectionIds ?? [];
  if (!current.includes(collectionId)) {
    throw new OpenwopError('not_found', 'Collection is not bound to this agent.', 404, { collectionId });
  }
  await setAgentKnowledge(tenantId, agentId, { collectionIds: current.filter((id) => id !== collectionId) }, await profileInitFor(agentId));
}

/** Ingest a document (pasted text or a Media-asset token) into a bound
 *  collection → cited RAG (ADR 0011). The collection MUST already be bound. */
export async function ingestDocToAgent(
  tenantId: string,
  orgId: string,
  actor: string,
  agentId: string,
  collectionId: string,
  input: { title?: unknown; text?: unknown; mediaToken?: unknown },
): Promise<Awaited<ReturnType<typeof ingestDocument>>> {
  const profile = await getAgentProfile(tenantId, agentId);
  await mustOwnedCollectionBound(tenantId, profile, orgId, collectionId);
  return ingestDocument(tenantId, orgId, actor, collectionId, input);
}

/** Import a document from the acting user's connected provider (e.g. Google
 *  Drive) into a bound collection → cited RAG (ADR 0038 follow-on). Fetches via
 *  the host knowledge-source seam (Connections broker + brokeredFetch, apiHosts-
 *  pinned), then reuses `ingestDocument` — no new ingest path. The collection
 *  MUST already be bound; `actor` MUST be a real acting user (the broker withholds
 *  the connection for a system/no-user caller → fail-closed `credential_required`). */
export async function ingestFromConnection(
  storage: Storage,
  tenantId: string,
  orgId: string,
  actor: string,
  agentId: string,
  collectionId: string,
  input: { provider?: unknown; ref?: unknown },
): Promise<Awaited<ReturnType<typeof ingestDocument>>> {
  const profile = await getAgentProfile(tenantId, agentId);
  await mustOwnedCollectionBound(tenantId, profile, orgId, collectionId);
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
  if (!provider) throw new OpenwopError('validation_error', 'Field `provider` is required.', 400, { field: 'provider' });
  if (!ref) throw new OpenwopError('validation_error', 'Field `ref` is required.', 400, { field: 'ref' });
  const fetched = await fetchKnowledgeSource({ storage, tenantId, actingUserId: actor, orgId }, { provider, ref });
  // Provider-derived content is UNTRUSTED (ADR 0038 §C / RFC 0021 — matches the
  // assistant model that stamps Drive/Gmail as untrusted). Dispatch fences it on
  // retrieval; it is never injected as agent-trusted.
  return ingestDocument(tenantId, orgId, actor, collectionId, { title: fetched.title, text: fetched.text, contentTrust: 'untrusted' });
}

/** Delete a document from a bound collection. */
export async function deleteDocFromAgent(
  tenantId: string,
  orgId: string,
  agentId: string,
  collectionId: string,
  documentId: string,
): Promise<void> {
  const profile = await getAgentProfile(tenantId, agentId);
  await mustOwnedCollectionBound(tenantId, profile, orgId, collectionId);
  await deleteDocument(tenantId, orgId, collectionId, documentId);
}

/** Add a private note/fact to the agent's RFC-0004 memory namespace (recalled by
 *  dispatch). Gated on `memoryWritable` being set on the binding (the user opted
 *  the agent in to curated notes). Writes are host-internal, NOT a wire write
 *  (ADR 0038 §9 / RFC 0004 — `ctx.memory` stays read-only). */
export async function addNote(tenantId: string, agentId: string, content: string): Promise<void> {
  const profile = await getAgentProfile(tenantId, agentId);
  if (!profile?.knowledge?.memoryWritable) {
    throw new OpenwopError(
      'forbidden_scope',
      'Curated notes are disabled for this agent. Enable `memoryWritable` first.',
      403,
      { agentId },
    );
  }
  // Validation + per-subject cap + durable+embedded write are owned by the shared
  // subject-memory seam (ADR 0041) — identical for agents and humans.
  await addSubjectNote(tenantId, agentSubject(agentId), content);
}

/** List the agent's curated notes (newest first) for the memory browser (ADR
 *  0041) — excludes dispatch turn summaries; durable source. */
export function listAgentNotes(tenantId: string, agentId: string): Promise<SubjectNote[]> {
  return listSubjectNotes(tenantId, agentSubject(agentId));
}

/** Remove a curated note by id. Only a curated note is removable (a dispatch
 *  turn-summary in the same namespace is not). Resolves false when none matched. */
export function removeAgentNote(tenantId: string, agentId: string, noteId: string): Promise<boolean> {
  return removeSubjectNote(tenantId, agentSubject(agentId), noteId);
}

/** Set the `memoryWritable` knob on the binding (opt the agent in/out of curated
 *  notes). Activates the `knowledge` capability. */
export async function setMemoryWritable(tenantId: string, agentId: string, writable: boolean): Promise<void> {
  await setAgentKnowledge(tenantId, agentId, { memoryWritable: writable }, await profileInitFor(agentId));
}

/** Read-only retrieval over the agent's bound knowledge (the `ctx.features
 *  .agentKnowledge.retrieve` surface, ADR 0038 §3 / ADR 0014). Returns cited KB
 *  chunks + private memory facts for `query`. Tenant-scoped; never writes. */
export async function retrieveForAgent(
  tenantId: string,
  agentId: string,
  query: string,
): Promise<{ chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust: 'trusted' | 'untrusted' }>; hasResults: boolean }> {
  const memory = createAgentMemoryPort(tenantId);
  const retrieve = await resolveAgentKnowledgeRetrieve(tenantId, agentId, memory, agentMemoryScope(agentId));
  if (!retrieve) return { chunks: [], hasResults: false };
  const out = await retrieve(query);
  return {
    chunks: out.map((c) => ({
      content: c.content,
      ...(c.title ? { title: c.title } : {}),
      kind: c.kind,
      contentTrust: c.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
    })),
    hasResults: out.length > 0,
  };
}
