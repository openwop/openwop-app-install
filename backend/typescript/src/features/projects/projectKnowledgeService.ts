/**
 * Project knowledge curation service (ADR 0046 follow-on) — a project's cited
 * documents, the same composition agents/people use, over the GENERIC subject
 * binding (`host/subjectKnowledge.ts`, keyed on `project:<id>`):
 *
 *   - Documents (cited) → a KB collection bound to the project (`kbService`, ADR 0011).
 *   - The binding         → `subjectKnowledge` (a REFERENCE; no bytes on the project).
 *   - Notes (recalled)    → the project's `project:<id>` memory namespace (ADR 0041).
 *   - Retrieval           → the SHARED `resolveSubjectKnowledgeRetrieve` (ADR 0042).
 *
 * No authority of its own (ADR 0045): the route gates on the caller's org scope.
 * Tenant isolation (CTI-1): every call threads the caller's `tenantId`.
 *
 * @see docs/adr/0046-project-subject.md
 */

import { OpenwopError } from '../../types.js';
import {
  createCollection,
  getCollection,
  ingestDocument,
  listDocuments,
  deleteDocument,
  listAllTenantCollections,
} from '../kb/kbService.js';
import { getSubjectKnowledge, setSubjectKnowledge } from '../../host/subjectKnowledge.js';
import { mayPruneKnowledgeBinding } from '../../host/knowledgeBindingPrune.js';
import { createSubjectMemoryPort, subjectMemoryScope, countSubjectNotes } from '../../host/subjectMemory.js';
import { resolveSubjectKnowledgeRetrieve } from '../../host/agentKnowledgeComposition.js';
import { PREAUTHORIZED_CALLER } from '../../host/subjectAccess.js'; // KBC-1 — this feature OWNS the project subject and resolves membership at its own door before it reaches KB
import type { KnowledgeSourceKind } from '../../host/agentDispatch.js';
import { projectSubject, listProjects } from './projectsService.js';
import { type ShareableKbProvider } from '../../host/shareableKb.js';

const BINDING_CAP = 20;

export interface BoundCollection {
  collectionId: string;
  orgId: string;
  name: string;
  documentCount: number;
  chunkCount: number;
}

export interface ProjectKnowledgeView {
  projectId: string;
  collections: Array<BoundCollection & { documents: Awaited<ReturnType<typeof listDocuments>> }>;
  noteCount: number;
}

async function findBoundCollection(tenantId: string, collectionId: string): Promise<BoundCollection | null> {
  const all = await listAllTenantCollections(tenantId, PREAUTHORIZED_CALLER); // KBC-1 — see the module docblock
  const col = all.find((c) => c.collectionId === collectionId);
  if (!col) return null;
  return { collectionId: col.collectionId, orgId: col.orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount };
}

async function mustOwnedCollectionBound(tenantId: string, projectId: string, orgId: string, collectionId: string): Promise<void> {
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  if (!(binding.collectionIds ?? []).includes(collectionId)) {
    throw new OpenwopError('not_found', 'Collection is not bound to this project.', 404, { collectionId });
  }
  const col = await getCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER); // KBC-1
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
}

