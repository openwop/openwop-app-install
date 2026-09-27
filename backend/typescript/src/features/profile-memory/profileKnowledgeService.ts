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
import { mayPruneKnowledgeBinding } from '../../host/knowledgeBindingPrune.js';
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
import { PREAUTHORIZED_CALLER, type SubjectCaller } from '../../host/subjectAccess.js'; // KBC-1 — `PREAUTHORIZED_CALLER` only for the EXISTENCE listing that feeds the prune (see `getProfileKnowledge`)
import type { KnowledgeSourceKind } from '../../host/agentDispatch.js';

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
  /** TWIN-UX-10 — a leg of this read failed. The shared empty state cannot tell
   *  "you bound nothing" from "we could not read it", so say which. */
  degraded?: boolean;
}

/** Resolve a bound collection across the tenant's orgs (the binding stores only
 *  the collectionId; KB keys are tenant+org+collection). */
async function findBoundCollection(tenantId: string, collectionId: string, caller: SubjectCaller): Promise<BoundCollection | null> {
  const all = await listAllTenantCollections(tenantId, caller); // KBC-1 / R3 Blocker 2 — the profile OWNER's principal, every lane
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
  // ADR 0643 R3 (Blocker 2) — every profile-memory lane KNOWS its principal (the profile
  // owner is the binder AND the reader), so it re-resolves at use, never PREAUTHORIZED:
  // a binding to a project corpus the owner has since left stops resolving here.
  const col = await getCollection(tenantId, orgId, collectionId, { subject: profile.userId }); // KBC-1
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
}

/** The caller's full knowledge view (collections + docs + note count). Self-heals
 *  a dangling binding (a collection deleted via the kb feature) on read. */
export async function getProfileKnowledge(tenantId: string, userId: string): Promise<ProfileKnowledgeView> {
  const profile = await getOrCreateProfile(tenantId, userId);
  const collectionIds = profile.knowledge?.collectionIds ?? [];
  // TWIN-UX-10 — the listing is only AUTHORITATIVE if it actually resolved. A
  // throw used to propagate (a 500, no prune), which was fine; what was NOT fine
  // is that the prune below could not tell an authoritative answer from a
  // degraded one, and it is a DURABLE WRITE on a GET. A `listForTenant` scan
  // reads a secondary index, so an empty or partial answer is possible without a
  // throw — and the failure mode is "a GET permanently unbinds the user's
  // documents and renders the shared empty state," i.e. absence-is-a-claim with a
  // write attached.
  let listing: Awaited<ReturnType<typeof listAllTenantCollections>>;
  let authoritative = true;
  try {
    // R3 Blocker 2 — EXISTENCE only (this listing feeds the prune below, and a
    // caller-filtered listing would durably UNBIND what the owner cannot currently
    // read). VISIBILITY is re-resolved per collection with the OWNER's principal.
    listing = await listAllTenantCollections(tenantId, PREAUTHORIZED_CALLER); // KBC-1 — existence only
  } catch {
    listing = [];
    authoritative = false;
  }
  const byId = new Map(listing.map((c) => [c.collectionId, c]));
  const collections: ProfileKnowledgeView['collections'] = [];
  const liveIds: string[] = [];
  let degraded = !authoritative;
  for (const collectionId of collectionIds) {
    const col = byId.get(collectionId);
    if (!col) continue; // a deleted collection self-heals out of the view (below)
    liveIds.push(collectionId);
    if (!(await getCollection(tenantId, col.orgId, collectionId, { subject: userId }))) continue; // R3 Blocker 2 — bound, but no longer the owner's to read
    try {
      const documents = await listDocuments(tenantId, col.orgId, collectionId, { subject: userId }); // KBC-1 — the owner's principal
      collections.push({ collectionId: col.collectionId, orgId: col.orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount, documents });
    } catch {
      // The collection EXISTS — only its document list could not be read. Render
      // it (so it is not mistaken for unbound) and mark the view degraded.
      degraded = true;
      collections.push({ collectionId: col.collectionId, orgId: col.orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount, documents: [] });
    }
  }
  // Self-heal: a collection deleted via the kb feature leaves a dangling binding.
  // Prune it on read (a write-on-read, like the agent-knowledge path). Idempotent
  // — concurrent reads converge on the same `liveIds`, so the write is safe.
  //
  // GUARDED (TWIN-UX-10). NEVER prune when the listing did not resolve, or when it
  // came back EMPTY while the profile HAS bindings — see
  // `host/knowledgeBindingPrune.ts`, which now owns that rule for all three
  // features that self-heal a binding this way (`ADR 0603 R1 H1` found the two
  // siblings still unguarded and moved the rule out of this file rather than
  // hand-copying it a third time). Behaviour here is unchanged.
  if (mayPruneKnowledgeBinding({ boundIds: collectionIds, listingSize: listing.length, liveIds, authoritative })) {
    await setProfileKnowledge(tenantId, userId, { collectionIds: liveIds });
  }
  const noteCount = await countSubjectNotes(tenantId, userSubject(userId));
  return { userId, collections, noteCount, ...(degraded ? { degraded: true } : {}) };
}

/** Bind an EXISTING collection (owned by the caller's tenant) to the profile. */
export async function bindCollection(tenantId: string, userId: string, collectionId: string): Promise<void> {
  // ADR 0643 R3 (Blocker 2) — the BIND door resolves the OWNER (who is the binder here)
  // against the collection's subject; a non-member cannot launder a bound corpus.
  const found = await findBoundCollection(tenantId, collectionId, { subject: userId });
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
  return ingestDocument(tenantId, orgId, actor, collectionId, input, {}, { subject: userId }); // KBC-1 / R3 Blocker 2 — the owner's principal
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
  await deleteDocument(tenantId, orgId, collectionId, documentId, { subject: userId }); // KBC-1 / R3 Blocker 2 — the owner's principal
}

/** Read-only retrieval over the caller's OWN bound knowledge — cited KB chunks +
 *  personal memory facts for `query`, via the shared subject composition (ADR
 *  0042). Tenant-scoped; never writes. Proves the corpus end-to-end (the human
 *  reads their own twin corpus; a twin AGENT reading it is ADR 0043). */
export async function retrieveForProfile(
  tenantId: string,
  userId: string,
  query: string,
): Promise<{ chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust: 'trusted' | 'untrusted' }>; hasResults: boolean; failedSources: KnowledgeSourceKind[] }> {
  const profile = await getOrCreateProfile(tenantId, userId);
  const memory = createSubjectMemoryPort(tenantId);
  const retrieve = resolveSubjectKnowledgeRetrieve(tenantId, profile.knowledge, memory, subjectMemoryScope(userSubject(userId)), { subject: userId }); // R3 Blocker 2 — the owner reads as themselves
  if (!retrieve) return { chunks: [], hasResults: false, failedSources: [] };
  // KB-UX-3 / ADR 0583 — see `retrieveForAgent`: a swallowed per-source fault
  // must not reach the panel as "No matches".
  const failedSources: KnowledgeSourceKind[] = [];
  const out = await retrieve(query, (s) => { if (!failedSources.includes(s)) failedSources.push(s); });
  return {
    chunks: out.map((c) => ({ content: c.content, ...(c.title ? { title: c.title } : {}), kind: c.kind, contentTrust: c.contentTrust === 'untrusted' ? 'untrusted' : 'trusted' })),
    hasResults: out.length > 0,
    failedSources,
  };
}
