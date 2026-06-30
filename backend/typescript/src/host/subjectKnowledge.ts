/**
 * Subject knowledge bindings (ADR 0046 follow-on / ADR 0045) — ONE subject-keyed
 * store for "which KB collections + retrieval tuning a subject has bound." The
 * generalization of the per-entity knowledge bindings (`agentProfile.knowledge`
 * ADR 0038, `Profile.knowledge` ADR 0042) — the binding now keys on the canonical
 * `Subject` (`subjectScope`), so a `project:<id>` (or any new kind) gets cited
 * documents with zero new infrastructure.
 *
 * The binding is a REFERENCE only (`collectionIds` point into `kbService`); no
 * document bytes live here. Tenant-scoped (CTI-1: `tenantId` baked into the key).
 *
 * Migration note: agents/users keep their existing entity-local bindings (no data
 * migration); this store is the FORWARD home and is used by projects today. Folding
 * the agent/user bindings into it is a future, additive step.
 *
 * @see docs/adr/0046-project-subject.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import { subjectScope, type Subject } from './subject.js';
import type { SubjectKnowledgeBinding } from './agentKnowledgeComposition.js';

interface StoredBinding {
  /** Collection key `${tenantId}:${kind}:${id}` — bounds reads to one subject. */
  key: string;
  tenantId: string;
  scope: string;
  collectionIds: string[];
  retrieval?: SubjectKnowledgeBinding['retrieval'];
}

const store = new DurableCollection<StoredBinding>('subject-knowledge', (r) => r.key);
const keyOf = (tenantId: string, subject: Subject): string => `${tenantId}:${subjectScope(subject)}`;

/** The subject's knowledge binding (empty when none). */
export async function getSubjectKnowledge(tenantId: string, subject: Subject): Promise<SubjectKnowledgeBinding> {
  const row = await store.get(keyOf(tenantId, subject));
  if (!row || row.tenantId !== tenantId) return {};
  return { collectionIds: row.collectionIds, ...(row.retrieval ? { retrieval: row.retrieval } : {}) };
}

/** Shallow-merge a binding patch onto the subject's binding (idempotent upsert).
 *  Caller enforces ownership/scope first. Tenant-scoped. */
export async function setSubjectKnowledge(tenantId: string, subject: Subject, patch: SubjectKnowledgeBinding): Promise<void> {
  const key = keyOf(tenantId, subject);
  const existing = await store.get(key);
  const merged: StoredBinding = {
    key,
    tenantId,
    scope: subjectScope(subject),
    collectionIds: patch.collectionIds ?? existing?.collectionIds ?? [],
    ...((patch.retrieval ?? existing?.retrieval) ? { retrieval: patch.retrieval ?? existing?.retrieval } : {}),
  };
  await store.put(merged);
}

/** Drop a subject's binding entirely (the delete-subject cascade — e.g. a project
 *  removed). The referenced KB collections are NOT deleted (shareable). */
export async function clearSubjectKnowledge(tenantId: string, subject: Subject): Promise<void> {
  await store.delete(keyOf(tenantId, subject));
}