/** The project's full knowledge view; self-heals a dangling binding on read. */
export async function getProjectKnowledge(tenantId: string, projectId: string): Promise<ProjectKnowledgeView> {
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  const collectionIds = binding.collectionIds ?? [];
  const listing = await listAllTenantCollections(tenantId, PREAUTHORIZED_CALLER); // KBC-1
  const byId = new Map(listing.map((c) => [c.collectionId, c]));
  const collections: ProjectKnowledgeView['collections'] = [];
  const liveIds: string[] = [];
  for (const collectionId of collectionIds) {
    const col = byId.get(collectionId);
    if (!col) continue; // a deleted collection self-heals out of the view
    liveIds.push(collectionId);
    const documents = await listDocuments(tenantId, col.orgId, collectionId, PREAUTHORIZED_CALLER); // KBC-1
    collections.push({ collectionId: col.collectionId, orgId: col.orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount, documents });
  }
  // Self-heal a dangling binding (a referenced collection was deleted out from
  // under us). This is an idempotent prune on a read path — it only ever drops
  // ids that no longer resolve, so a concurrent prune/bind converges (a racing
  // bind re-adds its live id; two prunes compute the same `liveIds`).
  //
  // GUARDED (`ADR 0603 R1 H1`, porting `TWIN-UX-10`). Idempotent is not the same
  // as safe: this is a DURABLE WRITE ON A GET whose premise is "not in the listing
  // ⇒ deleted", and `listAllTenantCollections` reads a secondary index that can
  // answer SHORT or EMPTY without throwing. Unguarded, one corrupt index row
  // overwrote the binding with `[]` — and this binding is what backs a
  // **notebook's** bound KB collections (`notebooksService.ts`), so the blast
  // radius was a notebook silently losing its sources on a read. The shared rule
  // refuses whenever the listing cannot prove a deletion.
  if (mayPruneKnowledgeBinding({ boundIds: collectionIds, listingSize: listing.length, liveIds })) {
    await setSubjectKnowledge(tenantId, projectSubject(projectId), { collectionIds: liveIds });
  }
  // ADR 0608 D4 (`CPC-2`) — NO BACKFILL HERE, and the reason is the finding.
  // A backfill on this read looked obviously safe (an ADDITIVE stamp, never a
  // deletion, so the guarded-prune hazard above does not apply) and even survived
  // being narrowed to collections bound EXCLUSIVELY to this project. It is still
  // unsound, because this function cannot tell a corpus BORN in the project from
  // an org collection the project merely BINDS — and only the first may be
  // narrowed. Measured: with the exclusivity guard in place it still stamped a
  // freshly-bound shared org collection, because `POST /knowledge/bindings`
  // returns this view. RESIDUAL, recorded in ADR 0608 D4: collections created
  // through a project's door BEFORE this change carry no stamp and keep the old
  // org-visible behaviour. Closing that needs creation PROVENANCE on the row,
  // which does not exist yet — not a heuristic on the binding set.
  const noteCount = await countSubjectNotes(tenantId, projectSubject(projectId));
  return { projectId, collections, noteCount };
}

export async function bindCollection(tenantId: string, projectId: string, collectionId: string): Promise<void> {
  const found = await findBoundCollection(tenantId, collectionId);
  if (!found) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  const current = binding.collectionIds ?? [];
  if (current.includes(collectionId)) return;
  if (current.length >= BINDING_CAP) {
    throw new OpenwopError('validation_error', `This project already has the maximum ${BINDING_CAP} bound collections. Unbind one first.`, 400, { cap: BINDING_CAP });
  }
  await setSubjectKnowledge(tenantId, projectSubject(projectId), { collectionIds: [...current, collectionId] });
  // ADR 0608 D4 (`CPC-2`) — DELIBERATELY NOT STAMPED HERE. An earlier revision of
  // this fix did stamp on bind, and it was wrong twice over: (1) an org KB
  // collection that a project merely REFERENCES is still an org resource — binding
  // it must not retroactively narrow who may read it; (2) `boundSubject` names ONE
  // Subject, so a collection bound to two projects took the first project's stamp
  // and became unreachable to EVERYONE when that project was deleted. Measured:
  // `notebooks-delete-honesty.test.ts`'s shared-collection CONTROL went red. The
  // stamp belongs only where the corpus is BORN inside the project
  // (`createBoundCollection`), which is the case the leak was actually about.
}

export async function createBoundCollection(
  tenantId: string,
  orgId: string,
  actor: string,
  projectId: string,
  input: { name?: unknown; description?: unknown },
): Promise<BoundCollection> {
  // Check the binding cap BEFORE creating the collection — otherwise a cap-exceeded
  // create leaves an orphaned (created-but-unbound) collection behind.
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  if ((binding.collectionIds ?? []).length >= BINDING_CAP) {
    throw new OpenwopError('validation_error', `This project already has the maximum ${BINDING_CAP} bound collections. Unbind one first.`, 400, { cap: BINDING_CAP });
  }
  // ADR 0608 D4 (`CPC-2`) — stamp the owning Subject on the collection at CREATE.
  // The KB feature's own doors gate on org scope; without this stamp a collection
  // created through a `private` project's door was readable — titles and verbatim
  // chunk text — by any org reader who is not a member. SERVER-SET (a privileged
  // `InternalCollectionFields` field a network caller cannot reach).
  const col = await createCollection(tenantId, orgId, actor, input, { boundSubject: projectSubject(projectId) });
  await bindCollection(tenantId, projectId, col.collectionId);
  return { collectionId: col.collectionId, orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount };
}

