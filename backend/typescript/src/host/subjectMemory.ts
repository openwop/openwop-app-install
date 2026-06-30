/**
 * Subject memory (ADR 0041) — ONE memory primitive for agents *and* humans.
 *
 * A `MemorySubject` is the owner of a memory scope. Both an agent (`agent:<id>`)
 * and a human (`user:<id>`) are just subjects; the RFC-0004 store keys on an
 * opaque `memoryRef`, so the SAME store + port + curation serve both. This module
 * is the single owner of:
 *   - the scope convention (`subjectMemoryScope`),
 *   - the RFC-0004 memory PORT (`createSubjectMemoryPort` — read recency/RAG, write
 *     + embed), used by dispatch and curation alike, and
 *   - the curated-note CRUD (`addSubjectNote`/`listSubjectNotes`/`removeSubjectNote`/
 *     `countSubjectNotes`) — the "memories" a user trains into a subject.
 *
 * `host/agentMemoryAdapter.ts` is a thin back-compat re-export of the agent
 * specialization (`agentMemoryScope` = `subjectMemoryScope({kind:'agent'})`,
 * `createAgentMemoryPort` = `createSubjectMemoryPort`), so every pre-existing
 * importer (dispatch, agent-knowledge, advisory board, routes) keeps IDENTICAL
 * behavior — the no-fork guarantee.
 *
 * Tenant isolation (CTI-1): `tenantId` is bound at the call boundary from the
 * request principal, never passed through `scope`, so reads/writes can't cross a
 * tenant. SR-1 (no credential material) is the writer's responsibility; the
 * agent-memory adapter already scrubs secret-shaped content on write.
 *
 * @see docs/adr/0041-subject-memory.md
 * @see docs/adr/0038-per-agent-knowledge-memory.md
 */

import { randomUUID } from 'node:crypto';
import type { AgentMemoryPort } from './agentDispatch.js';
import { MEMORY_UNTRUSTED_TAG } from './agentDispatch.js';
import { writeMemoryEntry, listMemoryEntries, removeMemoryEntry, buildHostSurfaceBundle } from './inMemorySurfaces.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../aiProviders/localEmbedding.js';
import { scrubSecretShaped } from './redactSecrets.js';
import { DurableCollection } from './hostExtPersistence.js';
import { type Subject, subjectScope } from './subject.js';
import { OpenwopError } from '../types.js';

/** Who owns a memory scope (ADR 0045) — now the canonical `Subject`. An agent's
 *  recall (`agent:<id>`) and a human's personal memory (`user:<id>`) are the same
 *  primitive over different subjects; a `project:<id>` corpus is forward-compatible
 *  (ADR 0046). Kept as a named alias so the ADR 0041 call sites read unchanged. */
export type MemorySubject = Subject;

/** Stable memory namespace (`memoryRef`) for a subject within a tenant —
 *  `subjectScope` (ADR 0045). Isolates each subject's long-term memory from the
 *  demo surface and from every other subject in the tenant. `agent:<id>` is
 *  byte-identical to the legacy `agentMemoryScope`, so existing paths are unchanged. */
export function subjectMemoryScope(subject: MemorySubject): string {
  return subjectScope(subject);
}

/** Top-K entries a RAG recall returns into a turn's context. */
const RAG_TOP_K = 8;

/** Count entries in a scope carrying `tag` (tag-aware; the port's read projection
 *  drops tags, so by-tag counts read the store directly here). Tenant-scoped. */
export function countSubjectMemoryByTag(tenantId: string, scope: string, tag: string): number {
  return listMemoryEntries(tenantId, scope, { tag }).length;
}

/** Content-trust (ADR 0038 §C) rides the `MEMORY_UNTRUSTED_TAG` tag: untrusted-
 *  derived entries surface `contentTrust:'untrusted'` so dispatch fences them. */
const trustOf = (tags: readonly string[]): 'trusted' | 'untrusted' =>
  tags.includes(MEMORY_UNTRUSTED_TAG) ? 'untrusted' : 'trusted';

type VectorSurface = ReturnType<typeof buildHostSurfaceBundle>['db']['vector'];

/**
 * The single owner of "how a memory entry is written + indexed for recall":
 * SR-1 scrub → durable-less in-memory persist (the recall working set) → vector
 * upsert (RAG). Used by the dispatch write port AND by curated-note writes (which
 * additionally mirror to a durable store — see `addSubjectNote`). An explicit
 * `id`/`createdAt` keeps the in-memory + vector rows aligned with a durable row
 * so a later delete hits the same id everywhere. Returns the persisted row.
 */
