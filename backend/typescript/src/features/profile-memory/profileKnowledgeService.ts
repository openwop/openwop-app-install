/**
 * Personal knowledge curation service (ADR 0042) — the human counterpart of the
 * agent-knowledge service (ADR 0038), and a thin composition over EXISTING owners
 * (no new store, no parallel architecture):
 *
 *   - Documents (cited) → a KB collection BOUND to the user (`kbService`, ADR 0011).
 *   - The binding         → `Profile.knowledge.collectionIds` (a REFERENCE; the
 *                           descriptive Profile record never holds document bytes).
 *   - Notes (recalled)    → the user's `user:<id>` memory namespace (ADR 0041).
 *   - Retrieval           → the SHARED `resolveSubjectKnowledgeRetrieve` (ADR 0042),
 *                           the same composition agents use.
 *
 * Authority is self-ownership: the route resolves the caller's own `userId`, so a
 * caller only ever curates their own knowledge. Tenant isolation (CTI-1) is each
 * owner's job — every call threads the caller's `tenantId`.
 *
 * @see docs/adr/0042-human-knowledge-binding.md
 */

import { OpenwopError } from '../../types.js';
import { getOrCreateProfile, setProfileKnowledge, type Profile } from '../profiles/profilesService.js';
import {
  createCollection,
  getCollection,
  ingestDocument,
  listDocuments,
  deleteDocument,
  listAllTenantCollections,
} from '../kb/kbService.js';
import { createSubjectMemoryPort, subjectMemoryScope, countSubjectNotes } from '../../host/subjectMemory.js';
import { resolveSubjectKnowledgeRetrieve } from '../../host/agentKnowledgeComposition.js';

/** Per-profile binding cap (mirrors the agent BINDING_CAP). */
const BINDING_CAP = 20;

/** The acting user as a memory subject (ADR 0041). */
const userSubject = (userId: string) => ({ kind: 'user' as const, id: userId });

export interface BoundCollection {
  collectionId: string;
  orgId: string;
  name: string;
  documentCount: number;
  chunkCount: number;
}

export interface ProfileKnowledgeView {
  userId: string;
  collections: Array<BoundCollection & { documents: Awaited<ReturnType<typeof listDocuments>> }>;
  noteCount: number;
}

/** Resolve a bound collection across the tenant's orgs (the binding stores only
 *  the collectionId; KB keys are tenant+org+collection). */
async function findBoundCollection(tenantId: string, collectionId: string): Promise<BoundCollection | null> {
  const all = await listAllTenantCollections(tenantId);
  const col = all.find((c) => c.collectionId === collectionId);
  if (!col) return null;
  return { collectionId: col.collectionId, orgId: col.orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount };
}

async function mustOwnedCollectionBound(
  profile: Profile,
  tenantId: string,
  orgId: string,
  collectionId: string,
): Promise<void> {
  if (!(profile.knowledge?.collectionIds ?? []).includes(collectionId)) {
    throw new OpenwopError('not_found', 'Collection is not bound to your profile.', 404, { collectionId });
  }
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
}

/** The caller's full knowledge view (collections + docs + note count). Self-heals
 *  a dangling binding (a collection deleted via the kb feature) on read. */
export async function getProfileKnowledge(tenantId: string, userId: string): Promise<ProfileKnowledgeView> {
  const profile = await getOrCreateProfile(tenantId, userId);
  const collectionIds = profile.knowledge?.collectionIds ?? [];
  const byId = new Map((await listAllTenantCollections(tenantId)).map((c) => [c.collectionId, c]));
  const collections: ProfileKnowledgeView['collections'] = [];
  const liveIds: string[] = [];
  for (const collectionId of collectionIds) {
    const col = byId.get(collectionId);
    if (!col) continue; // a deleted collection self-heals out of the view
    liveIds.push(collectionId);
    const documents = await listDocuments(tenantId, col.orgId, collectionId);
    collections.push({ collectionId: col.collectionId, orgId: col.orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount, documents });
  }
  // Self-heal: a collection deleted via the kb feature leaves a dangling binding.
  // Prune it on read (a write-on-read, like the agent-knowledge path). Idempotent
  // — concurrent reads converge on the same `liveIds`, so the write is safe.
  if (liveIds.length < collectionIds.length) {
    await setProfileKnowledge(tenantId, userId, { collectionIds: liveIds });
  }
  const noteCount = await countSubjectNotes(tenantId, userSubject(userId));
  return { userId, collections, noteCount };
}