export async function unbindCollection(tenantId: string, projectId: string, collectionId: string): Promise<void> {
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  const current = binding.collectionIds ?? [];
  if (!current.includes(collectionId)) {
    throw new OpenwopError('not_found', 'Collection is not bound to this project.', 404, { collectionId });
  }
  await setSubjectKnowledge(tenantId, projectSubject(projectId), { collectionIds: current.filter((id) => id !== collectionId) });
}

export async function ingestDocToProject(
  tenantId: string,
  orgId: string,
  actor: string,
  projectId: string,
  collectionId: string,
  input: { title?: unknown; text?: unknown; mediaToken?: unknown; contentBase64?: unknown; contentType?: unknown },
): Promise<Awaited<ReturnType<typeof ingestDocument>>> {
  await mustOwnedCollectionBound(tenantId, projectId, orgId, collectionId);
  return ingestDocument(tenantId, orgId, actor, collectionId, input, {}, PREAUTHORIZED_CALLER); // KBC-1
}

export async function deleteDocFromProject(
  tenantId: string,
  orgId: string,
  projectId: string,
  collectionId: string,
  documentId: string,
): Promise<void> {
  await mustOwnedCollectionBound(tenantId, projectId, orgId, collectionId);
  await deleteDocument(tenantId, orgId, collectionId, documentId, PREAUTHORIZED_CALLER); // KBC-1
}

/** Read-only retrieval over the project's bound knowledge — cited KB chunks +
 *  project memory facts for `query`, via the shared subject composition.
 *  `failedSources`: see `retrieveForAgent` — a swallowed per-source fault must
 *  not reach the panel as "No matches" (KB-UX-3 / ADR 0583). */
export async function retrieveForProject(
  tenantId: string,
  projectId: string,
  query: string,
): Promise<{ chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust: 'trusted' | 'untrusted' }>; hasResults: boolean; failedSources: KnowledgeSourceKind[] }> {
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  const memory = createSubjectMemoryPort(tenantId);
  const retrieve = resolveSubjectKnowledgeRetrieve(tenantId, binding, memory, subjectMemoryScope(projectSubject(projectId)));
  if (!retrieve) return { chunks: [], hasResults: false, failedSources: [] };
  const failedSources: KnowledgeSourceKind[] = [];
  const out = await retrieve(query, (s) => { if (!failedSources.includes(s)) failedSources.push(s); });
  return {
    chunks: out.map((c) => ({ content: c.content, ...(c.title ? { title: c.title } : {}), kind: c.kind, contentTrust: c.contentTrust === 'untrusted' ? 'untrusted' : 'trusted' })),
    hasResults: out.length > 0,
    failedSources,
  };
}

/**
 * Shareable-KB provider (ADR 0100 D2) — lets a Board of Advisors share the org's
 * PROJECT KBs (the user-curated per-project collections, ADR 0042) with its
 * advisors, without the board feature importing projects. A SET (union across the
 * org's projects), no `ensure` (the collections already exist).
 *
 * Visibility carve-out: share/status include only `org`-VISIBLE projects (a private
 * project's KB is not shared — agent retrieval doesn't re-check project membership).
 * `forUnshare` includes ALL projects so unsharing fully cleans up a collection bound
 * while its project was org-visible and later made private.
 */
export const projectShareableKbProvider: ShareableKbProvider = {
  kind: 'project',
  resolveCollectionIds: async (tenantId, orgId, opts) => {
    const projects = (await listProjects(tenantId)).filter(
      (p) => p.orgId === orgId && (opts?.forUnshare === true || (p.visibility ?? 'org') === 'org'),
    );
    // CHATP-1 — resolve the per-project knowledge bindings CONCURRENTLY (was a
    // sequential await-in-loop N+1), bounding the path at ~1 round-trip of latency
    // instead of N. Internal durable reads, not rate-limited HTTP fan-out.
    const bindings = await Promise.all(
      projects.map((p) => getSubjectKnowledge(tenantId, projectSubject(p.id))),
    );
    const ids = new Set<string>();
    for (const binding of bindings) {
      for (const id of binding.collectionIds ?? []) ids.add(id);
    }
    return [...ids];
  },
};