async function persistAndIndex(
  tenantId: string,
  vector: VectorSurface,
  scope: string,
  opts: { content: string; tags: string[]; id?: string; createdAt?: string },
): Promise<{ id: string; content: string; createdAt: string }> {
  // SR-1 (RFC 0004): scrub secret-shaped tokens BEFORE the durable write + the
  // embed — a turn summary or curated note may echo a credential the turn handled.
  // This is the single chokepoint for every subject-memory write.
  const content = scrubSecretShaped(opts.content);
  const row = writeMemoryEntry(tenantId, scope, {
    content,
    tags: opts.tags,
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  // Index for RAG recall — best-effort; a vector-store failure never loses the
  // write above. Mirror content-trust onto the vector metadata so the RAG read
  // path (which can't see durable tags) can still fence untrusted-derived entries.
  try {
    await vector.upsert({
      namespace: scope,
      items: [{ id: row.id, vector: embedText(content, DEFAULT_EMBEDDING_DIMS), metadata: { content, contentTrust: trustOf(opts.tags) } }],
    });
  } catch {
    /* best-effort index */
  }
  return { id: row.id, content, createdAt: row.createdAt };
}

/**
 * Build an `AgentMemoryPort` bound to one tenant — the dispatch-facing read/write
 * port (moved verbatim from the old `agentMemoryAdapter`). `read(scope, query)`
 * ranks by embedding cosine over the tenant-scoped vector surface and falls back
 * to recency; `write(scope, entry)` persists durable + embeds for RAG recall.
 * Both are best-effort from the dispatcher's perspective.
 */
export function createSubjectMemoryPort(tenantId: string): AgentMemoryPort {
  // Tenant-scoped vector surface (CTI-1: the cosine store buckets by tenantId).
  // Built once per port; underlying state is process-global so writes persist.
  const vector = buildHostSurfaceBundle({ tenantId }).db.vector;

  const recency = (scope: string): Array<{ content: string; contentTrust: 'trusted' | 'untrusted' }> =>
    listMemoryEntries(tenantId, scope).map((e) => ({ content: e.content, contentTrust: trustOf(e.tags) }));

  return {
    async read(scope: string, query?: string): Promise<ReadonlyArray<{ content: string; contentTrust?: 'trusted' | 'untrusted' }>> {
      // RAG path: rank by embedding cosine similarity. Embed at the SAME dimension
      // used on write (DEFAULT_EMBEDDING_DIMS) so cosine is valid.
      if (query && query.trim().length > 0) {
        try {
          const res = await vector.query({
            namespace: scope,
            vector: embedText(query, DEFAULT_EMBEDDING_DIMS),
            topK: RAG_TOP_K,
          });
          const matches = (res.matches ?? []) as Array<{ metadata?: { content?: unknown; contentTrust?: unknown } }>;
          const ranked = matches
            .map((m) => m.metadata)
            .filter((md): md is { content: string; contentTrust?: unknown } => typeof md?.content === 'string')
            .map((md) => ({ content: md.content, contentTrust: md.contentTrust === 'untrusted' ? ('untrusted' as const) : ('trusted' as const) }));
          if (ranked.length > 0) return ranked;
          // Vector store empty for this scope (e.g. entries seeded pre-A5) → recency.
        } catch {
          /* fall through to recency on any vector-store error */
        }
      }
      return recency(scope);
    },
    async write(scope: string, entry: { content: string; tags?: string[] }): Promise<void> {
      await persistAndIndex(tenantId, vector, scope, { content: entry.content, tags: entry.tags ?? [] });
    },
  };
}

// ── Curated notes — the "memories" a user trains into a subject ──────────────
//
// A note is a short user-authored fact, distinct from a dispatch turn-summary in
// the SAME namespace (turn summaries carry only `[subjectId]`; notes additionally
// carry NOTE_TAG). Counts/lists filter on NOTE_TAG so turn summaries never inflate
// the user-visible memory. This serves agents (ADR 0038) and humans (ADR 0041)
// through one validator + one cap.

/** Marker tag stamped on every curated note's recall row. Stable (ADR 0038). */
export const NOTE_TAG = 'agent-knowledge:note';

/** Per-subject curation cap (bounds growth + dispatch fan-out). Reject, don't
 *  evict — user-curated notes must never silently vanish. */
export const NOTE_CAP = 200;

/** Max characters per note. */
export const MAX_NOTE_LEN = 4000;

/** A curated note projected for a memory browser. */
export interface SubjectNote {
  id: string;
  content: string;
  contentTrust: 'trusted' | 'untrusted';
  createdAt: string;
}

/**
 * Durable curated notes (ADR 0041 / Phase 2). A curated note is DURABLE — it must
 * survive a restart so a person can train their twin over months (and an agent's
 * curated facts persist like its profile). The DurableCollection (same seam
 * profiles/orgs use) is the SOURCE OF TRUTH for list/count/delete; the in-memory
 * + vector store is a best-effort RECALL index written alongside, so dispatch RAG
 * recall keeps working in-process (unchanged from ADR 0038 — recall stays
 * sample-grade). Both stores share the same row id, so a delete is consistent
 * across durable + recency + vector.
 *
 * NOT durable: dispatch turn-summaries (written via the port with no NOTE_TAG) —
 * they are transient run-recall, regenerated each run, and stay ephemeral.
 */
interface DurableNote {
  /** Collection key `${tenantId}:${scope}:${id}` — bounds `listByPrefix` to one
   *  subject (CTI-1 by construction: the tenant + scope are baked into the key). */
  key: string;
  /** The memory-entry id, shared with the in-memory + vector recall rows. */
  id: string;
  tenantId: string;
  scope: string;
  content: string;
  contentTrust: 'trusted' | 'untrusted';
  createdAt: string;
}

const notesStore = new DurableCollection<DurableNote>('subject-memory:note', (r) => r.key);
const noteKey = (tenantId: string, scope: string, id: string): string => `${tenantId}:${scope}:${id}`;
const notePrefix = (tenantId: string, scope: string): string => `${tenantId}:${scope}:`;

/** List a subject's curated notes (newest first) from the durable source. */
export async function listSubjectNotes(tenantId: string, subject: MemorySubject): Promise<SubjectNote[]> {
  const scope = subjectMemoryScope(subject);
  const rows = await notesStore.listByPrefix(notePrefix(tenantId, scope));
  return rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({ id: r.id, content: r.content, contentTrust: r.contentTrust, createdAt: r.createdAt }));
}

/** Count a subject's curated notes (durable source). */
export async function countSubjectNotes(tenantId: string, subject: MemorySubject): Promise<number> {
  const scope = subjectMemoryScope(subject);
  return (await notesStore.listByPrefix(notePrefix(tenantId, scope))).length;
}

/** Add a curated note (the "memory" a user trains). Validates + caps, then writes
 *  the DURABLE source-of-truth row FIRST (fail-closed), then the best-effort
 *  in-memory + vector recall row under the SAME id. Host-internal, NOT a wire
 *  write (RFC 0004). Caller enforces ownership/opt-in first. Tenant-scoped. */
export async function addSubjectNote(tenantId: string, subject: MemorySubject, content: unknown): Promise<void> {
  const text = typeof content === 'string' ? content.trim() : '';
  if (text.length === 0) {
    throw new OpenwopError('validation_error', 'Field `content` is required and MUST be a non-empty string.', 400, { field: 'content' });
  }
  if (text.length > MAX_NOTE_LEN) {
    throw new OpenwopError('validation_error', `A note MUST be ${MAX_NOTE_LEN} characters or fewer.`, 400, { field: 'content' });
  }
  // Best-effort cap (read-then-write, not CAS): two concurrent adds to the SAME
  // subject could both pass and briefly exceed NOTE_CAP. Tolerated — the only
  // writer to a subject's scope is its single owner (a user to `user:<id>`, an
  // owner curating `agent:<id>`), so the soft cap needs no atomicity.
  if ((await countSubjectNotes(tenantId, subject)) >= NOTE_CAP) {
    throw new OpenwopError('validation_error', `This memory already holds the maximum ${NOTE_CAP} curated notes. Remove some before adding more.`, 400, { cap: NOTE_CAP });
  }
  const scope = subjectMemoryScope(subject);
  const content2 = scrubSecretShaped(text);
  const id = `mem_${randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  // Durable source of truth FIRST — if this throws, no note is created (fail-closed).
  await notesStore.put({ key: noteKey(tenantId, scope, id), id, tenantId, scope, content: content2, contentTrust: 'trusted', createdAt });
  // Recall index (best-effort) under the SAME id, so dispatch RAG recall sees it.
  const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
  await persistAndIndex(tenantId, vector, scope, { content: content2, tags: [NOTE_TAG, subject.id], id, createdAt });
}

/** Drop ALL of a subject's durable curated notes (the cascade for deleting the
 *  subject — e.g. a roster agent removed). Returns the number cleared. The
 *  in-memory recall scope is cleared separately by the cascade (`clearMemoryScope`).
 *  Tenant-scoped (CTI-1: the prefix bakes in tenant + scope). */
export async function clearSubjectNotes(tenantId: string, subject: MemorySubject): Promise<number> {
  const scope = subjectMemoryScope(subject);
  const rows = await notesStore.listByPrefix(notePrefix(tenantId, scope));
  for (const r of rows) await notesStore.delete(r.key);
  return rows.length;
}

/** Remove a curated note by id — consistently across the durable source, the
 *  in-memory recency row, and the vector index (all share the id). Fail-closed:
 *  returns false when the subject has no such durable note (so a turn-summary id
 *  or a foreign-subject id is a no-op). Tenant-scoped. */
export async function removeSubjectNote(tenantId: string, subject: MemorySubject, noteId: string): Promise<boolean> {
  const scope = subjectMemoryScope(subject);
  const existed = await notesStore.delete(noteKey(tenantId, scope, noteId));
  if (!existed) return false;
  // Drop the recall rows too (best-effort — durable removal already succeeded).
  removeMemoryEntry(tenantId, scope, noteId);
  try {
    await buildHostSurfaceBundle({ tenantId }).db.vector.delete({ namespace: scope, ids: [noteId] });
  } catch {
    /* best-effort recall cleanup */
  }
  return true;
}