/** Bind an EXISTING collection (owned by the caller's tenant) to the profile. */
export async function bindCollection(tenantId: string, userId: string, collectionId: string): Promise<void> {
  const found = await findBoundCollection(tenantId, collectionId);
  if (!found) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  const profile = await getOrCreateProfile(tenantId, userId);
  const current = profile.knowledge?.collectionIds ?? [];
  if (current.includes(collectionId)) return;
  if (current.length >= BINDING_CAP) {
    throw new OpenwopError('validation_error', `Your profile already has the maximum ${BINDING_CAP} bound collections. Unbind one first.`, 400, { cap: BINDING_CAP });
  }
  await setProfileKnowledge(tenantId, userId, { collectionIds: [...current, collectionId] });
}

/** Create a NEW collection (org-scoped) and bind it to the profile. */
export async function createBoundCollection(
  tenantId: string,
  orgId: string,
  actor: string,
  userId: string,
  input: { name?: unknown; description?: unknown },
): Promise<BoundCollection> {
  const col = await createCollection(tenantId, orgId, actor, input);
  await bindCollection(tenantId, userId, col.collectionId);
  return { collectionId: col.collectionId, orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount };
}

/** Unbind a collection from the profile (does NOT delete the KB collection). */
export async function unbindCollection(tenantId: string, userId: string, collectionId: string): Promise<void> {
  const profile = await getOrCreateProfile(tenantId, userId);
  const current = profile.knowledge?.collectionIds ?? [];
  if (!current.includes(collectionId)) {
    throw new OpenwopError('not_found', 'Collection is not bound to your profile.', 404, { collectionId });
  }
  await setProfileKnowledge(tenantId, userId, { collectionIds: current.filter((id) => id !== collectionId) });
}

/** Ingest a document (pasted text or a Media-asset token) into a bound collection
 *  → cited RAG (ADR 0011). The collection MUST already be bound. */
export async function ingestDocToProfile(
  tenantId: string,
  orgId: string,
  actor: string,
  userId: string,
  collectionId: string,
  input: { title?: unknown; text?: unknown; mediaToken?: unknown },
): Promise<Awaited<ReturnType<typeof ingestDocument>>> {
  const profile = await getOrCreateProfile(tenantId, userId);
  await mustOwnedCollectionBound(profile, tenantId, orgId, collectionId);
  return ingestDocument(tenantId, orgId, actor, collectionId, input);
}

/** Delete a document from a bound collection. */
export async function deleteDocFromProfile(
  tenantId: string,
  orgId: string,
  userId: string,
  collectionId: string,
  documentId: string,
): Promise<void> {
  const profile = await getOrCreateProfile(tenantId, userId);
  await mustOwnedCollectionBound(profile, tenantId, orgId, collectionId);
  await deleteDocument(tenantId, orgId, collectionId, documentId);
}

/** Read-only retrieval over the caller's OWN bound knowledge — cited KB chunks +
 *  personal memory facts for `query`, via the shared subject composition (ADR
 *  0042). Tenant-scoped; never writes. Proves the corpus end-to-end (the human
 *  reads their own twin corpus; a twin AGENT reading it is ADR 0043). */
export async function retrieveForProfile(
  tenantId: string,
  userId: string,
  query: string,
): Promise<{ chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust: 'trusted' | 'untrusted' }>; hasResults: boolean }> {
  const profile = await getOrCreateProfile(tenantId, userId);
  const memory = createSubjectMemoryPort(tenantId);
  const retrieve = resolveSubjectKnowledgeRetrieve(tenantId, profile.knowledge, memory, subjectMemoryScope(userSubject(userId)));
  if (!retrieve) return { chunks: [], hasResults: false };
  const out = await retrieve(query);
  return {
    chunks: out.map((c) => ({ content: c.content, ...(c.title ? { title: c.title } : {}), kind: c.kind, contentTrust: c.contentTrust === 'untrusted' ? 'untrusted' : 'trusted' })),
    hasResults: out.length > 0,
  };
}
