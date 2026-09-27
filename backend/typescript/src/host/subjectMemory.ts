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
import { hasLegacyAutoExtractedPrefix, isUntrustedMemoryRow } from './memoryTrust.js';
import { writeMemoryEntry, listMemoryEntries, removeMemoryEntry, clearMemoryScope, buildHostSurfaceBundle } from './inMemorySurfaces.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../aiProviders/localEmbedding.js';
import { scrubSecretShaped } from './redactSecrets.js';
import { DurableCollection } from './hostExtPersistence.js';
import { type Subject, subjectScope, personSubject } from './subject.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';
import { purgeNamespaceVectors } from './vector/vectorTenantPurge.js';
import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';

const log = createLogger('host.subjectMemory');

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
export async function countSubjectMemoryByTag(tenantId: string, scope: string, tag: string): Promise<number> {
  return (await listMemoryEntries(tenantId, scope, { tag })).length;
}

/**
 * LEGACY-ONLY discriminator for the AGMEM-2 backlog — re-exported so every
 * pre-existing importer is byte-identical. The definition moved to the leaf
 * `memoryTrust.ts` (review finding F2) so `inMemorySurfaces.ts` can ask the same
 * question without an `inMemorySurfaces → subjectMemory → inMemorySurfaces`
 * cycle; the full rationale and honesty note live there.
 */
export { LEGACY_AUTO_EXTRACTED_PREFIX } from './memoryTrust.js';

/** Content-trust (ADR 0038 §C) rides the `MEMORY_UNTRUSTED_TAG` tag: untrusted-
 *  derived entries surface `contentTrust:'untrusted'` so dispatch fences them.
 *  `content` is consulted only for the legacy prefix (AGMEM-2 backlog). */
