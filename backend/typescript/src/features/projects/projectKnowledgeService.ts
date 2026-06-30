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
import { createSubjectMemoryPort, subjectMemoryScope, countSubjectNotes } from '../../host/subjectMemory.js';
import { resolveSubjectKnowledgeRetrieve } from '../../host/agentKnowledgeComposition.js';
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
  const all = await listAllTenantCollections(tenantId);
  const col = all.find((c) => c.collectionId === collectionId);
  if (!col) return null;
  return { collectionId: col.collectionId, orgId: col.orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount };
}

async function mustOwnedCollectionBound(tenantId: string, projectId: string, orgId: string, collectionId: string): Promise<void> {
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  if (!(binding.collectionIds ?? []).includes(collectionId)) {
    throw new OpenwopError('not_found', 'Collection is not bound to this project.', 404, { collectionId });
  }
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
}

/** The project's full knowledge view; self-heals a dangling binding on read. */
export async function getProjectKnowledge(tenantId: string, projectId: string): Promise<ProjectKnowledgeView> {
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  const collectionIds = binding.collectionIds ?? [];
  const byId = new Map((await listAllTenantCollections(tenantId)).map((c) => [c.collectionId, c]));
  const collections: ProjectKnowledgeView['collections'] = [];
  const liveIds: string[] = [];
  for (const collectionId of collectionIds) {
    const col = byId.get(collectionId);
    if (!col) continue; // a deleted collection self-heals out of the view
    liveIds.push(collectionId);
    const documents = await listDocuments(tenantId, col.orgId, collectionId);
    collections.push({ collectionId: col.collectionId, orgId: col.orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount, documents });
  }
  if (liveIds.length < collectionIds.length) {
    // Self-heal a dangling binding (a referenced collection was deleted out from
    // under us). This is an idempotent prune on a read path — it only ever drops
    // ids that no longer resolve, so a concurrent prune/bind converges (a racing
    // bind re-adds its live id; two prunes compute the same `liveIds`).
    await setSubjectKnowledge(tenantId, projectSubject(projectId), { collectionIds: liveIds });
  }
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
  const col = await createCollection(tenantId, orgId, actor, input);
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
  return ingestDocument(tenantId, orgId, actor, collectionId, input);
}

export async function deleteDocFromProject(
  tenantId: string,
  orgId: string,
  projectId: string,
  collectionId: string,
  documentId: string,
): Promise<void> {
  await mustOwnedCollectionBound(tenantId, projectId, orgId, collectionId);
  await deleteDocument(tenantId, orgId, collectionId, documentId);
}

/** Read-only retrieval over the project's bound knowledge — cited KB chunks +
 *  project memory facts for `query`, via the shared subject composition. */
export async function retrieveForProject(
  tenantId: string,
  projectId: string,
  query: string,
): Promise<{ chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust: 'trusted' | 'untrusted' }>; hasResults: boolean }> {
  const binding = await getSubjectKnowledge(tenantId, projectSubject(projectId));
  const memory = createSubjectMemoryPort(tenantId);
  const retrieve = resolveSubjectKnowledgeRetrieve(tenantId, binding, memory, subjectMemoryScope(projectSubject(projectId)));
  if (!retrieve) return { chunks: [], hasResults: false };
  const out = await retrieve(query);
  return {
    chunks: out.map((c) => ({ content: c.content, ...(c.title ? { title: c.title } : {}), kind: c.kind, contentTrust: c.contentTrust === 'untrusted' ? 'untrusted' : 'trusted' })),
    hasResults: out.length > 0,
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