const trustOf = (tags: readonly string[], content?: unknown): 'trusted' | 'untrusted' =>
  isUntrustedMemoryRow(tags, content) ? 'untrusted' : 'trusted';

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
  const row = await writeMemoryEntry(tenantId, scope, {
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
      items: [{ id: row.id, vector: embedText(content, DEFAULT_EMBEDDING_DIMS), metadata: { content, contentTrust: trustOf(opts.tags, content) } }],
    });
  } catch (err) {
    // ADR 0666 follow-up (`RCLWF-2`) — this was a BARE catch with no log, and the comment above
    // states only half of what happens. "A vector-store failure never loses the write" is true;
    // what it loses is the RECALL. `subjectMemory.read` prefers the vector path, so a note or
    // turn summary that misses the index is durably stored and effectively invisible to the
    // model — for the life of the row, with no error, no log and nothing on any surface.
    //
    // That is the empty-as-success family on the WRITE side, and it is the twin of the DELETE
    // side this ADR already fixed (`removeSubjectNote` now reports `recallCleared`). The write
    // stays best-effort — failing the turn because an index is down would be worse — but the
    // failure is now NAMED, so an operator can see why recall went quiet.
    log.error('subject_memory_index_write_failed', {
      tenantId, scope, id: row.id, error: err instanceof Error ? err.message : String(err),
    });
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

  const recency = async (scope: string): Promise<Array<{ content: string; contentTrust: 'trusted' | 'untrusted' }>> =>
    (await listMemoryEntries(tenantId, scope)).map((e) => ({ content: e.content, contentTrust: trustOf(e.tags, e.content) }));

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
            // Legacy vector rows (written before AGMEM-2) carry `contentTrust:'trusted'`
            // metadata for auto-extracted facts, so the prefix check applies here too.
            .map((md) => ({
              content: md.content,
              contentTrust:
                md.contentTrust === 'untrusted' || hasLegacyAutoExtractedPrefix(md.content) ? ('untrusted' as const) : ('trusted' as const),
            }));
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

/**
 * Where a curated note came from (ADR 0120 §100's reserved provenance marker,
 * carried as DATA rather than as an English prefix glued into the content).
 *   - `user`         — a person typed it (the default; trusted).
 *   - `auto-extract` — an LLM inferred it from a conversation (ADR 0120), which
 *                      may echo tool/MCP/fetched-web text ⇒ always UNTRUSTED.
 */
export type SubjectNoteSource = 'user' | 'auto-extract';

/** A curated note projected for a memory browser. */
export interface SubjectNote {
  id: string;
  content: string;
  contentTrust: 'trusted' | 'untrusted';
  /** Provenance. Absent on rows written before ADR 0587 ⇒ projected as `'user'`,
   *  except legacy `[auto-extracted] `-prefixed rows (see the prefix docblock). */
  source: SubjectNoteSource;
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
  /** ADR 0587 — provenance as data. Optional for rows written before it landed. */
  source?: SubjectNoteSource;
  createdAt: string;
}

const notesStore = new DurableCollection<DurableNote>('subject-memory:note', (r) => r.key);

/** Project a stored row's provenance + trust, honouring the legacy prefix for
 *  rows that predate ADR 0587 (fail-closed: legacy prefix ⇒ untrusted). */
function projectNote(r: DurableNote): SubjectNote {
  const legacy = r.source === undefined && hasLegacyAutoExtractedPrefix(r.content);
  return {
    id: r.id,
    content: r.content,
    contentTrust: legacy ? 'untrusted' : r.contentTrust,
    source: r.source ?? (legacy ? 'auto-extract' : 'user'),
    createdAt: r.createdAt,
  };
}
const noteKey = (tenantId: string, scope: string, id: string): string => `${tenantId}:${scope}:${id}`;
const notePrefix = (tenantId: string, scope: string): string => `${tenantId}:${scope}:`;

/** List a subject's curated notes (newest first) from the durable source. */
export async function listSubjectNotes(tenantId: string, subject: MemorySubject): Promise<SubjectNote[]> {
  const scope = subjectMemoryScope(subject);
  const rows = await notesStore.listByPrefix(notePrefix(tenantId, scope));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(projectNote);
}

/**
 * MEM-UX-1 (ADR 0587 §7) — how many rows are in the subject's RECALL scope that
 * are NOT curated notes.
 *
 * `listSubjectNotes` reads the curated-note store; the recall port
 * (`createSubjectMemoryPort.read`) reads the WHOLE scope, into which dispatch
 * writes a summary for every completed turn. So the browser's list is a SUBSET of
 * what the agent recalls, and the tab's copy called itself the whole thing. This
 * is what the disclosure line counts.
 *
 * HONEST LIMIT: the recall working set is in-memory, so after a restart this reads
 * 0 while the durable notes persist. The UI shows the disclosure only when the
 * count is > 0, so the failure mode is SILENCE, never a false "nothing else".
 */
export async function countRecallOnlyEntries(tenantId: string, subject: MemorySubject): Promise<number> {
  const scope = subjectMemoryScope(subject);
  const all = await listMemoryEntries(tenantId, scope);
  return all.filter((e) => !e.tags.includes(NOTE_TAG)).length;
}

/** Count a subject's curated notes (durable source). */
export async function countSubjectNotes(tenantId: string, subject: MemorySubject): Promise<number> {
  const scope = subjectMemoryScope(subject);
  return (await notesStore.listByPrefix(notePrefix(tenantId, scope))).length;
}

/** Provenance/trust options for `addSubjectNote` (ADR 0587 / AGMEM-2 / ADR 0601). */
export interface AddSubjectNoteOptions {
  /**
   * Where the fact came from. `'auto-extract'` (an LLM inferred it from a
   * conversation transcript, which can echo tool/MCP/fetched-web content) forces
   * `contentTrust:'untrusted'` — a model-authored fact is NEVER trusted, and the
   * caller cannot override that. Default `'user'`.
   */
  source?: SubjectNoteSource;
  /**
   * ADR 0601 — the note's CONTENT trust, an axis ORTHOGONAL to `source`.
   *
   * `source` answers *who performed the write*; this answers *whether the TEXT may
   * carry instructions the model must not obey*. They coincide for `'auto-extract'`
   * and diverge for the case that shipped the notebooks laundering blocker: a human
   * clicks "save to notes" beside a retrieved passage, so the ACT is the user's
   * (`source:'user'`) while the TEXT is verbatim third-party research material.
   *
   * Same vocabulary as `kbService.ingestDocument(..., { contentTrust })`, which the
   * notebooks source lane already uses — one word for the one boundary.
   *
   * Default `'trusted'` (a person typing their own fact). This default is safe ONLY
   * because it is never reached from a lane that copies third-party text: the
   * notebooks choke `notebooksService.addNote` takes a REQUIRED origin argument, so
   * that lane cannot fall through to it. See ADR 0601 § Residuals.
   *
   * An `'auto-extract'` note is untrusted regardless of what is passed here.
   */
  contentTrust?: 'trusted' | 'untrusted';
}

/** Add a curated note (the "memory" a user trains). Validates + caps, then writes
 *  the DURABLE source-of-truth row FIRST (fail-closed), then the best-effort
 *  in-memory + vector recall row under the SAME id. Host-internal, NOT a wire
 *  write (RFC 0004). Caller enforces ownership/opt-in first. Tenant-scoped.
 *
 *  AGMEM-2: trust is carried as DATA on the durable row and as
 *  `MEMORY_UNTRUSTED_TAG` on the recall row (which is what `agentDispatch` fences
 *  and what `agentKnowledgeComposition` keeps out of the unfenced block). Before
 *  ADR 0587 this hardcoded `'trusted'`, so an LLM-inferred fact reached a
 *  tool-enabled system prompt un-fenced. */
export async function addSubjectNote(
  tenantId: string,
  subject: MemorySubject,
  content: unknown,
  opts: AddSubjectNoteOptions = {},
): Promise<void> {
  const text = typeof content === 'string' ? content.trim() : '';
  if (text.length === 0) {
    throw new OpenwopError('validation_error', 'Field `content` is required and MUST be a non-empty string.', 400, { field: 'content' });
  }
  if (text.length > MAX_NOTE_LEN) {
    throw new OpenwopError('validation_error', `A note MUST be ${MAX_NOTE_LEN} characters or fewer.`, 400, { field: 'content' });
  }
  // Best-effort cap (read-then-write, not CAS): two concurrent adds to the SAME
  // subject could both pass and briefly exceed NOTE_CAP.
  //
  // CORRECTED 2026-09-12 (`PRJWF-4`) — the justification here used to read "the only writer to
  // a subject's scope is its single owner (a user to `user:<id>`, an owner curating
  // `agent:<id>`), so the soft cap needs no atomicity." That enumerates TWO subject kinds and
  // the primitive has THREE: `project:<id>` is written by EVERY `workspace:write` holder in the
  // org (`features/projects/routes.ts` POST /:id/memory), so concurrent writers are the normal
  // case there, not the exceptional one.
  //
  // The cap stays best-effort — it is a soft workspace guard, not a security boundary, and a
  // brief overshoot costs nothing — but the reason is now the honest one: overshooting a
  // curation cap is harmless, NOT that concurrency cannot happen. Checked before rewriting: no
  // MACHINE lane writes a project scope (the two `projectSubject` references outside this
  // module are a descriptive provenance field and a READ), so the `trusted` default on that
  // door is a human note by an authorized member and is consistent with the sibling lanes.
  if ((await countSubjectNotes(tenantId, subject)) >= NOTE_CAP) {
    throw new OpenwopError('validation_error', `This memory already holds the maximum ${NOTE_CAP} curated notes. Remove some before adding more.`, 400, { cap: NOTE_CAP });
  }
  const scope = subjectMemoryScope(subject);
  const content2 = scrubSecretShaped(text);
  const id = `mem_${randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  const source: SubjectNoteSource = opts.source ?? 'user';
  // A model-authored fact is untrusted BY CONSTRUCTION — derived, never passed in,
  // so no caller can hand back `'trusted'` for an `'auto-extract'` write. ADR 0601:
  // a `'user'`-sourced write may still declare its TEXT untrusted (third-party
  // content the human copied rather than composed); the floor below only ever
  // TIGHTENS — there is no argument that loosens `'auto-extract'`.
  const contentTrust: 'trusted' | 'untrusted' =
    source === 'auto-extract' ? 'untrusted' : (opts.contentTrust ?? 'trusted');
  // Durable source of truth FIRST — if this throws, no note is created (fail-closed).
  await notesStore.put({ key: noteKey(tenantId, scope, id), id, tenantId, scope, content: content2, contentTrust, source, createdAt });
  // Recall index (best-effort) under the SAME id, so dispatch RAG recall sees it.
  // The untrusted tag is what fences the row in every recall path (dispatch split,
  // composition block, vector metadata) — see `trustOf`.
  const tags = contentTrust === 'untrusted' ? [NOTE_TAG, subject.id, MEMORY_UNTRUSTED_TAG] : [NOTE_TAG, subject.id];
  const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
  await persistAndIndex(tenantId, vector, scope, { content: content2, tags, id, createdAt });
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

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A subject's memory scope (`user:<id>`) is THEIR OWN long-term data — curated
// notes AND dispatch turn-summaries — so a DSAR DELETES it entirely across all
// three tiers that share the row id: the durable note source of truth, the
// in-memory recall working set (`clearMemoryScope`, which also drops non-durable
// turn summaries), and the best-effort vector index. Only the `user:` scope is
// touched (a DSAR erases a person, never a roster agent's `agent:` recall).
// Idempotent (a second run finds an empty scope); fail-closed on falsy input.

/** DSAR eraser — drop every memory row under the subject's `user:` scope. */
export async function eraseSubjectMemory(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  // GEN-TWIN-4 (found while building the WF-TWIN-3 witness) — this used to derive
  // ONE scope, from `subjectKeyForms(subjectKey).raw`, which STRIPS a leading
  // `user:`. But a person's own memory is written with `{kind:'user', id:
  // user.userId}` (`features/profile-memory/routes.ts:33`) and `User.userId` is
  // ITSELF `user:<hash>` (`usersService.userIdFor`), so the stored scope is
  // `user:user:<hash>` while the eraser looked for `user:<hash>`. The prefixes do
  // not overlap, so PERSONAL MEMORY WAS NEVER ERASED BY A DSAR — in any tenancy
  // shape, not just a shared workspace. Erase every key form (the same sanctioned
  // over-set the other erasers use), so neither the bare nor the prefixed writer
  // convention can be missed.
  const { forms } = subjectKeyForms(subjectKey);
  const scopes = [...new Set([...forms].map((f) => subjectMemoryScope(personSubject(f))))];
  let rowsTouched = 0;
  for (const scope of scopes) {
    // Durable notes (source of truth). (Ids are no longer collected for the vector cleanup —
    // D2 purges the whole namespace below, precisely because the ids are not enumerable.)
    const rows = await notesStore.listByPrefix(notePrefix(tenantId, scope));
    for (const r of rows) await notesStore.delete(r.key);
    rowsTouched += rows.length;
    // In-memory recall working set (curated-note recency + transient turn summaries).
    await clearMemoryScope(tenantId, scope);
    // ADR 0666 D2 — purge the whole vector NAMESPACE, not the ids we happen to know.
    //
    // This used to collect ids from the durable note rows above and delete those. Two holes,
    // both of which ADR 0664 D1 named when it fixed the identical gap on the agent lane
    // (`host/rosterCascade.ts`, citing this very block): dispatch turn-summaries are indexed by
    // `persistAndIndex` with NO durable note row, so none of their ids are in `rows`; and a
    // pgvector deployment holds rows this process never saw. Worse, the `if (ids.length)` guard
    // meant a person with only turn summaries and no curated notes got NO vector deletion at
    // all. `subjectMemory.read` prefers the vector path over recency, so the erased content was
    // exactly what a later recall would serve.
    //
    // Reachability is what makes it live rather than theoretical, and it is the same argument
    // ADR 0664 D1 relied on for agents: `userIdFor` is `sha256(tenantId:principalId)`
    // (`features/users/usersService.ts`), re-derived on create, and
    // `tombstoneCanonicalPointer` no-ops unless the tenant is a personal one — so in a
    // SCIM/SSO workspace the same principal re-provisions onto the same namespace.
    //
    // SAFE because of an invariant worth stating: a namespace purge is unbounded where the
    // id-delete was bounded, and `scopes` above is an OVER-SET (`user:user:<hash>` AND
    // `user:<hash>`). No other subject can own either — every `User.userId` is `user:<32 hex>`,
    // agent scopes are `agent:*` and unreachable here (`personSubject` forces `kind:'user'`),
    // and KB vector namespaces are `<orgId>/<collectionId>` or a bare UUID. If that ever stops
    // holding, this becomes cross-subject destruction.
    //
    // No new hold exposure: this function is reachable ONLY through `registerSubjectEraser`
    // (below) and therefore only behind `eraseSubject`'s retention-hold assertion. The agent
    // lane's cascade asserts no hold (`AGKM-11`) — this imports its purge, not its gap.
    //
    // Best-effort like the sibling, but the failure is NAMED with its backend rather than
    // swallowed: a partial purge must never fold into a success.
    const vectorPurge = await purgeNamespaceVectors(tenantId, scope);
    if (vectorPurge.failed.length > 0) {
      log.error('subject_memory_vector_purge_partial', {
        tenantId, scope, failed: vectorPurge.failed, purged: vectorPurge.purged,
      });
    }
  }
  // WF-TWIN-3 — report what was actually reached. A DSAR fielded by a shared
  // `ws:` workspace used to scan the workspace prefix while these notes live
  // under the person's HOME tenant, matching zero rows and reporting success.
  return { rowsTouched };
}

/** Register the subject-memory DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerSubjectMemoryErasure(): void {
  registerSubjectEraser(eraseSubjectMemory);
}

/** ADR 0666 D2 follow-up — the outcome of a single-note removal.
 *
 *  `recallCleared:false` means the durable note IS gone but the recall index may still hold it,
 *  so a caller must not report an unqualified success. The vector row's metadata carries the
 *  note TEXT and the recall read prefers the vector path, so a swallowed failure here let the
 *  model keep reciting a note the person had deleted. */
export interface RemoveNoteOutcome { removed: boolean; recallCleared: boolean }

/** Remove a curated note by id — consistently across the durable source, the
 *  in-memory recency row, and the vector index (all share the id). Fail-closed:
 *  returns false when the subject has no such durable note (so a turn-summary id
 *  or a foreign-subject id is a no-op). Tenant-scoped. */
export async function removeSubjectNote(tenantId: string, subject: MemorySubject, noteId: string): Promise<RemoveNoteOutcome> {
  const scope = subjectMemoryScope(subject);
  const existed = await notesStore.delete(noteKey(tenantId, scope, noteId));
  if (!existed) return { removed: false, recallCleared: true };
  // ADR 0666 D2 (follow-up found by the it.17 grade-code pass) — THE SIBLING OF THE HOLE D2 JUST
  // CLOSED, 50 lines up, on the path a user actually clicks.
  //
  // D2's own comment called this function "the sibling" without noticing it still had the
  // defect. The vector row's `metadata.content` IS the note text (`persistAndIndex` above), and
  // `read` prefers the vector path over recency — so a swallowed failure here returned 204 to
  // the person while the model kept reciting the note they just deleted. A delete that reports
  // success and leaves the content recallable is the same dishonesty family as an erasure that
  // reports success and leaves the index intact.
  //
  // Single-row, so the id-delete is the RIGHT shape here (unlike the eraser, which cannot
  // enumerate turn-summary ids): the id is shared across all three stores by construction.
  //
  // NOT a throw, and that was the first attempt. Throwing would 500 a delete whose DURABLE half
  // already succeeded — the note is gone, so a retry returns `removed:false` and the person can
  // never "complete" the operation. That is a second dishonesty in the opposite direction, so
  // the outcome is REPORTED instead: `recallCleared:false` says the note is deleted but may
  // still be recalled until the index catches up. Same shape as the `deleteSubjectSends`
  // outcome that replaced a mid-loop throw on the email lane.
  //
  // The in-memory row is removed first and is NOT wrapped: it is a process-local structure, so a
  // fault there is not the partial-index case this flag describes.
  await removeMemoryEntry(tenantId, scope, noteId);
  let recallCleared = true;
  try {
    await buildHostSurfaceBundle({ tenantId }).db.vector.delete({ namespace: scope, ids: [noteId] });
  } catch (err) {
    recallCleared = false;
    log.error('subject_memory_note_recall_cleanup_failed', {
      tenantId, scope, noteId, error: err instanceof Error ? err.message : String(err),
    });
  }
  return { removed: true, recallCleared };
}
