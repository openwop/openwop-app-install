/**
 * Knowledge Base / RAG (ADR 0011). Org-scoped, tenant+org IDOR-guarded. Owns
 * collections + documents (durable) and an ingest→chunk→embed→index pipeline +
 * semantic retrieval with citations. It COMPOSES existing host surfaces rather
 * than reinventing them:
 *   - the vector store via `buildHostSurfaceBundle({tenantId}).db.vector`
 *     (in-memory brute-force ↔ pgvector, tenant-scoped automatically);
 *   - the deterministic `embedText` embedder (no provider needed, replay-safe).
 *
 * Chunks are DERIVED, not separately stored: the document's `text` is the durable
 * source of truth, and because `embedText` is deterministic, the vector namespace
 * is lazily REBUILT from durable documents on first access per process (`hydrate`)
 * — restart-safe (the in-memory vector surface is ephemeral) without persisting
 * 256-float blobs per chunk. The host vector store still runs the similarity query.
 *
 * DERIVED WRITES AND HOST-EVENT EMITS ON A MUTATION PATH ARE AWAITED, NEVER
 * DETACHED (ADR 0643 D6). This host suspends a detached continuation under Cloud
 * Run `cpu-throttling=true` — documented three times over (`CLAUDE.md` § deploying,
 * the SPA-shell refresh that stayed wedged 16+ minutes; ADR 0556 §"awaited";
 * ADR 0585 §"fire-and-forget") — so `void fireKnowledgeDocumentChanged(...)` and
 * `void emitHostEvent(...)` were writes and events that may already have been
 * dropped in production. Both seams never throw by contract (each swallows and
 * logs per consumer), so awaiting can never fail the mutation; it costs only
 * latency. A genuinely optional continuation is QUEUED (a durable job), never
 * `void`'d. The lifecycle events themselves ride `./emit.ts` (ADR 0643 D3).
 *
 * @see docs/adr/0011-knowledge-base-rag.md
 * @see docs/adr/0643-kb-reindex-orchestration-write-surface-lifecycle-events.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { Subject } from '../../host/subject.js';
import { subjectReadAllowed, PREAUTHORIZED_CALLER, type SubjectCaller } from '../../host/subjectAccess.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { buildHostSurfaceBundle } from '../../host/inMemorySurfaces.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { embedText, DEFAULT_EMBEDDING_DIMS, LOCAL_EMBEDDING_MODEL } from '../../aiProviders/localEmbedding.js';
import { resolveHeadlessEmbedderMaybeTest, resolveHeadlessEmbedderForSpecMaybeTest, type HeadlessEmbedder } from '../../host/headlessAi.js';
import { createHash } from 'node:crypto';
import { bm25Search, rrfFuse } from './lexicalIndex.js';
import { localRerank } from './reranker.js';

/** Retrieval pipeline mode (ADR 0113). `dense` = today's single-stage cosine
 *  (default, unchanged). `hybrid` = BM25 + dense fused with RRF (deterministic,
 *  replay-safe). `hybrid+rerank` adds a rerank stage (Phase 2). */
export type RetrievalMode = 'dense' | 'hybrid' | 'hybrid+rerank';
const DEFAULT_RRF_K = 60;
const HYBRID_CANDIDATES = 24; // per-channel candidate pool before fusion/truncation
import { resolveHeadlessAi } from '../../host/headlessAi.js';
import type { ChatMessage, ContentPart } from '../../providers/dispatch.js';
import { checkMediaBudget, recordMediaUsage } from '../../aiProviders/mediaBudget.js';
import { AUDIO_TRANSCRIPTION_SYSTEM_PROMPT, AUDIO_TRANSCRIPTION_USER_PROMPT } from '../../aiProviders/mediaTranscriptionPrompts.js';
import { createLogger } from '../../observability/logger.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerRetentionPurger } from '../../host/retentionPurger.js';
import { fireKnowledgeDocumentChanged } from '../../host/knowledgeLifecycle.js';
import { createWebResearchSurface } from '../../host/webResearchSurface.js';
import { kbMutated, type KbEmitOptions, type KbReindexFailReason } from './emit.js'; // ADR 0643 D3 — the ONE emit helper
import { connectionExists } from '../connections/connectionsService.js';
import { listAssets as listMediaAssets, getCollection as getMediaCollection } from '../media/mediaService.js'; // ADR 0398 P2 — kb→media READ only (one-directional; media never imports kb)
import { checkEmbedBudget, recordEmbedUsage, estimateTokens } from './embedBudget.js'; // ADR 0398 P3
import { connectionRerank, RERANK_PROVIDER } from './externalReranker.js';
import type { KnowledgeRetrieveArgs, KnowledgeResult } from '../../host/knowledgeSurface.js';
import { registerCredentialRefConsumer } from '../../host/credentialRefRegistry.js';
// ADR 0643 D1b — the scheduler-driven drain. INLINE here rather than in a sibling
// module, for the reason `knowledgeSyncService` gives for the identical shape: a
// `kbReindexWorkflow.ts` would have to import `startReindex` while this file
// imports it back, and that cycle is what the precedent avoids.
import { getChain, expandChain } from '../../host/workflowChainPackLoader.js';
import { registerWorkflowDurable, getRegisteredWorkflowAsync } from '../../host/workflowsRegistry.js';
import { withHostLifecycle, withLifecycle } from '../../host/workflowLifecycle.js';
import { recordOwnership } from '../../host/workflowOwnership.js';
import { recordRevision } from '../../host/workflowRevisions.js';
import { registerJob, deleteJob } from '../../host/schedulingService.js';
// ADR 0605 Tier 4 — the SINGLE source for how the host fences untrusted content
// before it reaches a model. Reused here rather than re-spelled.
//
// ADR 0605 R1 CORRECTION (review LOW 9) — this comment used to end "…so this
// lane cannot drift from the chat/dispatch lanes that were already correct",
// and that is NOT accurate. The three lanes share the MODULE, not the
// TREATMENT: this one calls `fenceUntrustedBlock` (defangs the BEGIN/END
// delimiters and preserves structure) while `agentDispatch.ts:727` and
// `agentKnowledgeComposition.ts:109` call `fenceUntrustedItems` over items each
// run through `neutralizeUntrusted` (which additionally COLLAPSES whitespace).
// So the untrusted chunk BODY is defanged here but not whitespace-neutralized,
// and a claim of drift-proofness overstates what a shared import buys.
//
// The difference is DELIBERATE and argued at `buildRagContextBlock` — a KB chunk
// is a document excerpt whose newlines carry meaning, which is the case
// `fenceUntrustedBlock` exists for, and the same treatment tool results get. The
// title, which has no structure worth keeping, IS collapsed. What was wrong was
// the sentence, not the choice: stating the difference is the honest form, and
// "we import the same file" is not by itself an anti-drift property.
import { fenceUntrustedBlock, neutralizeUntrusted } from '../../host/untrustedContent.js';

const log = createLogger('features.kb');

const MAX = {
  name: 160,
  description: 1000,
  title: 200,
  /** Per-document source text. Bounded — the whole blob is stored durably. Sized to hold a
   *  full long-audio transcript (a ~64k-token output ≈ ~260k chars; ADR 0111 review) so the
   *  durable cap doesn't truncate below what the model produced. */
  text: 400_000,
  query: 2000,
  perOrgCollections: 500,
  perCollectionDocs: 1000,
  topK: 50,
  /** Max collections a single tenant-wide retrieve fans out across (ctx.knowledge
   *  / ctx.features.kb.retrieve). Bounds the per-call work on the workflow hot
   *  path — a tenant with thousands of collections can't make one retrieve scan
   *  them all. Truncation is logged, not silent. */
  retrieveCollections: 50,
  /** Chunking: ~chars per chunk + overlap. Char-window with sentence-ish
   *  boundary preference; deterministic so re-chunk on hydrate is identical.
   *  NOTE: changing these re-chunks documents — on a PERSISTED vector backend
   *  (pgvector) a collection ingested under the old params needs a re-index
   *  (delete + re-ingest) to avoid stale id↔text pairing. The default in-memory
   *  surface re-derives the whole namespace each process, so it's self-consistent. */
  chunkChars: 1200,
  chunkOverlap: 150,
  chunksPerDoc: 1000,
} as const;

/** Text-like MIME types we can extract from a Media asset. Binary/complex
 *  formats (PDF/Office) are deferred (ADR open question). */
const TEXT_MIME = /^(text\/|application\/(json|xml|x-ndjson|markdown)$)/i;

/** The features that own an ADR 0100 auto-managed collection. */
export type ManagedSource = 'strategy' | 'priority-matrix' | 'production' | 'docs' | 'kickbot';

/**
 * KB-1 R2 — the PRIVILEGED fields, and why they live in a SECOND PARAMETER.
 *
 * `collectionId` and `managed` are not user input. A caller that picks a collection's
 * id picks its vector namespace and can COLLIDE with an existing row; a caller that
 * sets `managed` mints a collection `assertNotManaged` + `startReindex` refuse to edit,
 * delete or reindex — permanently, with no unlock path.
 *
 * R1 fixed this by having ONE route enumerate the fields it forwards. That closed one
 * door: `createCollection` still honoured both fields, and THREE sibling routes hand it
 * a raw `req.body` behind a TypeScript cast that is erased at runtime
 * (`features/agent-knowledge/routes.ts`, `features/profile-memory/knowledgeRoutes.ts`,
 * `features/projects/routes.ts`). So an org-A member with `workspace:write` could still
 * POST `{name:'x', collectionId:'mgd-strategy-<myOrg>'}` and REPLACE the org's managed
 * Strategy KB row — dropping `activeSignature`, which moves `collectionNamespace()` off
 * the `#<sig>` suffix so the org's strategy KB silently returns NOTHING while its
 * documents and vectors sit intact.
 *
 * The lesson the R1 shape got wrong: a per-route pick is a promise every future route
 * must remember to keep. The SERVICE is the choke point, so the privileged fields ride
 * a parameter a route physically cannot forge by forwarding a body — and the untrusted
 * `input` is REFUSED at runtime if it carries one anyway (a 400, never a silent drop:
 * silence would make the same exploit a no-op that reads like success).
 */
export interface InternalCollectionFields {
  /** A deterministic id (ADR 0100 managed collections point-look-up theirs). */
  collectionId?: string;
  /** Marks the collection auto-managed by the named feature. */
  managed?: ManagedSource;
  /** ADR 0608 D4 (`CPC-2`) — the membership-scoped Subject this collection was
   *  created for / bound to. SERVER-SET only: a network caller must never be able
   *  to claim (or clear) a binding, which is why it lives here and is listed in
   *  `PRIVILEGED_COLLECTION_FIELDS`. */
  boundSubject?: Subject;
}

/** KB-1 R2 — the privileged document fields (see `InternalCollectionFields`).
 *  `documentId` is the stable-id/clobber vector, `revision` corrupts the staleness
 *  log the ADR 0351 seam keys off, and `contentTrust` is the prompt-injection fence. */
export interface InternalDocumentFields extends KbEmitOptions {
  documentId?: string;
  revision?: number;
  contentTrust?: 'trusted' | 'untrusted';
  /* `origin` / `silent` (ADR 0643 D3) ride here for the same reason the three
   * above do: they are decisions only an in-process caller may express. A route
   * body never reaches them (`ingestDocument` reads them from THIS argument only). */
}

const PRIVILEGED_COLLECTION_FIELDS = ['collectionId', 'managed', 'boundSubject'] as const;
const PRIVILEGED_DOCUMENT_FIELDS = ['documentId', 'revision', 'contentTrust'] as const;

/**
 * Refuse a privileged field that arrived through the UNTRUSTED `input` object.
 *
 * Deliberately a THROW, not a strip. A route that forwards `req.body` is expressing an
 * intent it does not have the authority to express; answering 201-with-a-different-id
 * would hand an attacker a success response for a rejected write, and would hide the
 * forwarding bug from whoever wrote the route. Only a field that is actually PRESENT
 * (`!== undefined`) trips it, so a spread of an optional-but-unset property is fine.
 */
function assertNoPrivilegedFields(input: unknown, fields: readonly string[], what: string): void {
  if (!input || typeof input !== 'object') return;
  const rec = input as Record<string, unknown>;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(rec, field) && rec[field] !== undefined) {
      throw new OpenwopError('validation_error', `\`${field}\` is not caller-settable on a ${what}.`, 400, { field });
    }
  }
}

export interface KnowledgeCollection {
  collectionId: string;
  tenantId: string;
  orgId: string;
  name: string;
  description?: string;
  documentCount: number;
  chunkCount: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when the collection is AUTO-MANAGED by another feature that keeps it in
   * sync with its own entities (ADR 0100) — e.g. `'strategy'` mirrors the org's
   * shared strategies, `'priority-matrix'` its ideas. A managed collection is
   * fed only through `upsertDocument`/`deleteDocument` by its owning feature;
   * the KB routes REJECT hand-edits on it (so the UI's read-only treatment is
   * enforced server-side, not just hidden). Absent on user-created collections.
   */
  managed?: ManagedSource;
  /**
   * ADR 0608 D4 (`CPC-2`) — the membership-scoped Subject that owns this
   * collection's READ visibility, when one exists (today: a `kind:'project'`
   * subject, stamped by `features/projects/projectKnowledgeService.ts` at create
   * and at bind). A KB collection is an ORG-owned row, so the KB doors gate on
   * org scope — but a collection created THROUGH a `private` project's door was
   * readable, titles and verbatim chunk text, by any org reader who is not a
   * member. Two doors, same rows, opposite answers.
   *
   * When present, the KB doors additionally resolve this subject through the
   * ADR 0054 D5 `subjectAccess` seam and fail closed (uniform 404). Absent ⇒
   * unchanged org-scope behaviour, so every collection that is genuinely just an
   * org resource is untouched.
   */
  boundSubject?: Subject;
  /** ADR 0113 — per-collection retrieval pipeline config. Absent ⇒ the env
   *  default (`OPENWOP_KB_RETRIEVAL_MODE`, itself defaulting to `dense`). */
  retrievalConfig?: RetrievalConfig;
  /** ADR 0351 — `<mode>:<model>:<dims>` of the vectors last written to this
   *  collection's namespace. A mismatch with the effective config means the
   *  namespace holds STALE vectors (wrong model/width) and MUST be wiped +
   *  rebuilt before the dense channel is trustworthy (pgvector persists across
   *  processes, so the in-process `hydrated` map alone can't catch this). */
  vectorSignature?: string;
  /** ADR 0398 P3 — per-collection embedding spec (pins THIS collection's provider+model,
   *  independent of the tenant default and of other collections). Absent ⇒ derived from
   *  `retrievalConfig.embedder` (backward-compat: `provider` = the tenant headless default). */
  embeddingSpec?: EmbeddingSpec;
  /** ADR 0398 P3 — the signature of the vectors currently SERVING reads. When set, the
   *  active vector namespace is `${collectionId}#${activeSignature}` (a reindex builds the
   *  next signature in a staging namespace, then flips this atomically). Absent ⇒ the
   *  namespace is the bare `collectionId` (backward-compatible). */
  activeSignature?: string;
  /** ADR 0398 P3 — the signature a reindex job is currently BUILDING (staging). */
  pendingSignature?: string;
}

/** ADR 0398 P3 — a per-collection embedding spec. `provider:'local'` = the deterministic
 *  hash floor; a learned provider pins the model. `dims` is forward-compat (the deployment's
 *  vector-store width wins today — one namespace = one width). `credentialRef` optionally
 *  pins a specific BYOK ref (else the provider-name convention / tenant default). */
export interface EmbeddingSpec {
  provider: 'local' | 'openai' | 'google' | 'cohere';
  model?: string;
  dims?: number;
  credentialRef?: string;
}

/** ADR 0113 retrieval config — `mode` is the user-facing lever; the optional
 *  rerank sub-config selects the local (default) vs external (Phase 4, CSG-KB-8)
 *  reranker. `connection` resolves the caller's `cohere-rerank` connection via
 *  the broker (no per-collection connection pin — one selection choke point). */
export interface RetrievalConfig {
  mode?: RetrievalMode;
  rerank?: { kind: 'local' | 'connection'; topN?: number };
  /** ADR 0351 Phase 4 — contextual enrichment of the EMBEDDED text (the stored
   *  chunk text stays raw): `heading-path` prefixes each chunk with
   *  `[title > nearest heading]` so retrieval carries document context.
   *  Deterministic (replay-safe, free). Default off. */
  enrichment?: 'off' | 'heading-path';
  /** ADR 0351 Phase 1 — which embedder vectorizes this collection. `local` =
   *  the deterministic hash embedder (default, zero-config). `provider` = the
   *  tenant's BYOK default AI provider's embeddings API (openai/google),
   *  requested at the vector store's configured width. When `provider` can't
   *  resolve, dense retrieval degrades HONESTLY to lexical-only (labeled). */
  embedder?: 'local' | 'provider';
}

/** The effective embed width: pgvector deployments fix it via
 *  `OPENWOP_VECTOR_PG_DIM`; otherwise the local default (256). Provider
 *  embeddings are REQUESTED at this width (Matryoshka truncation), so one
 *  namespace always holds one width. */
function effectiveEmbedDims(): number {
  const v = Number(process.env.OPENWOP_VECTOR_PG_DIM);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_EMBEDDING_DIMS;
}

function resolveEmbedderMode(col: Pick<KnowledgeCollection, 'retrievalConfig' | 'embeddingSpec'>): 'local' | 'provider' {
  // ADR 0398 P3 — an explicit embeddingSpec wins; else the legacy embedder field.
  if (col.embeddingSpec) return col.embeddingSpec.provider === 'local' ? 'local' : 'provider';
  return col.retrievalConfig?.embedder ?? 'local';
}

/** ADR 0398 P3 — the vector namespace serving a collection's reads. `override` targets a
 *  specific signature (the reindex staging namespace); only a reindexed collection carries
 *  an `activeSignature`, so cutover stays an atomic flip with no vector copy.
 *
 *  KB-1 (SECURITY). The namespace used to be the BARE `collectionId`, and the vector
 *  surface is scoped per TENANT only — so two collections in the same tenant sharing an
 *  id share a vector namespace. That was safe solely by an invariant nothing enforced
 *  ("collection ids are random UUIDs or embed their own orgId"), and `KB-1` broke it: the
 *  create route passed the caller's body straight through, so an org-A member could mint
 *  `mgd-strategy-<orgB>` (the managed convention is deterministic and in-tree,
 *  `strategyKnowledgeService.ts:40`) and read org B's chunk `metadata.text` out of the
 *  shared namespace. The org is now IN the namespace, so the isolation is structural and
 *  does not depend on how an id was chosen. */
export function collectionNamespace(col: Pick<KnowledgeCollection, 'collectionId' | 'orgId' | 'activeSignature'>, override?: string): string {
  const sig = override ?? col.activeSignature;
  const base = `${col.orgId}/${col.collectionId}`;
  return sig ? `${base}#${sig}` : base;
}

/** The PRE-KB-1 namespace (bare `collectionId`), retained ONLY so the vectors written
 *  under it can be reclaimed. See `gcLegacyNamespace`. Never used for a read or a write. */
function legacyCollectionNamespace(col: Pick<KnowledgeCollection, 'collectionId' | 'activeSignature'>, override?: string): string {
  const sig = override ?? col.activeSignature;
  return sig ? `${col.collectionId}#${sig}` : col.collectionId;
}

/**
 * KB-1 MIGRATION — reclaim the vectors a collection wrote under its pre-org namespace.
 *
 * The namespace is DERIVED, never stored, so the cutover itself is atomic at deploy: the
 * first search after the change finds `hydrated` empty (the marker map is process-local
 * and has no boot hydration) and rebuilds the collection into the ORG-scoped namespace.
 * Local mode re-embeds deterministically and for free; provider mode reads the durable
 * per-chunk vector cache — which is keyed `${tenantId}:${documentId}:${chunkIndex}` and
 * therefore UNAFFECTED by the namespace — so the migration costs CPU, not provider spend.
 *
 * What is NOT free is the residue: on a persisted backend the old namespace's rows would
 * linger forever, carrying the chunk text in `metadata`, with nothing left to reach them.
 * So the rebuild also deletes them. This is a self-healing per-collection migration rather
 * than a boot sweep, on purpose — it runs exactly where the ids are already computed, is
 * bounded by the collection's own chunk count, and needs no all-tenant enumeration
 * primitive (which this host does not have). Best-effort: a failed GC must never fail a
 * search, and the next rebuild retries it.
 */
async function gcLegacyNamespace(tenantId: string, col: KnowledgeCollection, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const legacy = legacyCollectionNamespace(col);
  if (legacy === collectionNamespace(col)) return; // defensive: never delete the live namespace
  try {
    await vectorSurface(tenantId).delete({ namespace: legacy, ids });
  } catch (err) {
    log.warn('kb_legacy_namespace_gc_failed', { tenantId, collectionId: col.collectionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** ADR 0351 P4 — `[docTitle > nearest heading]` prefix for the EMBEDDED text.
 *  Chunks are substrings of the durable doc text, so indexOf locates the chunk
 *  and the last markdown heading before it names its section. Deterministic. */
/** ADR 0398 P1 — the enrichment prefix now consumes the chunk's INTRINSIC `headingPath`
 *  (from the structural chunker), not a re-scan of the preceding text. One derivation of
 *  the heading path → the embedded prefix and the display metadata can never disagree, and
 *  the fragile `indexOf(chunk)` (which mis-resolves a chunk substring that appears twice)
 *  is gone. Format unchanged: `[docTitle > nearest-2-headings]\n<chunk>`. */
function enrichWithPath(title: string, headingPath: readonly string[], chunk: string): string {
  const path = [title, ...headingPath.slice(-2)].filter(Boolean).join(' > ');
  return path ? `[${path}]\n${chunk}` : chunk;
}

function enrichmentOf(col: Pick<KnowledgeCollection, 'retrievalConfig'> | null | undefined): 'off' | 'heading-path' {
  return col?.retrievalConfig?.enrichment === 'heading-path' ? 'heading-path' : 'off';
}

/** The env-level default retrieval mode (a host operator can lift the floor for
 *  all collections without per-collection edits). Defaults to today's `dense`. */
function envDefaultMode(): RetrievalMode {
  const v = process.env.OPENWOP_KB_RETRIEVAL_MODE;
  return v === 'hybrid' || v === 'hybrid+rerank' ? v : 'dense';
}

/** Resolve the effective retrieval mode for a collection: per-collection config
 *  wins, else the env default. */
export function resolveRetrievalMode(col: Pick<KnowledgeCollection, 'retrievalConfig'>): RetrievalMode {
  return col.retrievalConfig?.mode ?? envDefaultMode();
}

// A document records HOW it was sourced, but NOT the media capability token: the
// token is a credential, and the text is already extracted durably, so storing
// it would leak asset access to any workspace:read member who lists documents
// (and it has no post-ingest value — media assets are immutable token-addressed
// blobs). Provenance is the kind only.
export type DocSource = { kind: 'text' } | { kind: 'media' } | { kind: 'url'; url: string };

export interface KnowledgeDocument {
  documentId: string;
  collectionId: string;
  tenantId: string;
  orgId: string;
  title: string;
  source: DocSource;
  /** Content-trust provenance (RFC 0021 / ADR 0038 §C). `'untrusted'` for
   *  provider/trigger-derived content (Google Drive import, webhook/email/form
   *  auto-ingest) AND for any FILE/media upload — extracted content is never
   *  human-reviewed, so hidden/adversarial text can't be injected agent-trusted
   *  (ADR 0108 review hardening). `'trusted'` only for directly-pasted text.
   *  Absent on docs stored before this field ⇒ treated as `'trusted'`. Carried
   *  onto every chunk so dispatch can fence untrusted content. */
  contentTrust?: 'trusted' | 'untrusted';
  /** The durable source of truth; chunks are re-derived from this. */
  text: string;
  chunkCount: number;
  /** ADR 0351 Phase 3 — monotonic content revision; rows written before
   *  versioning (absent) read back as 1. Bumped ONLY by a stable-id upsert
   *  whose content actually changed. */
  revision?: number;
  createdBy: string;
  createdAt: string;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  chunkIndex: number;
  text: string;
  score: number;
  contentTrust: 'trusted' | 'untrusted';
  /** ADR 0398 P1 — the heading path (ancestor chain) of the chunk's section, from the
   *  structural chunker. Populates `KnowledgeResult.headingPath` for citation display. */
  headingPath: string[];
}

const collections = new DurableCollection<KnowledgeCollection>('kb:collection', (c) => `${c.tenantId}:${c.orgId}:${c.collectionId}`);

/**
 * ADR 0643 D1a R2 (review Blocker 1 / Should 4) — the ONE compare-and-swap writer for the
 * collection row. `apply` receives the FRESH row and returns the next one (or `null` to
 * abandon); the swap retries up to 4 times, the same shape as `commitReindexJob` and
 * `recordOwnership` (`workflowOwnership.ts:91-99`).
 *
 * WHY THE ROW NEEDS ONE, measured rather than asserted. The whole file was written as
 * "read `col`, do something long, put `col` back", and the long part is not bounded: the
 * reindex cutover holds its `col` across MINUTES of provider `embed()` calls before
 * flipping four signature fields on it. Any concurrent whole-row `put` that read before
 * the flip and wrote after it therefore did not lose one field — it REVERTED THE ENTIRE
 * CUTOVER (`activeSignature` gone, `embeddingSpec` rolled back, `pendingSignature`
 * restored as a phantom build) and pointed serving back at a namespace the cutover had
 * already GC'd, unrecoverably, because the job is `done` and every later cancel or drain
 * is refused. Arbitrating on the JOB row cannot make that safe: the two writers race on
 * the COLLECTION row, and only a CAS there can see it.
 *
 * The corollary rule for callers: apply a DELTA to `fresh`, never a value computed from a
 * row you read earlier (`fresh.documentCount + 1`, not `mine.documentCount`). A CAS that
 * re-writes a stale snapshot is a lost update that merely retries until it wins.
 */
async function commitCollection(
  tenantId: string,
  orgId: string,
  collectionId: string,
  apply: (fresh: KnowledgeCollection) => KnowledgeCollection | null,
): Promise<KnowledgeCollection | null> {
  const key = `${tenantId}:${orgId}:${collectionId}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fresh = await collections.get(key);
    if (!fresh) return null;
    const next = apply(fresh);
    if (!next) return fresh;
    if (casInterferenceForTest) await casInterferenceForTest(key, attempt);
    if (await collections.compareAndSwap(fresh, next)) return next;
  }
  // Persistent contention. Refuse rather than fall back to a blind put: the write this
  // helper exists to protect is a cutover, and a last-writer-wins tail would reintroduce
  // exactly the revert it prevents.
  //
  // ADR 0643 R3 review (Should 5) — and REFUSE means THROW. This used to `return
  // collections.get(key)` — the LIVE row, indistinguishable to every caller from a row
  // it had just committed: `setRetrievalConfig` answered 200 carrying the OLD config,
  // and the cutover had already claimed its job `done` and then left the collection
  // un-flipped with `pendingSignature` stuck — a silently lost reindex, which is the
  // exact outcome the docblock above says this helper refuses. A typed 409 is the
  // honest shape: the caller's write did not land, and it says so.
  log.warn('kb_collection_cas_exhausted', { tenantId, collectionId });
  throw new OpenwopError('conflict', 'The collection was modified concurrently too many times; retry the operation.', 409, { collectionId, reason: 'collection_cas_exhausted' });
}

/** The one predicate for "that 409 was `commitCollection` giving up" — the eraser (R4
 *  NIT 5), the hydrate read lane (R4 NIT 4) and the cutover (R4 Should 1) all branch on it. */
function isCasExhausted(err: unknown): boolean {
  return err instanceof OpenwopError && err.httpStatus === 409 && (err.details as { reason?: unknown } | undefined)?.reason === 'collection_cas_exhausted';
}

/** Test-only seam (ADR 0643 R3 / Should 5) — runs between `commitCollection`'s read and
 *  its CAS on every attempt, so a witness can simulate a concurrent writer that keeps
 *  winning and prove exhaustion is LOUD. `null` in production. */
let casInterferenceForTest: ((key: string, attempt: number) => Promise<void>) | null = null;
export function _setCollectionCasInterferenceForTest(fn: ((key: string, attempt: number) => Promise<void>) | null): void {
  casInterferenceForTest = fn;
}
const documents = new DurableCollection<KnowledgeDocument>('kb:document', (d) => `${d.tenantId}:${d.orgId}:${d.documentId}`);

/** Vector namespaces rebuilt this process-lifetime, keyed
 *  `${tenantId}:${orgId}:${collectionId}` → the embedder SIGNATURE they were built
 *  with. The in-memory vector surface is ephemeral; the first access after a restart
 *  re-derives the namespace from durable documents (local mode) or the durable vector
 *  cache (provider mode).
 *
 *  KB-1 — the org is in the key for the same reason it is in the NAMESPACE: two
 *  collections in one tenant sharing an id must not share a hydrate marker, or org A's
 *  rebuild would mark org B's namespace fresh and suppress its rebuild. */
const hydrated = new Map<string, string>();
const hydrateKey = (tenantId: string, orgId: string, collectionId: string): string => `${tenantId}:${orgId}:${collectionId}`;

/** ADR 0351 — durable per-chunk provider-embedding cache, keyed
 *  `${tenantId}:${documentId}:${chunkIndex}`. Tenant-prefixed (KB-CODE-4):
 *  `documentId` is caller-suppliable on stable-id ingest, so an unscoped key
 *  would let one tenant's rows collide with (and be purged by) another's. A row
 *  is valid only when BOTH `model` and `textHash` match; hydrate re-embeds the
 *  rest. Keeps provider cost at ~one embed per chunk per LIFETIME, not per process. */
interface VecCacheRow { key: string; tenantId: string; model: string; textHash: string; vector: number[] }
const vecCache = new DurableCollection<VecCacheRow>('kb:veccache', (r) => r.key);

const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

const vecCacheDocPrefix = (doc: Pick<KnowledgeDocument, 'tenantId' | 'documentId'>): string => `${doc.tenantId}:${doc.documentId}:`;

async function purgeVecCacheForDoc(doc: KnowledgeDocument): Promise<void> {
  for (const row of await vecCache.listByPrefix(vecCacheDocPrefix(doc))) await vecCache.delete(row.key);
}

/** ADR 0351 Phase 3 — a COMPACT per-document revision log (hash + title + when,
 *  never the full text: a 400k-char body ×20 revisions would strain the durable
 *  store for what staleness detection needs — change identity, not content).
 *  Keyed `${tenantId}:${documentId}:<rev>` (tenant-scoped, KB-CODE-4).
 *  Correction vs the ADR's "prior row retained": recorded there. Cap 20/doc. */
interface DocRevisionRow { key: string; tenantId: string; documentId: string; revision: number; textHash: string; title: string; changedAt: string }
const docRevisions = new DurableCollection<DocRevisionRow>('kb:docrev', (r) => r.key);
const DOC_REVISION_CAP = 20;

const docRevisionPrefix = (tenantId: string, documentId: string): string => `${tenantId}:${documentId}:`;

async function recordDocRevision(doc: KnowledgeDocument, revision: number): Promise<void> {
  await docRevisions.put({ key: `${docRevisionPrefix(doc.tenantId, doc.documentId)}${String(revision).padStart(6, '0')}`, tenantId: doc.tenantId, documentId: doc.documentId, revision, textHash: textHash(doc.text), title: doc.title, changedAt: new Date().toISOString() });
  const rows = (await docRevisions.listByPrefix(docRevisionPrefix(doc.tenantId, doc.documentId))).sort((a, b) => a.revision - b.revision);
  for (const stale of rows.slice(0, Math.max(0, rows.length - DOC_REVISION_CAP))) await docRevisions.delete(stale.key);
}

/** KB-8 — `${tenantId}:${documentId}` of every upsert currently between its internal
 *  delete and its re-ingest. `purgeOrphanKbDerivedRows` skips these: for that window the
 *  document row is absent, which is indistinguishable from "deleted" to an orphan scan.
 *  Per-process (so is the sweep daemon); the residual is recorded at the read site. */
const upsertsInFlight = new Set<string>();

/** KB-8 test seam — which upserts are mid-replace right now. Read-only. */
export function _kbUpsertsInFlightForTest(): string[] { return [...upsertsInFlight]; }

/** KB-8 test seam — hold the marker across `fn` so the purger's guard can be
 *  asserted deterministically instead of by racing microtasks against a real upsert
 *  (the wiring of the marker INTO `upsertDocument` is asserted separately). */
export async function _holdUpsertInFlightForTest<T>(tenantId: string, documentId: string, fn: () => Promise<T>): Promise<T> {
  const k = `${tenantId}:${documentId}`;
  upsertsInFlight.add(k);
  try { return await fn(); } finally { upsertsInFlight.delete(k); }
}

/** Drop a document's revision log — user-facing deletes only (KB-CODE-10); the
 *  stable-id upsert path PRESERVES it (the log is the point of the upsert). */
async function purgeDocRevisionsForDoc(doc: Pick<KnowledgeDocument, 'tenantId' | 'documentId'>): Promise<void> {
  for (const row of await docRevisions.listByPrefix(docRevisionPrefix(doc.tenantId, doc.documentId))) await docRevisions.delete(row.key);
}

/** The compact revision history for a document (newest first). */
export async function listDocumentRevisions(tenantId: string, orgId: string, collectionId: string, documentId: string, caller?: SubjectCaller): Promise<Array<Omit<DocRevisionRow, 'key' | 'tenantId'>>> {
  const doc = await getDocument(tenantId, orgId, collectionId, documentId, caller); // KBC-1
  if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId });
  return (await docRevisions.listByPrefix(docRevisionPrefix(tenantId, documentId)))
    .sort((a, b) => b.revision - a.revision)
    .map(({ key: _k, tenantId: _t, ...rest }) => rest);
}

// ─── chunking (deterministic) ──────────────────────────────────────────────

/** ADR 0398 P1 — the chunker's identity, folded into the `vectorSignature` so an
 *  algorithm change is caught as a signature mismatch and drives a re-chunk (rather
 *  than silently mixing chunk shapes in one namespace). v1 = the pre-0398 char-window
 *  splitter; v2 = the structure-first (heading-aware) chunker below. Collections
 *  ingested before this read back as v1 and re-chunk lazily on the next hydrate. */
export const CHUNKER_VERSION = 2;

/** One chunk plus the heading path (ancestor chain) of the section it belongs to. */
export interface StructuredChunk { text: string; headingPath: string[] }

/** A markdown section: a heading line + its body up to the next heading, with the
 *  heading-nesting path that names it (a level-2 under a level-1 → `[h1, h2]`). Text
 *  before the first heading is a section with an empty path. */
interface DocSection { headingPath: string[]; body: string }

/** Split CRLF-normalized text into sections at `^#{1,6}` headings. The heading line is
 *  KEPT in the section body (so its text is embedded/searchable); `headingPath` is the
 *  nesting chain to that heading. Deterministic. */
function splitIntoSections(clean: string): DocSection[] {
  const sections: DocSection[] = [];
  let stack: Array<{ level: number; title: string }> = [];
  let cur: string[] = [];
  let curPath: string[] = [];
  const flush = (): void => {
    const body = cur.join('\n').trim();
    if (body.length > 0) sections.push({ headingPath: [...curPath], body });
    cur = [];
  };
  for (const line of clean.split('\n')) {
    const m = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      stack = stack.filter((s) => s.level < level); // pop to the parent level
      stack.push({ level, title: m[2]!.trim() });
      curPath = stack.map((s) => s.title);
      cur = [line]; // the heading line opens its section's body
    } else {
      cur.push(line);
    }
  }
  flush();
  return sections;
}

/** Today's char-window splitter, extracted — packs one section's body into overlapping
 *  windows with a paragraph/sentence-boundary preference. Deterministic. Overlap is
 *  applied only WITHIN this call, so it never crosses a heading boundary. */
function windowSplit(sectionBody: string): string[] {
  const clean = sectionBody.trim();
  if (clean.length === 0) return [];
  const out: string[] = [];
  let pos = 0;
  while (pos < clean.length) {
    let end = Math.min(pos + MAX.chunkChars, clean.length);
    if (end < clean.length) {
      // Prefer a boundary (paragraph, then sentence, then space) in the last
      // ~20% of the window so chunks don't split mid-sentence.
      const windowStart = pos + Math.floor(MAX.chunkChars * 0.8);
      const slice = clean.slice(windowStart, end);
      const para = slice.lastIndexOf('\n\n');
      const sent = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
      const space = slice.lastIndexOf(' ');
      const rel = para >= 0 ? para : sent >= 0 ? sent + 1 : space;
      if (rel >= 0) end = windowStart + rel + 1;
    }
    const chunk = clean.slice(pos, end).trim();
    if (chunk.length > 0) out.push(chunk);
    if (end >= clean.length) break;
    pos = Math.max(end - MAX.chunkOverlap, pos + 1); // non-regression guard: always advances
  }
  return out;
}

/** ADR 0398 P1 — the structure-first chunker (the ONE chunking source of truth).
 *  Segments the document on heading structure FIRST, then packs each section into
 *  windows (a short section = one chunk; a long section sub-splits, overlapping within
 *  the section only) so a chunk never straddles two unrelated headings and a heading is
 *  never orphaned from its body. Each chunk carries its section's `headingPath`.
 *  Deterministic: same text → same chunks (so hydrate re-chunk matches ingest). */
export function chunkStructured(text: string): StructuredChunk[] {
  const clean = text.replace(/\r\n/g, '\n').trim(); // CRLF FIRST — the heading regex is ^-anchored
  if (clean.length === 0) return [];
  const out: StructuredChunk[] = [];
  for (const section of splitIntoSections(clean)) {
    for (const piece of windowSplit(section.body)) {
      if (out.length >= MAX.chunksPerDoc) return out; // cap total chunks per doc
      out.push({ text: piece, headingPath: section.headingPath });
    }
  }
  return out;
}

/** The chunk texts only — a thin wrapper over the ONE chunker (`chunkStructured`) so
 *  every deriver (`chunkRows`/`chunkMetaRows`/`chunkIds`) agrees on the same sequence.
 *  Deterministic (the determinism test + the re-chunk-on-hydrate invariant depend on it). */
export function chunkText(text: string): string[] {
  return chunkStructured(text).map((c) => c.text);
}

function vectorSurface(tenantId: string) {
  return buildHostSurfaceBundle({ tenantId }).db.vector;
}

interface ChunkRow { id: string; vector: number[]; metadata: { documentId: string; chunkIndex: number; title: string; text: string; contentTrust: 'trusted' | 'untrusted'; headingPath: string[] } }

/** Build the chunk rows for one document (deterministic ids + vectors). Carries
 *  the document's content-trust onto every chunk (ADR 0038 §C) so retrieval +
 *  dispatch can fence untrusted content. */
function chunkRows(doc: KnowledgeDocument, enrich: 'off' | 'heading-path' = 'off'): ChunkRow[] {
  const contentTrust = doc.contentTrust === 'untrusted' ? 'untrusted' : 'trusted';
  // KB-CODE-12: size local hash embeddings to the EFFECTIVE configured width —
  // pgvector enforces OPENWOP_VECTOR_PG_DIM, so a fixed 256 hard-fails every
  // local-mode collection on a provider-sized deployment. Falls back to 256.
  const dims = effectiveEmbedDims();
  return chunkStructured(doc.text).map((c, chunkIndex) => ({
    id: `${doc.documentId}:${chunkIndex}`,
    vector: embedText(enrich === 'heading-path' ? enrichWithPath(doc.title, c.headingPath, c.text) : c.text, dims),
    metadata: { documentId: doc.documentId, chunkIndex, title: doc.title, text: c.text, contentTrust, headingPath: c.headingPath },
  }));
}

/** Just the chunk ids for a document — for vector DELETE, which doesn't need the
 *  (expensive) embeddings `chunkRows` computes. */
function chunkIds(doc: KnowledgeDocument): string[] {
  return chunkText(doc.text).map((_text, i) => `${doc.documentId}:${i}`);
}

/** ADR 0398 P1 — the ids to DELETE when wiping a doc's vectors on a SIGNATURE change.
 *  Covers the UNION of the OLD chunk count (durable `doc.chunkCount`) and the NEW count
 *  (re-chunk), so a chunker change that SHRINKS the count can't orphan the old tail (the
 *  vector surface has no namespace-clear; delete is by explicit id). Bounded by
 *  `MAX.chunksPerDoc`. Callers persist the new `doc.chunkCount` so the invariant
 *  "`doc.chunkCount` == vectors in the namespace" holds across successive reindexes. */
function staleWipeIds(doc: KnowledgeDocument, newCount: number): string[] {
  const n = Math.min(MAX.chunksPerDoc, Math.max(doc.chunkCount ?? 0, newCount));
  return Array.from({ length: n }, (_v, i) => `${doc.documentId}:${i}`);
}

/** ADR 0398 P1 — after a re-chunk (signature change), persist each doc's NEW chunk count
 *  so `doc.chunkCount` stays equal to the vectors actually in the namespace (the invariant
 *  `staleWipeIds` relies on across successive reindexes). Returns the delta to apply to the
 *  collection's running total (added to `col.chunkCount` by the caller before it persists). */
async function reconcileChunkCounts(entries: Array<{ doc: KnowledgeDocument; newCount: number }>): Promise<number> {
  let delta = 0;
  for (const { doc, newCount } of entries) {
    const old = doc.chunkCount ?? 0;
    if (old !== newCount) { delta += newCount - old; doc.chunkCount = newCount; await documents.put(doc); }
  }
  return delta;
}

/** Chunk rows WITHOUT the (expensive) embedding — the lexical/BM25 channel + the
 *  fusion metadata lookup need only `{id, text, trust, …}`, not the vector (ADR
 *  0113). Same ids + same durable text as `chunkRows`, so the two channels agree. */
function chunkMetaRows(doc: KnowledgeDocument): Array<{ id: string; metadata: ChunkRow['metadata'] }> {
  const contentTrust = doc.contentTrust === 'untrusted' ? 'untrusted' : 'trusted';
  return chunkStructured(doc.text).map((c, chunkIndex) => ({
    id: `${doc.documentId}:${chunkIndex}`,
    metadata: { documentId: doc.documentId, chunkIndex, title: doc.title, text: c.text, contentTrust, headingPath: c.headingPath },
  }));
}

/** DEBT-2 — the bounded (tenant, org, collection) document slice. Document keys
 *  are `${tenantId}:${orgId}:${documentId}` (since the feature's first commit,
 *  so every deployed row already carries the prefix — no heal needed), which
 *  makes this an exact storage-level prefix scan of just the org's slice
 *  instead of `list()`'s full cross-tenant scan + in-memory filter. The
 *  tenant/org re-check is belt-and-braces against a pathological tenant id that
 *  is a `:`-prefix of another; `collectionId` isn't in the key, so that filter
 *  stays in memory (bounded to the org's docs). */
async function docsInCollection(tenantId: string, orgId: string, collectionId: string): Promise<KnowledgeDocument[]> {
  return (await documents.listByPrefix(`${tenantId}:${orgId}:`))
    .filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId);
}

/** The collection's chunk corpus (metadata-only) for the lexical channel — the
 *  SAME durable chunk text `hydrate` feeds the dense channel (no parallel corpus). */
async function collectionChunks(tenantId: string, orgId: string, collectionId: string): Promise<Array<{ id: string; metadata: ChunkRow['metadata'] }>> {
  const docs = await docsInCollection(tenantId, orgId, collectionId);
  return docs.flatMap(chunkMetaRows);
}

/** What hydrate resolved for this search: which embedder vectorized the
 *  namespace, and whether the dense channel is usable at all. `denseAvailable:
 *  false` (provider mode, no resolvable embedder) means search MUST degrade to
 *  lexical-only — never silently embed with the wrong model (ADR 0351). */
interface HydrateStatus {
  embedMode: 'local' | 'provider';
  model: string;
  denseAvailable: boolean;
  embedder?: HeadlessEmbedder;
}

/** In-flight hydrates keyed `${tenantId}:${collectionId}` (KB-CODE-5) —
 *  concurrent searches on a cold collection await the SAME rebuild instead of
 *  each re-chunking + re-embedding (double provider spend). Cleared on settle
 *  so a failed hydrate retries fresh on the next search. */
const hydrateInFlight = new Map<string, Promise<HydrateStatus>>();

/** Lazily (re)build a collection's vector namespace, once per process — and
 *  WIPE it first when the embedder signature changed (a persisted pgvector
 *  namespace may hold stale vectors from another model/width). Local mode
 *  re-embeds deterministically; provider mode reads the durable chunk-vector
 *  cache and batch-embeds only misses (ADR 0351 Phase 1). Concurrent callers
 *  share one in-flight rebuild per collection (KB-CODE-5). */
async function hydrate(tenantId: string, orgId: string, collectionId: string): Promise<HydrateStatus> {
  const key = hydrateKey(tenantId, orgId, collectionId);
  const inFlight = hydrateInFlight.get(key);
  if (inFlight) return inFlight;
  const p = doHydrate(tenantId, orgId, collectionId).finally(() => hydrateInFlight.delete(key));
  hydrateInFlight.set(key, p);
  return p;
}

async function doHydrate(tenantId: string, orgId: string, collectionId: string): Promise<HydrateStatus> {
  const key = hydrateKey(tenantId, orgId, collectionId);
  const col = await collectionRow(tenantId, orgId, collectionId);
  const embedMode = col ? resolveEmbedderMode(col) : 'local';
  const dims = effectiveEmbedDims();

  const enrich = enrichmentOf(col);
  // ADR 0398 P3 — the ACTIVE vector namespace (versioned only for reindexed collections;
  // the bare `collectionId` for every existing collection — backward-compatible).
  const ns = col ? collectionNamespace(col) : collectionId;
  if (embedMode === 'local') {
    const sig = `local:${LOCAL_EMBEDDING_MODEL}:${dims}:${enrich}:v${CHUNKER_VERSION}`;
    if (hydrated.get(key) === sig) return { embedMode, model: LOCAL_EMBEDDING_MODEL, denseAvailable: true };
    const docs = await docsInCollection(tenantId, orgId, collectionId); // DEBT-2 — bounded org slice
    // A signature mismatch — including an ABSENT signature on a legacy pre-0351 row (review
    // fix) — drives the wipe+reconcile, so the v1→v2 re-chunk can't leave a stale tail serving.
    const changed = !!(col && col.vectorSignature !== sig);
    const perDoc = docs.map((d) => ({ doc: d, rows: chunkRows(d, enrich) }));
    let chunkDelta = 0;
    if (changed) {
      // Wipe the UNION of old+new ids so a chunker change that shrinks the count doesn't
      // orphan the old tail, then reconcile `chunkCount` so the next reindex wipes correctly.
      const ids = perDoc.flatMap(({ doc, rows }) => staleWipeIds(doc, rows.length));
      if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: ns, ids });
      const delta = await reconcileChunkCounts(perDoc.map(({ doc, rows }) => ({ doc, newCount: rows.length })));
      chunkDelta = delta;
      if (col) col.chunkCount = Math.max(0, col.chunkCount + delta);
    }
    const rows = perDoc.flatMap((p) => p.rows);
    if (rows.length > 0) await vectorSurface(tenantId).upsert({ namespace: ns, items: rows });
    // ADR 0643 D1a R2 — CAS, and as a DELTA. `search` has no reindex guard, so this is the
    // most reachable whole-row writer of all: a hydrate racing a cutover used to revert it.
    if (col && col.vectorSignature !== sig) {
      // R4 NIT 4 — `search` is a READ: a contended signature commit degrades the dense
      // channel for this call (retried next search), it does not 409 the reader.
      try { await commitCollection(tenantId, orgId, collectionId, (fresh) => ({ ...fresh, vectorSignature: sig, chunkCount: Math.max(0, fresh.chunkCount + chunkDelta) })); }
      catch (err) { if (!isCasExhausted(err)) throw err; log.warn('kb_hydrate_signature_commit_contended', { tenantId, collectionId }); return { embedMode, model: LOCAL_EMBEDDING_MODEL, denseAvailable: false }; }
    }
    hydrated.set(key, sig);
    // KB-1 migration — this rebuild is the collection's move into the org-scoped
    // namespace; reclaim what it left behind under the pre-org one.
    if (col) await gcLegacyNamespace(tenantId, col, perDoc.flatMap(({ doc, rows: r }) => staleWipeIds(doc, r.length)));
    return { embedMode, model: LOCAL_EMBEDDING_MODEL, denseAvailable: true };
  }

  // provider mode. ADR 0398 P3 — a per-collection embeddingSpec PINS the provider+model
  // (independent of the tenant default); absent a spec, the legacy `provider` mode resolves
  // the tenant's headless default (backward-compat).
  const embedder = col?.embeddingSpec && col.embeddingSpec.provider !== 'local'
    ? await resolveHeadlessEmbedderForSpecMaybeTest(tenantId, col.embeddingSpec, dims)
    : await resolveHeadlessEmbedderMaybeTest(tenantId, dims);
  if (!embedder) {
    // Honest degrade: no provider ⇒ dense channel OFF (lexical-only). Do NOT
    // mark hydrated — a later search retries (the key may have been configured).
    return { embedMode, model: 'unavailable', denseAvailable: false };
  }
  const sig = `provider:${embedder.model}:${dims}:${enrich}:v${CHUNKER_VERSION}`;
  if (hydrated.get(key) === sig) return { embedMode, model: embedder.model, denseAvailable: true, embedder };

  const docs = await docsInCollection(tenantId, orgId, collectionId); // DEBT-2 — bounded org slice
  // Per-doc chunk rows (metadata only) — the count feeds both the stale-wipe union and
  // the chunkCount reconcile below (ADR 0398 P1).
  const perDocMeta = docs.map((d) => ({ doc: d, meta: chunkMetaRows(d) }));
  if (col && col.vectorSignature !== sig) { // absent-signature legacy row also wipes (review fix)
    const ids = perDocMeta.flatMap(({ doc, meta }) => staleWipeIds(doc, meta.length));
    if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: ns, ids });
    const delta = await reconcileChunkCounts(perDocMeta.map(({ doc, meta }) => ({ doc, newCount: meta.length })));
    col.chunkCount = Math.max(0, col.chunkCount + delta);
    // ADR 0643 D1a R2 — CAS + delta (see `commitCollection`). KBC-3 moved this commit
    // HERE, next to the reconcile that produced it, from the end of the function: the
    // batched embed below can now stop early on the budget, and a delta committed only
    // on completion would be stranded by that stop (the per-document counts are already
    // durable, so the collection's total would drift until the next WHOLE hydrate).
    // The signature is still committed only when the namespace is whole.
    if (delta !== 0) {
      try { await commitCollection(tenantId, orgId, collectionId, (fresh) => ({ ...fresh, chunkCount: Math.max(0, fresh.chunkCount + delta) })); }
      catch (err) { if (!isCasExhausted(err)) throw err; log.warn('kb_hydrate_count_commit_contended', { tenantId, collectionId }); return { embedMode, model: embedder.model, denseAvailable: false }; } // R4 NIT 4 — a read never 409s
    }
  }
  // Assemble rows from the durable cache — ONE prefix scan per document into an
  // in-memory map (KB-CODE-6), not a per-chunk point read — then batch-embed
  // only the misses.
  const cachedByKey = new Map<string, VecCacheRow>();
  for (const d of docs) {
    for (const row of await vecCache.listByPrefix(vecCacheDocPrefix(d))) cachedByKey.set(row.key, row);
  }
  const metaRows = perDocMeta.flatMap((p) => p.meta);
  const rows: ChunkRow[] = [];
  const missing: Array<{ idx: number; text: string; cacheKey: string; hash: string }> = [];
  for (const m of metaRows) {
    // The enrichment prefix consumes the chunk's INTRINSIC headingPath (one derivation).
    const embedInput = enrich === 'heading-path' ? enrichWithPath(m.metadata.title, m.metadata.headingPath, m.metadata.text) : m.metadata.text;
    const hash = textHash(embedInput);
    const cacheKey = `${tenantId}:${m.id}`;
    const cached = cachedByKey.get(cacheKey);
    if (cached && cached.model === embedder.model && cached.textHash === hash && cached.vector.length === dims) {
      rows.push({ id: m.id, vector: cached.vector, metadata: m.metadata });
    } else {
      missing.push({ idx: rows.length, text: embedInput, cacheKey, hash });
      rows.push({ id: m.id, vector: [], metadata: m.metadata }); // placeholder, filled below
    }
  }
  if (missing.length > 0) {
    // KBC-3 (ADR 0643 P8) — BATCHED at `EMBED_BATCH_CHUNKS` and BUDGETED per batch,
    // the way `drainReindex` already is. This used to embed EVERY miss in ONE provider
    // call and never consulted the embed budget: in provider mode a collection above
    // the provider's per-request input ceiling (~2k chunks) threw on every hydrate,
    // which the catch below turned into a PERMANENT lexical-only degrade — and hydrate
    // was the one embed path a tenant could drive for free. Each batch's vectors land
    // in the durable cache BEFORE the next batch is requested, so a failure or a budget
    // stop keeps its progress: the next search re-assembles from the cache and pays
    // only for what is still missing.
    //
    // A budget hit is reported HONESTLY rather than failing the search: the remaining
    // chunks stay un-hydrated, the namespace is NOT upserted (a partial dense space would
    // silently serve only a prefix of the corpus — the KB-2 R2 class), `hydrated` is
    // not set, and the search answers lexical-only with the label.
    let embedded = 0;
    for (let at = 0; at < missing.length; at += EMBED_BATCH_CHUNKS) {
      const batch = missing.slice(at, at + EMBED_BATCH_CHUNKS);
      const batchTokens = batch.reduce((n, m) => n + estimateTokens(m.text), 0);
      const budget = await checkEmbedBudget(tenantId, batchTokens);
      if (budget.exceeded) {
        log.warn('kb_hydrate_embed_budget_reached', { tenantId, collectionId, embedded, pending: missing.length - embedded, cap: budget.cap, used: budget.used });
        return { embedMode, model: embedder.model, denseAvailable: false };
      }
      // KB-CODE-3: a provider hiccup during chunk-embed must DEGRADE the search
      // (labeled lexical-only), not 500 it. Not marked hydrated — the next search
      // retries the rebuild (from the cache, so only the failed batch onward).
      let vectors: number[][];
      try {
        vectors = await embedder.embed(batch.map((x) => x.text));
      } catch (err) {
        log.warn('kb_hydrate_embed_failed', { tenantId, collectionId, chunks: batch.length, embedded, error: err instanceof Error ? err.message : String(err) });
        return { embedMode, model: embedder.model, denseAvailable: false };
      }
      for (let i = 0; i < batch.length; i++) {
        const miss = batch[i]!;
        rows[miss.idx]!.vector = vectors[i]!;
        await vecCache.put({ key: miss.cacheKey, tenantId, model: embedder.model, textHash: miss.hash, vector: vectors[i]! });
      }
      await recordEmbedUsage(tenantId, batchTokens);
      embedded += batch.length;
    }
  }
  if (rows.length > 0) await vectorSurface(tenantId).upsert({ namespace: ns, items: rows });
  // ADR 0643 D1a R2 — CAS (see `commitCollection`); the chunkCount delta was committed
  // beside its reconcile above. This branch spans provider embeds, so its window is the
  // widest of the two — the signature lands only once the namespace is whole.
  if (col && col.vectorSignature !== sig) {
    try { await commitCollection(tenantId, orgId, collectionId, (fresh) => ({ ...fresh, vectorSignature: sig })); }
    catch (err) { if (!isCasExhausted(err)) throw err; log.warn('kb_hydrate_signature_commit_contended', { tenantId, collectionId }); return { embedMode, model: embedder.model, denseAvailable: false }; } // R4 NIT 4 — a read never 409s
  }
  hydrated.set(key, sig);
  // KB-1 migration — see the local-mode branch. Provider mode pays nothing extra:
  // the per-chunk vector CACHE is namespace-independent, so the rebuild is re-assembly,
  // not re-embedding.
  if (col) await gcLegacyNamespace(tenantId, col, perDocMeta.flatMap(({ doc, meta }) => staleWipeIds(doc, meta.length)));
  return { embedMode, model: embedder.model, denseAvailable: true, embedder };
}

// ─── collections ───────────────────────────────────────────────────────────

export async function listCollections(tenantId: string, orgId: string, caller?: SubjectCaller): Promise<KnowledgeCollection[]> {
  // DEBT-2 — collection keys are `${tenantId}:${orgId}:${collectionId}`, so
  // this is an exact bounded prefix scan (filter kept as belt-and-braces).
  const rows = (await collections.listByPrefix(`${tenantId}:${orgId}:`))
    .filter((c) => c.tenantId === tenantId && c.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // KBC-1 — a LISTING is a read door too: the collection NAME of a private
  // project's corpus is itself the leak ADR 0608 D4 closed at the HTTP door.
  return filterReadable(tenantId, rows, caller);
}

/**
 * KBC-1 — drop the rows `caller` may not read, memoizing per bound Subject so a
 * listing resolves each project once rather than once per collection (the same
 * shape `kb/routes.ts` uses for its listing; the fan-out is what makes an
 * unmemoized version an N+1 against the rate limiter).
 */
async function filterReadable(tenantId: string, rows: KnowledgeCollection[], caller: SubjectCaller | undefined): Promise<KnowledgeCollection[]> {
  if (caller?.preAuthorized || !rows.some((c) => c.boundSubject)) return rows;
  const memo = new Map<string, Promise<boolean>>();
  const out: KnowledgeCollection[] = [];
  for (const col of rows) {
    if (!col.boundSubject) { out.push(col); continue; }
    const key = `${col.boundSubject.kind}:${col.boundSubject.id}`;
    let pending = memo.get(key);
    if (pending === undefined) { pending = subjectReadAllowed(tenantId, col.boundSubject, caller); memo.set(key, pending); }
    if (await pending) out.push(col);
  }
  return out;
}

/** Every collection in a tenant, ACROSS its orgs (newest-first). Used by the
 *  `agent-knowledge` feature (ADR 0038) to resolve a bound collectionId back to
 *  its owning org — bindings store only the id (the ADR data model), and KB keys
 *  are tenant+org+collection. Tenant-scoped (CTI-1); no org filter. */
export async function listAllTenantCollections(tenantId: string, caller?: SubjectCaller): Promise<KnowledgeCollection[]> {
  const rows = (await collections.listForTenant(tenantId)) // DEBT-2 — bounded tenant slice (keys are tenant-prefixed)
    .filter((c) => c.tenantId === tenantId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return filterReadable(tenantId, rows, caller); // KBC-1
}

// ADR 0499 — a collection's `embeddingSpec.credentialRef` pins a specific BYOK
// key for embedding. Deleting that secret would leave the collection unable to
// embed new documents while its existing vectors stay readable, so the breakage
// is partial and easy to miss. Scans the tenant slice across orgs (refs are not
// org-scoped).
registerCredentialRefConsumer({
  id: 'kb:collection',
  async describe(tenantId, ref) {
    const rows = await listAllTenantCollections(tenantId, PREAUTHORIZED_CALLER); // KBC-1 — an operator-facing impact scan over the tenant's OWN rows; it reports names it already owns, never chunk text.
    return rows
      .filter((c) => c.embeddingSpec?.credentialRef === ref)
      .map((c) => `knowledge collection "${c.name || c.collectionId}" (embedding key)`);
  },
});


/**
 * ADR 0608 D4 — RELEASE the stamp, but only when it names `subject`.
 *
 * This is the exit, and it is not optional. A stamp names a Subject that can be
 * DELETED, and `resolveSubjectAccess` cannot tell "this project denies you" from
 * "this project no longer exists" — both are `'none'`. So an unreleased stamp
 * turns the collection into permanently unreachable dead data for everyone,
 * including its owners: a gate with no exit, strictly worse than the leak it
 * closes. (Measured during this batch — `notebooks-delete-honesty.test.ts`'s
 * shared-collection CONTROL went red for exactly this reason.)
 *
 * The `subject` match is what stops one project releasing another's scoping.
 */
export async function releaseCollectionBoundSubject(tenantId: string, orgId: string, collectionId: string, subject: Subject): Promise<void> {
  await commitCollection(tenantId, orgId, collectionId, (fresh) => {
    if (fresh.tenantId !== tenantId || fresh.orgId !== orgId) return null;
    if (!fresh.boundSubject || fresh.boundSubject.kind !== subject.kind || fresh.boundSubject.id !== subject.id) return null;
    const { boundSubject: _released, ...rest } = fresh;
    return rest;
  });
}

/**
 * KBC-1 (ADR 0643 D2 precondition) — THE service-level subject gate.
 *
 * ADR 0608 D4 stamped `boundSubject` on a project/notebook collection and mounted
 * the gate on the KB HTTP door. MEASURED at the start of this phase:
 * `resolveSubjectAccess` appeared for KB at exactly TWO sites, both in
 * `kb/routes.ts`, and this service read `boundSubject` only to SET, RELEASE or
 * PROJECT it — never to gate a read. So `buildKbSurface`'s verbs, `tenantRetrieve`,
 * `ctx.knowledge` (every workflow run and every agent chat turn) and
 * `docs/surface.ts` all read straight past it. That is the READ side of the H1
 * leak whose birth site was closed at create time; the corpus was still readable
 * on every non-HTTP lane.
 *
 * The cure is the one the H1 lesson names: gate at the SINGLE COMPOSITION OWNER,
 * not at each door. Every read and write this service serves resolves the
 * collection through `readableCollection` / `mustGetCollection`, so a new door —
 * a surface verb, a node, a feature that imports `kbService` next month —
 * inherits the gate instead of having to remember it. The two route call sites
 * stay as defence in depth.
 *
 * WHAT AN UNAUTHENTICATED RUN MAY READ: nothing that is subject-bound. A
 * schedule-fired or webhook-fired run has no `actingUserId` by construction
 * (`BundleScope.actingUserId` — "absent for system runs, which is the correct
 * fail-closed signal"), so it resolves as an unknown caller and a membership-
 * scoped collection answers `'none'` ⇒ 404. It keeps full access to every
 * collection that is genuinely just an org resource, which is all of them except
 * project- and notebook-bound corpora.
 *
 * An OMITTED `caller` is `{ subject: undefined }` — refused on a bound
 * collection, never a bypass. The bypass is spelled `PREAUTHORIZED_CALLER`.
 */
async function readableCollection(tenantId: string, orgId: string, collectionId: string, caller: SubjectCaller | undefined): Promise<KnowledgeCollection | null> {
  const col = await collectionRow(tenantId, orgId, collectionId);
  if (!col?.boundSubject) return col; // not membership-scoped ⇒ org scope is the whole rule
  return (await subjectReadAllowed(tenantId, col.boundSubject, caller)) ? col : null;
}

/** The raw tenant+org-keyed row, with NO subject gate — the primitive
 *  `readableCollection` and this service's already-authorized internals use.
 *  Never exported: a caller outside this module must go through the gate. */
async function collectionRow(tenantId: string, orgId: string, collectionId: string): Promise<KnowledgeCollection | null> {
  const c = await collections.get(`${tenantId}:${orgId}:${collectionId}`);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

/** One collection (tenant+org-keyed), or null when it does not exist OR the
 *  caller cannot see it — a UNIFORM not-found, so the gate is not an existence
 *  oracle (the same answer shape `kb/routes.ts` gives). */
export async function getCollection(tenantId: string, orgId: string, collectionId: string, caller?: SubjectCaller): Promise<KnowledgeCollection | null> {
  return readableCollection(tenantId, orgId, collectionId, caller);
}

export async function createCollection(
  tenantId: string,
  orgId: string,
  actor: string,
  input: { name?: unknown; description?: unknown },
  /** KB-1 R2 — privileged fields, reachable ONLY from in-process callers. */
  internal: InternalCollectionFields = {},
): Promise<KnowledgeCollection> {
  assertNoPrivilegedFields(input, PRIVILEGED_COLLECTION_FIELDS, 'collection');
  const existing = (await collections.listByPrefix(`${tenantId}:${orgId}:`)).filter((c) => c.tenantId === tenantId && c.orgId === orgId); // DEBT-2
  if (existing.length >= MAX.perOrgCollections) {
    throw new OpenwopError('validation_error', `Collection cap reached (${MAX.perOrgCollections}).`, 400, {});
  }
  const now = new Date().toISOString();
  const col: KnowledgeCollection = {
    // An IN-PROCESS caller MAY supply a deterministic `collectionId` (ADR 0100 managed
    // collections resolve theirs by point-lookup, no scan); user-created collections
    // get a random one. A NETWORK caller cannot reach this field at all — see
    // `InternalCollectionFields`.
    collectionId: typeof internal.collectionId === 'string' && internal.collectionId.length > 0 ? internal.collectionId : randomUUID(),
    tenantId,
    orgId,
    name: cleanString(input.name, MAX.name),
    ...(optionalCleanString(input.description, MAX.description) !== undefined ? { description: optionalCleanString(input.description, MAX.description) } : {}),
    documentCount: 0,
    chunkCount: 0,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
    ...(internal.managed ? { managed: internal.managed } : {}),
    ...(internal.boundSubject ? { boundSubject: internal.boundSubject } : {}),
  };
  if (col.name.length === 0) throw new OpenwopError('validation_error', 'Field `name` is required.', 400, { field: 'name' });
  // KB-1 R2 — a deterministic id must never CLOBBER a live row. Every managed indexer
  // is a point-lookup-then-create ("get or create"), so a collision here is a re-entrant
  // provision, and the old unconditional `put` REPLACED the row: counts reset to zero and
  // `activeSignature` dropped, which moves `collectionNamespace()` off the `#<sig>` suffix
  // and silently empties a reindexed collection while its vectors sit intact. Return the
  // live row instead — the idempotent shape every caller already wanted.
  // ADR 0643 D1a R2 (review Should 4 — enumerated by call graph, not by the witnessed site).
  // The guard above is a get-then-put, and that is a TOCTOU: the read can see "absent" while
  // another provision of the same deterministic id lands AND takes ingests. The blind put
  // then reproduced, under concurrency, the exact clobber the comment above says it fixed —
  // counts back to zero and `activeSignature` dropped, silently emptying a reindexed
  // collection whose vectors are intact. Insert-if-absent under CAS closes it, and the loser
  // returns the live row, which is the idempotent shape every caller already wanted.
  if (internal.collectionId) {
    const live = await collectionRow(tenantId, orgId, col.collectionId);
    if (live) return live;
  }
  if (!(await collections.compareAndSwap(null, col))) {
    const live = await collectionRow(tenantId, orgId, col.collectionId);
    if (live) return live;
    throw new OpenwopError('conflict', 'The collection was created concurrently; retry.', 409, { collectionId: col.collectionId });
  }
  return col;
}

/** ADR 0113 Phase 3 — set a collection's retrieval pipeline config (mode + the
 *  local-rerank toggle). `mode:'dense'` restores today's behavior. The external
 *  (`connection`) reranker is NOT accepted here until Phase 4 wires the
 *  record-and-replay path — only `local` is honored. */
export async function setRetrievalConfig(
  tenantId: string,
  orgId: string,
  collectionId: string,
  actor: string,
  input: { mode?: unknown; rerank?: unknown; embedder?: unknown; enrichment?: unknown },
  caller?: SubjectCaller,
): Promise<KnowledgeCollection> {
  const col = await mustGetCollection(tenantId, orgId, collectionId, caller);
  const mode = input.mode;
  if (mode !== undefined && mode !== 'dense' && mode !== 'hybrid' && mode !== 'hybrid+rerank') {
    throw new OpenwopError('validation_error', '`mode` MUST be one of dense | hybrid | hybrid+rerank.', 400, { field: 'mode' });
  }
  if (input.embedder !== undefined && input.embedder !== 'local' && input.embedder !== 'provider') {
    throw new OpenwopError('validation_error', '`embedder` MUST be one of local | provider.', 400, { field: 'embedder' });
  }
  if (input.enrichment !== undefined && input.enrichment !== 'off' && input.enrichment !== 'heading-path') {
    throw new OpenwopError('validation_error', '`enrichment` MUST be one of off | heading-path.', 400, { field: 'enrichment' });
  }
  // MERGE with the existing config (ADR 0351 review) — with multiple knobs
  // (mode / embedder / rerank) each PATCHed independently by the UI, replace
  // semantics would silently wipe the others.
  const cfg: RetrievalConfig = { ...(col.retrievalConfig ?? {}) };
  if (mode) cfg.mode = mode;
  if (input.embedder === 'local' || input.embedder === 'provider') cfg.embedder = input.embedder;
  if (input.enrichment === 'off' || input.enrichment === 'heading-path') cfg.enrichment = input.enrichment;
  const rerank = input.rerank as { kind?: unknown; connectionId?: unknown; topN?: unknown } | undefined;
  if (rerank && rerank.kind === 'local') {
    cfg.rerank = { kind: 'local' };
  } else if (rerank && rerank.kind === 'connection') {
    // ADR 0351 Phase 4 (CSG-KB-8) — honest-off: accepting the external reranker
    // requires an actual `cohere-rerank` connection (the connection pack's
    // provider), else the knob would silently do nothing. 422 with the reason.
    if (rerank.connectionId !== undefined) {
      throw new OpenwopError('validation_error', 'Pinning `rerank.connectionId` is not supported — the connections broker selects the caller\'s `cohere-rerank` connection (user → org → workspace).', 400, { field: 'rerank.connectionId' });
    }
    if (!(await connectionExists({ tenantId, provider: RERANK_PROVIDER }))) {
      throw new OpenwopError('validation_error', `No '${RERANK_PROVIDER}' connection is configured — connect a Cohere Rerank key (the cohere-rerank connection pack) before selecting the external reranker.`, 422, { provider: RERANK_PROVIDER });
    }
    const topNRaw = Number(rerank.topN);
    const topN = Number.isFinite(topNRaw) && topNRaw >= 1 ? Math.min(Math.floor(topNRaw), 50) : undefined;
    cfg.rerank = { kind: 'connection', ...(topN !== undefined ? { topN } : {}) };
  } else if (rerank && rerank.kind !== undefined) {
    throw new OpenwopError('validation_error', '`rerank.kind` MUST be one of local | connection.', 400, { field: 'rerank.kind' });
  }
  // ADR 0643 D1a R2 — CAS. `connectionExists` above is a broker round-trip, so this read
  // -modify-write straddles a network call and used to be able to revert a cutover.
  const now = new Date().toISOString();
  const saved = await commitCollection(tenantId, orgId, collectionId, (fresh) => ({ ...fresh, retrievalConfig: cfg, updatedAt: now, updatedBy: actor }));
  if (!saved) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  return saved;
}

export async function deleteCollection(tenantId: string, orgId: string, collectionId: string, caller?: SubjectCaller): Promise<void> {
  const col = await readableCollection(tenantId, orgId, collectionId, caller);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  // DEBT-2 — safe even though this drives deletes: listByPrefix is the
  // authoritative PRIMARY-key scan (no secondary-index marker layer to miss).
  const docs = await docsInCollection(tenantId, orgId, collectionId);
  // Clear the vector namespace (the chunk ids of every doc) then drop the docs
  // — including each doc's provider-vector cache AND revision log (KB-CODE-10).
  const ids = docs.flatMap((d) => staleWipeIds(d, chunkText(d.text).length));
  if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: collectionNamespace(col), ids });
  // KB-4 R2 (MIGRATION WINDOW) — reclaim the pre-KB-1 namespace too. See the identical
  // note in `removeDocumentRow`: `hydrate` is the only other caller, and a collection
  // deleted before its first post-deploy search would never be reached by it again.
  await gcLegacyNamespace(tenantId, col, ids);
  // ADR 0398 P3 (review fix) — also GC the STAGING namespace of an in-flight reindex, else its
  // vectors leak permanently on a persisted backend (no collection/job left to reach them).
  if (col.pendingSignature && ids.length > 0) {
    try { await vectorSurface(tenantId).delete({ namespace: collectionNamespace(col, col.pendingSignature), ids }); } catch { /* best-effort */ }
  }
  for (const d of docs) {
    await purgeVecCacheForDoc(d);
    await purgeDocRevisionsForDoc(d);
    await documents.delete(`${tenantId}:${orgId}:${d.documentId}`);
  }
  await collections.delete(`${tenantId}:${orgId}:${collectionId}`);
  hydrated.delete(hydrateKey(tenantId, orgId, collectionId));
  // WF-SHARE-4 — cascade the public share links that referenced this collection.
  // Dynamic import: sharing imports THIS module for its resolver, so a static
  // edge back would cycle (the crm/signService precedent). Best-effort — a
  // cascade failure must not fail the delete, and the link would 404 anyway;
  // what it must not do is leave a row that reports "in use externally".
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    await purgeLinksForResource(tenantId, 'kb_collection', collectionId);
  } catch { /* best-effort cascade — the link resolves 404 regardless */ }
  // CMNT-2 — cascade the collection's comment threads. Comment `body` is declared
  // PII and `listThread` never re-derives visibility from the parent, so an
  // orphaned thread stays API-readable to anyone with `workspace:read` who knows
  // the id, for up to the retention window. Dynamic import for the same reason as
  // the sharing cascade above (comments imports THIS module for its resolver, so
  // a static edge would cycle). Best-effort, never silent.
  try {
    const { pruneThreadsForResourceAndComposites } = await import('../comments/commentsService.js');
    await pruneThreadsForResourceAndComposites(tenantId, 'kb_collection', collectionId);
  } catch (err) {
    log.warn('comment_thread_cascade_failed', { resourceType: 'kb_collection', collectionId, error: err instanceof Error ? err.message : String(err) });
  }
  // ADR 0398 P3 — drop the reindex job row (its staging vectors are GC'd above).
  try { await reindexJobs.delete(reindexKey(tenantId, orgId, collectionId)); } catch { /* best-effort */ }
  // CS-DATA-1 — a deleted source is as stale-making as a changed one: kernels
  // citing these docs must flag for regeneration. Best-effort (never throws) —
  // and AWAITED (ADR 0643 D6, see the file docblock). No `document.deleted` host
  // event here: a collection delete is a bulk lane by construction (ADR 0643 D3 —
  // one event per document would ignite one bound run per document), and the
  // ADR names no `collection.*` event kind.
  for (const d of docs) {
    await fireKnowledgeDocumentChanged({ tenantId, orgId, collectionId, documentId: d.documentId, title: d.title, revision: d.revision ?? 1, deleted: true });
  }
}

// ─── documents (ingest) ──────────────────────────────────────────────────

export async function listDocuments(tenantId: string, orgId: string, collectionId: string, caller?: SubjectCaller): Promise<Array<Omit<KnowledgeDocument, 'text'>>> {
  await mustGetCollection(tenantId, orgId, collectionId, caller);
  return (await docsInCollection(tenantId, orgId, collectionId)) // DEBT-2 — bounded org slice
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    // Drop the (potentially large) full text from the list projection.
    .map(({ text: _text, ...rest }) => rest);
}

export async function getDocument(tenantId: string, orgId: string, collectionId: string, documentId: string, caller?: SubjectCaller): Promise<KnowledgeDocument | null> {
  // KBC-1 — the document's own row carries no `boundSubject`; its COLLECTION does,
  // and the document's verbatim text is the thing the ADR 0608 leak actually
  // exposed. A refused collection answers null here, the same uniform not-found
  // an absent document gives.
  if (!(await readableCollection(tenantId, orgId, collectionId, caller))) return null;
  return documentRow(tenantId, orgId, collectionId, documentId);
}

/** The raw document row, with NO subject gate (the already-authorized internals). */
async function documentRow(tenantId: string, orgId: string, collectionId: string, documentId: string): Promise<KnowledgeDocument | null> {
  const d = await documents.get(`${tenantId}:${orgId}:${documentId}`);
  return d && d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId ? d : null;
}

/**
 * Ingest pasted text OR a Media-asset token into a collection: resolve the
 * source text, chunk → embed → upsert to the collection's vector namespace, and
 * store the document (with its durable text) + bump counts.
 */
export async function ingestDocument(
  tenantId: string,
  orgId: string,
  actor: string,
  collectionId: string,
  input: { title?: unknown; text?: unknown; mediaToken?: unknown; contentBase64?: unknown; contentType?: unknown; url?: unknown },
  /** KB-1 R2 — privileged fields, reachable ONLY from in-process callers. */
  internal: InternalDocumentFields = {},
  caller?: SubjectCaller,
): Promise<Omit<KnowledgeDocument, 'text'>> {
  assertNoPrivilegedFields(input, PRIVILEGED_DOCUMENT_FIELDS, 'document');
  // ADR 0643 D1a — the GUARD RUNS BEFORE THE COLLECTION READ, and the order is load-bearing
  // now that the guard can WRITE: an expired lease cancels the reindex, which clears
  // `col.pendingSignature`. Reading the collection first captured the pre-cancel row, and the
  // `collections.put(col)` at the end of this function then restored `pendingSignature` — a
  // lost update that leaves the collection permanently advertising a build nothing is doing.
  // (`deleteDocument`/`upsertDocument` already guard before their reads.)
  await assertNoLiveReindex(tenantId, orgId, collectionId); // review fix — no writes during a build
  const col = await mustGetCollection(tenantId, orgId, collectionId, caller);
  const docCount = (await docsInCollection(tenantId, orgId, collectionId)).length; // DEBT-2 — bounded org slice
  if (docCount >= MAX.perCollectionDocs) {
    throw new OpenwopError('validation_error', `Document cap reached (${MAX.perCollectionDocs}).`, 400, {});
  }

  // KB-1 — a caller-supplied STABLE id may not SILENTLY REPLACE an existing document.
  // `documents.put` replaces while `col.documentCount += 1` below is unconditional, so
  // the old shape corrupted the count AND left the prior revision's chunk tail in the
  // namespace still serving the OLD text under ids the new document does not cover.
  // The sanctioned replace path is `upsertDocument`, which removes the prior row first
  // (and is what every internal indexer already calls); this refuses the accidental one.
  if (typeof internal.documentId === 'string' && internal.documentId.length > 0) {
    const clash = await documentRow(tenantId, orgId, collectionId, internal.documentId);
    if (clash) {
      throw new OpenwopError('conflict', 'A document with this id already exists — delete it or use the upsert path.', 409, { documentId: internal.documentId });
    }
  }

  const { text, source, derivedTitle } = await resolveSource(tenantId, input);
  const title = cleanString(input.title, MAX.title) || derivedTitle || 'Untitled';

  const doc: KnowledgeDocument = {
    // A caller MAY supply a STABLE `documentId` (ADR 0100 keys a managed doc by
    // its source entity's id so re-index is a deterministic delete+re-ingest);
    // otherwise a random id.
    documentId: typeof internal.documentId === 'string' && internal.documentId.length > 0 ? internal.documentId : randomUUID(),
    collectionId,
    tenantId,
    orgId,
    title,
    source,
    // Content extracted from an uploaded FILE or media token is never human-reviewed —
    // a PDF/DOCX can hide white-on-white or off-screen text, and an image/audio can carry
    // adversarial text the uploader never saw (the parser/vision-LLM surfaces it). So
    // binary-sourced content (source.kind === 'media') is fenced UNTRUSTED regardless of
    // the caller; only directly-pasted text (kind === 'text') may be trusted. This aligns
    // KB upload with what notebooks/sync already do (RFC 0021 / ADR 0038 §C; ADR 0108 review).
    contentTrust: source.kind !== 'text' ? 'untrusted' : (internal.contentTrust === 'untrusted' ? 'untrusted' : 'trusted'),
    text,
    chunkCount: 0,
    ...(typeof internal.revision === 'number' && internal.revision > 1 ? { revision: internal.revision } : {}),
    createdBy: actor,
    createdAt: new Date().toISOString(),
  };
  const embedMode = resolveEmbedderMode(col);
  // Local mode embeds inline (deterministic, free). Provider mode NEVER writes
  // local vectors into a provider-signed namespace — it defers vectorization to
  // the next hydrate (the documented self-heal path), which batch-embeds via
  // the provider + durable cache (ADR 0351 Phase 1).
  const rows = embedMode === 'local' ? chunkRows(doc, enrichmentOf(col)) : [];
  doc.chunkCount = embedMode === 'local' ? rows.length : chunkText(doc.text).length;

  if (embedMode === 'local') await hydrate(tenantId, orgId, collectionId); // ensure the namespace exists before adding
  // Durable doc FIRST, then the (ephemeral) vectors — so a crash between the two
  // never leaves orphan vectors without a backing document. If the upsert fails,
  // drop the hydrate marker: the next search rebuilds the namespace from durable
  // docs (which now includes this one), so the doc self-heals into searchability.
  await documents.put(doc);
  if (embedMode !== 'local') {
    hydrated.delete(hydrateKey(tenantId, orgId, collectionId)); // next search hydrates + embeds this doc
  } else if (rows.length > 0) {
    try {
      await vectorSurface(tenantId).upsert({ namespace: collectionNamespace(col), items: rows });
    } catch (err) {
      hydrated.delete(hydrateKey(tenantId, orgId, collectionId));
      throw err;
    }
  }

  // ADR 0643 D1a R2 (review Blocker 1) — a DELTA under CAS, never a whole-row put of the
  // `col` read at the top of this function. The guard above lets this ingest through the
  // instant the reindex job turns `done`, i.e. mid-cutover; the old blind put then landed
  // after the flip and reverted every signature field on it. Counts are deltas for the same
  // reason a second time: two concurrent ingests each wrote `mine.documentCount + 1`.
  await commitCollection(tenantId, orgId, collectionId, (fresh) => ({
    ...fresh,
    documentCount: fresh.documentCount + 1,
    chunkCount: fresh.chunkCount + doc.chunkCount,
    updatedAt: doc.createdAt,
    updatedBy: actor,
  }));

  // ADR 0643 D3 — the ONE `document.ingested` site: a document row was CREATED
  // (the same-id clash above is a 409, and the same-id-same-content re-upsert
  // returns in `upsertDocument` before reaching here). The stable-id REPLACE
  // arrives with `silent` set by `upsertDocument`, whose transition is `updated`.
  // Awaited (D6); `kbMutated` never throws.
  await kbMutated({ entity: 'document', verb: 'ingested', tenantId, orgId, collectionId, documentId: doc.documentId, ...(internal.origin ? { origin: internal.origin } : {}), ...(internal.silent ? { silent: true } : {}) });

  const { text: _t, ...projection } = doc;
  return projection;
}

/**
 * Delete one document (vectors, durable row, provider-vector cache, revision log).
 *
 * `emit` (ADR 0643 D3): the route lane emits `document.deleted`; bulk lanes pass
 * `{ silent: true }` as a VOLUME decision, and the ERASURE lanes — `eraseSubjectKb`,
 * `removeProfileStrict` on the DSAR fan-out — pass it UNCONDITIONALLY as a
 * CORRECTNESS rule: on those lanes `documentId` IS the subject key, and an event
 * carrying it would publish the just-erased person's identifier to every webhook
 * subscriber and bound run (`emit.ts` docblock, ADR 0643 review #5).
 */
export async function deleteDocument(tenantId: string, orgId: string, collectionId: string, documentId: string, caller?: SubjectCaller, emit: KbEmitOptions = {}): Promise<void> {
  await mustGetCollection(tenantId, orgId, collectionId, caller); // KBC-1 — the collection's subject gate, before anything is destroyed
  await assertNoLiveReindex(tenantId, orgId, collectionId); // review fix — no writes during a build
  const doc = await documentRow(tenantId, orgId, collectionId, documentId);
  if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId });
  await removeDocumentRow(doc);
  await purgeVecCacheForDoc(doc); // ADR 0351 — no orphan provider-vector cache rows
  await purgeDocRevisionsForDoc(doc); // KB-CODE-10 — no orphan revision-log rows
  // CS-DATA-1 — kernels citing a DELETED source are stale too: fire the same
  // staleness seam a content change does. Best-effort (never throws); awaited (D6).
  await fireKnowledgeDocumentChanged({ tenantId, orgId, collectionId, documentId, title: doc.title, revision: doc.revision ?? 1, deleted: true });
  // ADR 0643 D3 — the ONE `document.deleted` site. `silent` is decided by the CALLER's
  // lane (see the docblock); this function never infers it.
  await kbMutated({ entity: 'document', verb: 'deleted', tenantId, orgId, collectionId, documentId, ...(emit.origin ? { origin: emit.origin } : {}), ...(emit.silent ? { silent: true } : {}) });
}

/** Remove a document's vectors + durable row + collection counts — the shared
 *  core of the USER-FACING delete and the stable-id upsert's internal replace
 *  (KB-CODE-9). Deliberately does NOT touch the provider-vector cache or the
 *  revision log, and fires no lifecycle event — the callers own those. */
async function removeDocumentRow(doc: KnowledgeDocument): Promise<void> {
  const { tenantId, orgId, collectionId } = doc;
  const col = await collectionRow(tenantId, orgId, collectionId);
  // KB-4 (SECURITY/RETENTION). This used to wipe with `chunkIds(doc)` — the CURRENT
  // chunker over the current text — while `deleteCollection`, the reindex cutover and
  // `cancelReindex` all use the `staleWipeIds` UNION for the documented reason that a
  // chunker change can SHRINK the count. A document ingested under chunker v1 and
  // deleted before any post-upgrade hydrate reconciled its `chunkCount` therefore left
  // ids `[newCount..oldCount)` in the namespace, carrying the deleted document's full
  // text in `metadata`, and NO later hydrate could reach them (the doc is gone from
  // `perDoc`, so the union wipe never covers it). Ephemeral in memory; permanent on
  // pgvector. Deleting a document must mean the text is gone.
  const ids = staleWipeIds(doc, chunkIds(doc).length);
  if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: col ? collectionNamespace(col) : `${orgId}/${collectionId}`, ids });
  // KB-4 R2 (MIGRATION WINDOW) — the pre-KB-1 namespace was reclaimed ONLY by `hydrate`,
  // which enumerates from CURRENTLY-LIVE documents. A tenant who deletes a document after
  // this deploy but BEFORE that collection is next searched therefore left rows carrying
  // the document's full chunk text in the legacy namespace, unreachable by any later
  // rebuild (the doc is gone from `perDoc`, so the union wipe never covers it). Worst case
  // is the eraser: `eraseSubjectKb → deleteDocument → removeDocumentRow` reported a
  // COMPLETE erasure while the subject's chunk text survived — the exact failure ADR 0581
  // names as its own rationale. Best-effort second delete, same ids, same bound.
  if (col) await gcLegacyNamespace(tenantId, col, ids);
  await documents.delete(`${tenantId}:${orgId}:${doc.documentId}`);
  if (col) {
    // ADR 0643 D1a R2 — same delta-under-CAS rule as `ingestDocument`.
    const now = new Date().toISOString();
    await commitCollection(tenantId, orgId, collectionId, (fresh) => ({
      ...fresh,
      documentCount: Math.max(0, fresh.documentCount - 1),
      chunkCount: Math.max(0, fresh.chunkCount - doc.chunkCount),
      updatedAt: now,
    }));
  }
}

/**
 * Re-ingest a document under a STABLE caller-supplied id (ADR 0100): delete the
 * prior revision if present, then ingest fresh. Idempotent — keying by the
 * source entity's id means re-index is deterministic (no orphan/duplicate docs)
 * and tolerates a first-time index (no prior doc to delete). Used by the
 * planning-KB indexers; not exposed as a user route.
 */
export async function upsertDocument(
  tenantId: string,
  orgId: string,
  collectionId: string,
  documentId: string,
  actor: string,
  /** `silent` / `origin` (ADR 0643 D3) intersect the input the way `crm/emit.ts`'s
   *  `emitOptsOf` does — this is an in-process-only path, so they are never a body. */
  input: { title?: unknown; text?: unknown; contentTrust?: 'trusted' | 'untrusted'; mediaToken?: unknown; contentBase64?: unknown; contentType?: unknown; url?: unknown } & KbEmitOptions,
  caller?: SubjectCaller,
): Promise<Omit<KnowledgeDocument, 'text'>> {
  await mustGetCollection(tenantId, orgId, collectionId, caller); // KBC-1 — the collection's subject gate, before the replace destroys the prior row
  await assertNoLiveReindex(tenantId, orgId, collectionId); // review fix — no writes during a build
  const inFlightKey = `${tenantId}:${documentId}`; // KB-8 — see `upsertsInFlight`
  const prior = await documentRow(tenantId, orgId, collectionId, documentId);
  // Content-hash guard (ADR 0100 Phase 3): if the indexable content is unchanged,
  // skip the delete+re-ingest+re-embed entirely. Makes no-op updates (and backfill
  // re-runs) free. Compares the resolved text doc only (text-source upserts).
  if (prior) {
    const sameTitle = prior.title === (cleanString(input.title, MAX.title) || prior.title);
    const sameText = typeof input.text === 'string' && prior.text === input.text;
    if (sameText && sameTitle) {
      const { text: _t, ...projection } = prior;
      return projection;
    }
    // Internal replace (KB-CODE-9/10): PRESERVE the per-chunk provider-vector
    // cache (the textHash mismatch already drives selective re-embed of only
    // the changed chunks — a full purge would re-bill every chunk) and the
    // revision log (recorded below). The user-facing delete purges both.
    // KB-8 — the marker is set BEFORE the row disappears and cleared only once the
    // re-ingest has landed, so a concurrent retention sweep can never see this document
    // as an orphan mid-replace.
    upsertsInFlight.add(inFlightKey);
    await removeDocumentRow(prior);
  }
  const revision = prior ? (prior.revision ?? 1) + 1 : 1;
  // KB-1 R2 — the privileged trio rides the INTERNAL parameter. `upsertDocument` is the
  // sanctioned in-process replace path (never a route), so it is exactly the caller that
  // is allowed to express them; forwarding them inside `input` would now be refused.
  const { contentTrust, silent, origin, ...publicInput } = input;
  let projection: Omit<KnowledgeDocument, 'text'>;
  try {
    projection = await ingestDocument(tenantId, orgId, actor, collectionId, publicInput, {
      documentId,
      revision,
      ...(contentTrust ? { contentTrust } : {}),
      ...(origin ? { origin } : {}),
      // ADR 0643 D3 — a REPLACE is an `updated` transition, owned below; its ingest
      // half is therefore silent so the two never double-emit. A first-time upsert
      // (no prior) IS a creation and lets `ingestDocument`'s one site emit it.
      ...(silent || prior ? { silent: true } : {}),
    });
  } finally {
    upsertsInFlight.delete(inFlightKey);
  }
  const fresh = await documentRow(tenantId, orgId, collectionId, documentId);
  if (fresh) await recordDocRevision(fresh, revision);
  if (prior && fresh) {
    // ADR 0351 P3 — content actually changed under a stable id: fire the
    // staleness seam (in-process consumers, e.g. campaign-brief kernelStale)
    // + the host event (webhook/binding ecosystem). Both best-effort, both
    // AWAITED (ADR 0643 D6 — see the file docblock; this `void` was the one
    // KB event that already existed, and it was on the dropped lane).
    await fireKnowledgeDocumentChanged({ tenantId, orgId, collectionId, documentId, title: fresh.title, revision });
    // ADR 0643 D3 — the ONE `document.updated` site.
    await kbMutated({ entity: 'document', verb: 'updated', tenantId, orgId, collectionId, documentId, revision, ...(origin ? { origin } : {}), ...(silent ? { silent: true } : {}) });
  }
  return projection;
}

/** ADR 0398 P2 — the media-collection → KB bridge. Ingests every EXTRACTABLE asset of a
 *  media collection into this KB collection as an untrusted-fenced document, keyed by a
 *  STABLE `media:<assetId>` id so re-running is an idempotent upsert (no orphan/duplicate
 *  docs). A one-shot snapshot, NOT a live subscription. Non-extractable assets are SKIPPED
 *  with a per-asset reason (typed, itemized — never a silent drop). kb→media READ only. */
export interface IngestMediaCollectionResult {
  ingested: number;
  skipped: Array<{ assetId: string; name: string; reason: string }>;
}

export async function ingestMediaCollection(
  tenantId: string,
  orgId: string,
  actor: string,
  collectionId: string,
  mediaCollectionId: string,
  caller?: SubjectCaller,
): Promise<IngestMediaCollectionResult> {
  await mustGetCollection(tenantId, orgId, collectionId, caller); // tenant/org + KBC-1 subject check (throws 404 if missing)
  const mediaCol = await getMediaCollection(tenantId, orgId, mediaCollectionId);
  if (!mediaCol) throw new OpenwopError('not_found', 'Media collection not found.', 404, { mediaCollectionId });
  const assets = await listMediaAssets(tenantId, orgId, { collectionId: mediaCollectionId }); // tenant/org scoped

  let ingested = 0;
  const skipped: IngestMediaCollectionResult['skipped'] = [];
  for (const asset of assets) {
    try {
      // Reuse the existing media-ingest path via the asset's serve token: extraction (PDF/
      // DOCX/Office/text, and OCR/transcription when enabled) is the extractor's single
      // responsibility — the bridge adds NO second MIME table. `media:<assetId>` is the
      // stable id → `upsertDocument` replaces the prior revision idempotently.
      await upsertDocument(tenantId, orgId, collectionId, `media:${asset.assetId}`, actor, {
        title: asset.name,
        mediaToken: asset.serveToken,
        silent: true, // ADR 0643 D3 (R4 Should 2) — a BULK lane: one batch event below, never one per asset
      });
      ingested += 1;
    } catch (err) {
      // A per-asset extraction failure (unsupported MIME, empty, too large, OCR/STT off,
      // or the per-collection doc cap) is a SKIP with the typed reason — never a silent
      // drop and never a whole-batch failure. An UNEXPECTED error (a real fault) surfaces.
      if (err instanceof OpenwopError) {
        skipped.push({ assetId: asset.assetId, name: asset.name, reason: err.message });
      } else {
        throw err;
      }
    }
  }
  // ADR 0643 D3 (R4 Should 2) — ONE `document.ingested { count }` for the bridge pass:
  // a 500-asset media collection must not start 500 bound runs against the 120/h budget.
  if (ingested > 0) await kbMutated({ entity: 'document', verb: 'ingested', tenantId, orgId, collectionId, count: ingested });
  return { ingested, skipped };
}

// ─── retrieval ───────────────────────────────────────────────────────────

/** ADR 0351 — how a search was actually embedded, for the honesty label on
 *  responses. `lexical-only` = provider mode with no resolvable embedder (or a
 *  query-embed failure): the dense channel was OFF for this search. */
export interface EmbeddingInfo { mode: 'local' | 'provider' | 'lexical-only'; model?: string }

/** ADR 0351 Phase 4 (CSG-KB-8) — which reranker the config REQUESTED vs what was
 *  actually APPLIED, for the honesty label: a connection-reranker failure
 *  degrades to the local deterministic reranker as `local-degraded`. Present
 *  only on `hybrid+rerank` searches that reached the rerank stage. */
export interface RerankInfo { requested: 'local' | 'connection'; applied: 'local' | 'connection' | 'local-degraded' }

export async function search(tenantId: string, orgId: string, collectionId: string, queryRaw: unknown, topKRaw: unknown, mode: RetrievalMode = 'dense', caller?: SubjectCaller): Promise<SearchHit[]> {
  return (await searchDetailed(tenantId, orgId, collectionId, queryRaw, topKRaw, mode, caller)).hits;
}

export async function searchDetailed(tenantId: string, orgId: string, collectionId: string, queryRaw: unknown, topKRaw: unknown, mode: RetrievalMode = 'dense', caller?: SubjectCaller): Promise<{ hits: SearchHit[]; embedding: EmbeddingInfo; rerank?: RerankInfo }> {
  const col = await mustGetCollection(tenantId, orgId, collectionId, caller);
  const query = cleanString(queryRaw, MAX.query);
  if (query.length === 0) throw new OpenwopError('validation_error', 'Field `query` is required.', 400, { field: 'query' });
  const topK = clampTopK(topKRaw);
  const status = await hydrate(tenantId, orgId, collectionId);

  // Resolve the query vector per the namespace's embedder — NEVER mix models
  // (a local-hash query against provider chunk vectors is noise, not fallback).
  let queryVector: number[] | null = null;
  let embedding: EmbeddingInfo;
  if (status.embedMode === 'local') {
    queryVector = embedText(query, effectiveEmbedDims()); // KB-CODE-12 — match the namespace width
    embedding = { mode: 'local', model: status.model };
  } else if (status.denseAvailable && status.embedder) {
    try {
      queryVector = (await status.embedder.embed([query]))[0] ?? null;
      embedding = { mode: 'provider', model: status.model };
    } catch {
      queryVector = null; // provider hiccup at query time — degrade, labeled
      embedding = { mode: 'lexical-only' };
    }
  } else {
    embedding = { mode: 'lexical-only' };
  }

  // Dense channel unavailable ⇒ lexical-only over the durable corpus (honest
  // degrade for ANY requested mode — better ranked hits than none).
  if (!queryVector) {
    const corpus = await collectionChunks(tenantId, orgId, collectionId);
    const metaById = new Map(corpus.map((r) => [r.id, r.metadata]));
    const lexical = bm25Search(corpus.map((r) => ({ id: r.id, text: r.metadata.text })), query, Math.max(topK, HYBRID_CANDIDATES));
    const hits: SearchHit[] = lexical.map((f) => {
      const m = metaById.get(f.id);
      return {
        chunkId: f.id,
        documentId: m?.documentId ?? '',
        title: m?.title ?? '',
        chunkIndex: m?.chunkIndex ?? 0,
        text: m?.text ?? '',
        score: f.score,
        contentTrust: m?.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
        headingPath: m?.headingPath ?? [],
      };
    });
    return { hits: hits.slice(0, topK), embedding };
  }

  // Dense channel (always) — for hybrid, pull a wider candidate pool so fusion
  // has something to reorder.
  const denseK = mode === 'dense' ? topK : Math.max(topK, HYBRID_CANDIDATES);
  const res = await vectorSurface(tenantId).query({ namespace: collectionNamespace(col), vector: queryVector, topK: denseK });
  const matches = (res.matches ?? []) as Array<{ id: string; score: number; metadata?: ChunkRow['metadata'] }>;
  const denseHits: SearchHit[] = matches.map((m) => ({
    chunkId: m.id,
    documentId: m.metadata?.documentId ?? '',
    title: m.metadata?.title ?? '',
    chunkIndex: m.metadata?.chunkIndex ?? 0,
    text: m.metadata?.text ?? '',
    score: m.score,
    contentTrust: m.metadata?.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
    headingPath: m.metadata?.headingPath ?? [],
  }));
  if (mode === 'dense') return { hits: denseHits.slice(0, topK), embedding };

  // Lexical (BM25) channel over the SAME durable chunk text, then RRF-fuse the two
  // ranked lists (ADR 0113). Deterministic ⇒ replay-safe, nothing recorded. The
  // metadata for every chunk (text/title/trust) comes from the corpus map, so a
  // lexical-only hit (no dense match) is still fully projected — with its trust.
  const corpus = await collectionChunks(tenantId, orgId, collectionId);
  const metaById = new Map(corpus.map((r) => [r.id, r.metadata]));
  const lexical = bm25Search(corpus.map((r) => ({ id: r.id, text: r.metadata.text })), query, HYBRID_CANDIDATES);
  // Fuse into a WIDER candidate pool; truncation to top-k happens after the
  // optional rerank stage (so rerank can promote a candidate past the cut).
  const fused = rrfFuse([denseHits.map((h) => ({ id: h.chunkId })), lexical], DEFAULT_RRF_K, HYBRID_CANDIDATES);
  const candidates: SearchHit[] = fused.map((f) => {
    const m = metaById.get(f.id);
    return {
      chunkId: f.id,
      documentId: m?.documentId ?? '',
      title: m?.title ?? '',
      chunkIndex: m?.chunkIndex ?? 0,
      text: m?.text ?? '',
      score: f.score,
      contentTrust: m?.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
      headingPath: m?.headingPath ?? [],
    };
  });

  // Rerank stage. Local is DETERMINISTIC (replay-safe, Phase 2); the external
  // CONNECTION reranker (Phase 4, CSG-KB-8) calls the vendor through the
  // brokered-egress spine and degrades HONESTLY to local on any failure —
  // a search must not fail because a reranker is down. Run-replay posture is
  // the node boundary (same as provider query embedding): a `kb.rag` node's
  // recorded output replays without re-searching.
  if (mode === 'hybrid+rerank') {
    const byId = new Map(candidates.map((c) => [c.chunkId, c]));
    const rerankCfg = col.retrievalConfig?.rerank;
    if (rerankCfg?.kind === 'connection') {
      const topN = rerankCfg.topN !== undefined ? Math.min(rerankCfg.topN, topK) : topK;
      const ranked = await connectionRerank(tenantId, query, candidates.map((c) => ({ id: c.chunkId, text: c.text })), topN);
      if (ranked !== null) {
        return { hits: ranked.map((r) => ({ ...byId.get(r.id)!, score: r.score })), embedding, rerank: { requested: 'connection', applied: 'connection' } };
      }
      const degraded = localRerank(query, candidates.map((c) => ({ id: c.chunkId, text: c.text, title: c.title })), topK);
      return { hits: degraded.map((r) => ({ ...byId.get(r.id)!, score: r.score })), embedding, rerank: { requested: 'connection', applied: 'local-degraded' } };
    }
    const reranked = localRerank(query, candidates.map((c) => ({ id: c.chunkId, text: c.text, title: c.title })), topK);
    return { hits: reranked.map((r) => ({ ...byId.get(r.id)!, score: r.score })), embedding, rerank: { requested: 'local', applied: 'local' } };
  }
  return { hits: candidates.slice(0, topK), embedding };
}

/**
 * Back the tenant-scoped `ctx.knowledge` host surface (ADR 0014 Phase 0) with the
 * REAL KB store: vector-search across the tenant's collections and project to the
 * KnowledgeSurface chunk/source shape. Returns `null` (→ seeded demo fallback)
 * when KB is disabled for the tenant OR the tenant has no collections — so the
 * out-of-box demo still works and the surface only serves real data when there
 * is some. Closes the ADR-0011 "back host.knowledge with the real store" question.
 */
export async function tenantRetrieve(tenantId: string, args: KnowledgeRetrieveArgs, caller?: SubjectCaller): Promise<KnowledgeResult | null> {
  // KB is always-on (toggle removed); a tenant with no collections still falls
  // through to the demo path below.
  const allRows = (await collections.listForTenant(tenantId)).filter((c) => c.tenantId === tenantId); // DEBT-2
  // KBC-1 — THE lane the ADR 0643 D2 precondition is named for. `ctx.knowledge`
  // is backed by this function (`features/kb/feature.ts`), so it is what every
  // workflow run and every agent chat turn retrieves through. It fanned out
  // across the tenant's collections with no subject gate at all, which made a
  // project-bound corpus readable from any run in the tenant.
  const tenantCollections = await filterReadable(tenantId, allRows, caller);
  // A tenant that HAS knowledge but none this caller may read is not a tenant
  // with "no real knowledge": returning null would fall through to the seeded
  // demo corpus and answer a refused query with fabricated content. Answer
  // honestly empty instead (the LEAK-10 shape), and reserve null for the
  // genuinely-empty tenant.
  if (allRows.length === 0) return null; // no real knowledge → demo fallback
  if (tenantCollections.length === 0) return { chunks: [], sources: [], latencyMs: 0, hasResults: false };

  let wanted = args.collectionIds && args.collectionIds.length > 0
    ? tenantCollections.filter((c) => args.collectionIds!.includes(c.collectionId))
    : tenantCollections;
  if (wanted.length > MAX.retrieveCollections) {
    log.warn('kb_tenant_retrieve_truncated', { tenantId, total: wanted.length, cap: MAX.retrieveCollections });
    wanted = wanted.slice(0, MAX.retrieveCollections);
  }

  const started = Date.now();
  const resultLimit = clampTopK(args.resultLimit);
  const scoreThreshold = typeof args.scoreThreshold === 'number' ? args.scoreThreshold : 0;

  // Per-collection searches are independent → run them concurrently (wall-clock
  // is the slowest single search, not the sum). Each is fault-isolated to [].
  const perCollection = await Promise.all(
    wanted.map((c) =>
      search(tenantId, c.orgId, c.collectionId, args.query, Math.max(resultLimit, 8), resolveRetrievalMode(c), PREAUTHORIZED_CALLER) // KBC-1 — `filterReadable` above already resolved every row in `wanted`
        .then((hits) => hits.map((hit) => ({ hit, collectionId: c.collectionId })))
        .catch(() => [] as Array<{ hit: SearchHit; collectionId: string }>),
    ),
  );
  const scored = perCollection.flat();
  scored.sort((a, b) => b.hit.score - a.hit.score);

  const chunks: KnowledgeResult['chunks'] = scored
    .filter(({ hit }) => hit.score >= scoreThreshold)
    .slice(0, resultLimit)
    .map(({ hit, collectionId }) => ({
      chunkId: hit.chunkId,
      content: hit.text,
      headingPath: hit.headingPath, // ADR 0398 P1 — from the structural chunker (was hardcoded [])
      pageNumber: null,
      documentTitle: hit.title,
      assetId: hit.documentId,
      collectionId,
      relevanceScore: hit.score,
      contentTrust: hit.contentTrust,
    }));

  const sources: KnowledgeResult['sources'] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    if (!c.assetId || seen.has(c.assetId)) continue;
    seen.add(c.assetId);
    sources.push({ sourceId: c.assetId, assetId: c.assetId, title: c.documentTitle, headingPath: c.headingPath, pageNumber: c.pageNumber });
  }

  return { chunks, sources, latencyMs: Date.now() - started, hasResults: chunks.length > 0 };
}

/** ADR 0351 Phase 2 — deterministic retrieval-coverage classification. COUNT
 *  based (score scales differ across dense/BM25/RRF modes, so a global score
 *  floor would be arbitrary — callers who know their mode pass `minScore`):
 *  `none` = 0 hits (nothing to ground on), `thin` = 1 hit, `ok` = ≥2 hits.
 *  Under groundingPolicy 'strict' a generator MUST fail closed on `none`. */
export type RagCoverage = 'ok' | 'thin' | 'none';

export interface RagResult {
  query: string;
  contexts: SearchHit[];
  citations: Array<{ documentId: string; title: string }>;
  /** ADR 0351 — how retrieval was embedded for THIS answer (honesty label). */
  embedding: EmbeddingInfo;
  /** ADR 0351 Phase 2 — how well the KB covered the query (strict-mode gate). */
  coverage: RagCoverage;
  /** A grounded prompt assembled from the retrieved chunks, ready to feed to an
   *  agent / `ctx.callAI` IN A WORKFLOW. Generation is run-scoped (the provider
   *  is `ctx`-only), so the feature returns the augmented context, not an answer. */
  augmentedPrompt: string;
}

/**
 * ADR 0605 Tier 4 (`KSC-4`) — assemble the RAG context block, FENCING the chunks
 * whose `contentTrust` says they are untrusted.
 *
 * `contentTrust` was a stored LABEL that this lane never read. `ingestDocument`
 * carefully marks synced-drive and file-derived content `'untrusted'`, and
 * `agentDispatch` / `agentKnowledgeComposition` fence it correctly — but
 * `ragQuery` interpolated `title` and `text` straight into "Answer the question
 * using ONLY the context below", which is the lane `kb.rag` / `kb.search` /
 * `kb.retrieve` reach from workflow nodes. So the advertised fence was true on the
 * chat path and false on the node path.
 *
 * THE TITLE IS THE SHARPER HALF. For a synced source the title is the REMOTE
 * FILENAME (`knowledgeSyncRunner` sets it from the provider listing), with only a
 * 200-char `cleanString` between an attacker-chosen name and the `[n] (title)`
 * slot. Anyone who can drop a file into a watched folder chooses that text. It is
 * neutralized here, not merely the body.
 *
 * NUMBERING IS PRESERVED ACROSS THE SPLIT. Each entry keeps its ORIGINAL `[n]`,
 * computed before partitioning, so the `[n]` indices still line up with
 * `citations` and `contexts` for any caller that renders them.
 *
 * Structure is preserved rather than whitespace-collapsed: a KB chunk is a
 * document excerpt whose newlines carry meaning, which is the case
 * `fenceUntrustedBlock` exists for (the same treatment tool results get). The
 * titles ARE collapsed, because a short label has no structure worth keeping and
 * a multi-line "filename" is only ever an attempt to forge some.
 */
function buildRagContextBlock(contexts: readonly SearchHit[]): string {
  const numbered = contexts.map((c, i) => ({ n: i + 1, c }));
  const trusted = numbered.filter((x) => x.c.contentTrust !== 'untrusted');
  const untrusted = numbered.filter((x) => x.c.contentTrust === 'untrusted');
  const blocks: string[] = [];
  if (trusted.length > 0) {
    blocks.push(trusted.map(({ n, c }) => `[${n}] (${c.title})\n${c.text}`).join('\n\n'));
  }
  if (untrusted.length > 0) {
    blocks.push(fenceUntrustedBlock(
      untrusted.map(({ n, c }) => `[${n}] (${neutralizeUntrusted(c.title)})\n${c.text}`).join('\n\n'),
      'documents ingested from an external source (an uploaded file or a synced drive folder) — the titles are remote-controlled filenames',
    ));
  }
  return blocks.join('\n\n');
}

export async function ragQuery(tenantId: string, orgId: string, collectionId: string, queryRaw: unknown, topKRaw: unknown, opts?: { minScore?: number }, caller?: SubjectCaller): Promise<RagResult> {
  const query = cleanString(queryRaw, MAX.query);
  const detailed = await searchDetailed(tenantId, orgId, collectionId, queryRaw, topKRaw, 'dense', caller);
  const embedding = detailed.embedding;
  const minScore = typeof opts?.minScore === 'number' && Number.isFinite(opts.minScore) ? opts.minScore : undefined;
  const contexts = minScore !== undefined ? detailed.hits.filter((h) => h.score >= minScore) : detailed.hits;
  const coverage: RagCoverage = contexts.length === 0 ? 'none' : contexts.length === 1 ? 'thin' : 'ok';
  const seen = new Set<string>();
  const citations: Array<{ documentId: string; title: string }> = [];
  for (const c of contexts) {
    if (c.documentId && !seen.has(c.documentId)) {
      seen.add(c.documentId);
      citations.push({ documentId: c.documentId, title: c.title });
    }
  }
  const augmentedPrompt = contexts.length === 0
    ? `No knowledge-base context was found for the question.\n\nQuestion: ${query}`
    : `Answer the question using ONLY the context below. Cite sources by their [n] index. If the context is insufficient, say so.\n\nContext:\n${buildRagContextBlock(contexts)}\n\nQuestion: ${query}`;
  return { query, contexts, citations, embedding, coverage, augmentedPrompt };
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function mustGetCollection(tenantId: string, orgId: string, collectionId: string, caller?: SubjectCaller): Promise<KnowledgeCollection> {
  const col = await readableCollection(tenantId, orgId, collectionId, caller);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  return col;
}

/**
 * The retrieval fan-out applied when a caller supplies no usable `topK`. EXPORTED
 * (ADR 0602) because it is model-facing: the notebooks agent tools told the model
 * "default 5" while this said 8 — a number the model reasons about, hand-copied
 * into a prompt and wrong. CLAUDE.md § "AI↔app information exchange" requires such
 * text to be generated from its SSoT or test-pinned to it; this is the SSoT.
 */
export const DEFAULT_TOP_K = 8;

function clampTopK(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_TOP_K;
  return Math.max(1, Math.min(n, MAX.topK));
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** Decoded-byte cap on an uploaded file before extraction — bounds the in-process
 *  parse (the 48mb body parser only bounds the request, not the decode). NOTE: this
 *  caps the COMPRESSED size of an OOXML/ODF file; a malicious zip can still expand
 *  large during parse — bounded only by per-request isolation (a bad file OOMs that
 *  request, never the store). Acceptable for the reference host. */
const MAX_UPLOAD_DECODED_BYTES = 32 * 1024 * 1024;
/** Audio gets a larger ceiling (ADR 0111) — long recordings go to the provider File API
 *  (dispatchGoogle) rather than inline, so they exceed the 32 MiB document cap. Still bounded
 *  (we hold the bytes to upload); matches dispatch's GEMINI_MAX_AUDIO_BYTES. */
const MAX_AUDIO_DECODED_BYTES = 200 * 1024 * 1024;
/** Transcription output budget (ADR 0111 review) — a long recording needs the model's full
 *  output window (~64k tokens ≈ several hours of speech); the 8k OCR default truncated it. */
const AUDIO_MAX_OUTPUT_TOKENS = 65536;
/** Transcription deadline (ADR 0111 review) — File-API upload + ACTIVE poll + a multi-minute
 *  generate exceeds the 120s dispatch default; give long audio room to finish. */
const AUDIO_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;

/** Formats routed to `officeparser` (lazy-imported) — PowerPoint, Excel, the
 *  OpenDocument trio, and RTF. PDF/DOCX keep their proven `unpdf`/`mammoth` paths. */
/** Image types OCR'd via the managed vision model when OPENWOP_KB_OCR_ENABLED=true. */
const OCR_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/tiff', 'image/gif']);
/** AUDIO types transcribed via the managed audio model when OPENWOP_KB_TRANSCRIBE_ENABLED=true.
 *  Gemini-accepted inline formats (dispatch.ts). Video is NOT here — it 415s (extract the
 *  audio track first), since `dispatch` has no inline-video path. */
const AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/aiff']);

const OFFICE_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',          // .xlsx
  'application/vnd.oasis.opendocument.text',                                    // .odt
  'application/vnd.oasis.opendocument.presentation',                            // .odp
  'application/vnd.oasis.opendocument.spreadsheet',                             // .ods
  'application/rtf', 'text/rtf',                                                // .rtf
]);

/**
 * Extract plain text from uploaded bytes by MIME — the SINGLE extraction owner for
 * file ingest (manual KB upload, media assets, and drive-sync). text/* + json/xml/
 * markdown decode as UTF-8; PDF via `unpdf`; DOCX via `mammoth`; PowerPoint / Excel /
 * OpenDocument / RTF via `officeparser` — all lazy-imported so the parsers stay off
 * the boot path. Anything with no extractable text (images, audio, video, archives)
 * throws 415 — honest: those don't tokenize into RAG without OCR/transcription, which
 * is a separate pipeline. A corrupt-but-right-type file throws 422 (that one ingest
 * fails; callers isolate it). Returns the extracted text (capped at MAX.text downstream).
 */
async function extractTextFromBytes(tenantId: string, buffer: Buffer, contentType: string): Promise<string> {
  const mime = contentType.toLowerCase().split(';')[0]!.trim();
  // RTF arrives as text/rtf but is NOT plain text — route it to officeparser FIRST,
  // before the text/* catch-all below.
  if (OFFICE_MIME.has(mime)) {
    try {
      const { parseOffice } = await import('officeparser');
      const parsed = await parseOffice(buffer);
      return parsed.toText();
    } catch (err) {
      throw new OpenwopError(
        'validation_error',
        `Could not extract text from the \`${contentType}\` file — it may be corrupt or password-protected.`,
        422,
        { contentType, reason: err instanceof Error ? err.message : String(err) },
      );
    }
  }
  if (TEXT_MIME.test(mime)) return buffer.toString('utf8');
  if (mime === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    // H61 — `isEvalSupported` defaults to TRUE in pdf.js, i.e. the parser may
    // evaluate strings as JavaScript "to improve performance of PDF functions"
    // (unpdf's own typings say so). The bytes here are an authenticated user's
    // UPLOAD, and GHSA-hq66-cqwq-w95j against the bundled pdf.js is precisely
    // "arbitrary JavaScript execution upon opening a malicious PDF" (CWE-79).
    // Turning it off costs a little speed on function-heavy PDFs and removes
    // the eval path entirely; text extraction does not need it.
    //
    // This does NOT close the advisory — unpdf 1.6.2 vendors pdf.js 5.6.205
    // inside the vulnerable range and declares no `pdfjs-dist` dependency, so
    // `npm audit` cannot see it at all (pinned by `kb-vendored-pdfjs.test.ts`).
    // The officeparser PDF path is a SECOND copy this call cannot configure.
    // Containment is worker isolation; this is the cheap half done today.
    const pdf = await getDocumentProxy(new Uint8Array(buffer), { isEvalSupported: false });
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : text;
  }
  if (mime === DOCX_MIME) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  // Image OCR + audio transcription via the MANAGED multimodal provider (ADR 0108) — each
  // OFF by default behind its own env flag (they bill provider tokens). Off ⇒ 415 like any
  // un-tokenizable type. See `mediaToTextViaLLM` for the replay-safety contract.
  if (OCR_MIME.has(mime)) {
    if (process.env.OPENWOP_KB_OCR_ENABLED !== 'true') {
      throw new OpenwopError('validation_error', `Image OCR is not enabled on this host (\`${contentType}\`).`, 415, { contentType });
    }
    return mediaToTextViaLLM(tenantId, buffer, mime, 'image');
  }
  if (AUDIO_MIME.has(mime)) {
    if (process.env.OPENWOP_KB_TRANSCRIBE_ENABLED !== 'true') {
      throw new OpenwopError('validation_error', `Audio transcription is not enabled on this host (\`${contentType}\`).`, 415, { contentType });
    }
    // Pre-flight the per-org STT byte budget (ADR 0106) BEFORE the paid call; record after
    // a successful transcription. This byte budget is the PRIMARY audio cost control — the
    // resolver (ADR 0110) may route to a BYOK provider that has no managed daily token cap.
    // `buffer.length` IS the decoded byte count. On failure `mediaToTextViaLLM` throws, so
    // `recordMediaUsage` below never runs — no budget is consumed for a failed transcription.
    const budget = await checkMediaBudget(tenantId, 'stt', buffer.length);
    if (budget.exceeded) {
      throw new OpenwopError('rate_limited', `Daily transcription budget reached (${budget.cap} bytes; ${budget.used} used). Resets at 00:00 UTC.`, 429, { kind: 'stt', cap: budget.cap, used: budget.used });
    }
    const text = await mediaToTextViaLLM(tenantId, buffer, mime, 'audio');
    await recordMediaUsage(tenantId, 'stt', buffer.length);
    return text;
  }
  throw new OpenwopError(
    'validation_error',
    `Cannot extract text from \`${contentType}\` — supported: text/*, PDF, Word, PowerPoint, Excel, OpenDocument, RTF, and (when enabled) images (vision) + audio (transcription). Video transcription (extract the audio track first) and archives are not supported.`,
    415,
    { contentType },
  );
}

/** OCR an image by asking the host MANAGED provider's VISION model to read its text —
 *  in-service (like `cms/translate.ts`), so it composes the existing provider + its
 *  governance + daily usage cap (no local OCR engine). The image is fenced as untrusted
 *  later (ADR 0027); a non-vision managed model or a provider error maps to a clean 422. */
/**
 * Turn a media file into text by asking the host MANAGED provider's multimodal model —
 * IMAGE → vision OCR, AUDIO → speech transcription — in-service (the `cms/translate.ts`
 * pattern), composing the provider + its governance + daily usage cap (no local engine).
 *
 * REPLAY-UNSAFE BY DESIGN: a live provider call is non-deterministic on `:fork`. This is
 * only sound because every caller of `extractTextFromBytes` is a NON-recorded service op
 * (KB routes + the knowledge-sync runner) — NOT a recorded workflow run. The ctx
 * workflow-surface ingest ops STRUCTURALLY reject media `contentBase64` (see
 * `notebooksService.ingestSource`), so media only ever reaches here off a service path;
 * recorded-run transcription stays on the notebooks `transcribe-source` node (`ctx.callAI`).
 */
async function mediaToTextViaLLM(tenantId: string, buffer: Buffer, mime: string, kind: 'image' | 'audio'): Promise<string> {
  // Audio prompt is shared with callTranscriber (RFC 0106 §B) via the core constant so
  // the two managed-transcription paths can't drift; the OCR/image prompt stays local
  // (only kb does OCR).
  const system = kind === 'image'
    ? 'You are an OCR engine. Transcribe ALL text visible in the image verbatim, preserving reading order and line/table structure. Output ONLY the transcribed text — no commentary. If there is no text, output nothing.'
    : AUDIO_TRANSCRIPTION_SYSTEM_PROMPT;
  const part: ContentPart = kind === 'image'
    ? { type: 'image', mimeType: mime, dataBase64: buffer.toString('base64') }
    : { type: 'audio', mimeType: mime, dataBase64: buffer.toString('base64') };
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: kind === 'image' ? 'Transcribe the text in this image.' : AUDIO_TRANSCRIPTION_USER_PROMPT }, part] },
  ];
  // ADR 0110: resolve a capability-aware dispatch (managed-if-capable → tenant BYOK default
  // → null). On the reference host the managed target is MiniMax (text-only), so media
  // routes to the tenant's configured default AI provider; if none is capable, 422 honestly.
  const cap = kind === 'image' ? 'vision' : 'audio';
  const dispatch = await resolveHeadlessAi(tenantId, kind);
  if (!dispatch) {
    throw new OpenwopError('validation_error', `No ${cap}-capable AI provider is available for \`${mime}\`. Configure a default AI provider (with a ${cap}-capable model) in BYOK settings.`, 422, { contentType: mime });
  }
  try {
    // ADR 0111 review fix: a transcript can be FAR longer than OCR'd image text. An image's
    // text fits in 8k tokens; a long recording needs the model's full output budget (~64k) or
    // it truncates mid-transcript. Audio also runs through the File API (upload + ≤60s poll +
    // a multi-minute generate), so it needs a generous deadline well past the 120s dispatch
    // default — else it aborts before finishing.
    const opts = kind === 'audio'
      ? { maxTokens: AUDIO_MAX_OUTPUT_TOKENS, timeoutMs: AUDIO_DISPATCH_TIMEOUT_MS }
      : { maxTokens: 8192 };
    return await dispatch(messages, opts);
  } catch (err) {
    throw new OpenwopError('validation_error', `Could not ${kind === 'image' ? 'OCR' : 'transcribe'} the \`${mime}\` file.`, 422, { contentType: mime, reason: err instanceof Error ? err.message : String(err) });
  }
}

/** Resolve the document's source text from pasted text, uploaded bytes
 *  (`contentBase64`+`contentType`, extracted per-MIME), or a Media token — enforcing
 *  the tenant boundary on the asset. */
async function resolveSource(
  tenantId: string,
  input: { text?: unknown; mediaToken?: unknown; contentBase64?: unknown; contentType?: unknown; url?: unknown },
): Promise<{ text: string; source: DocSource; derivedTitle?: string }> {
  // ADR 0351 P4 — URL ingest: fetch through the SSRF-guarded web-research
  // surface (readable extraction, body-capped). Web content is ALWAYS fenced
  // untrusted downstream (source.kind !== 'text' ⇒ untrusted in ingestDocument).
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      throw new OpenwopError('validation_error', '`url` MUST be an http(s) URL.', 400, { field: 'url' });
    }
    const web = createWebResearchSurface({ tenantId });
    const { pages } = await web.fetchBatch({ urls: [url], extractReadable: true, maxBodyBytes: 2_000_000 });
    const page = pages[0];
    const text = typeof page?.extractedText === 'string' ? page.extractedText.trim() : '';
    if (!text) {
      throw new OpenwopError('validation_error', 'The URL returned no extractable text.', 422, { url });
    }
    return { text: text.slice(0, MAX.text), source: { kind: 'url', url }, ...(page?.title ? { derivedTitle: page.title } : {}) };
  }
  // Direct file-upload path: bytes + MIME → extracted text (file upload to KBs).
  const contentBase64 = typeof input.contentBase64 === 'string' ? input.contentBase64 : '';
  const contentType = typeof input.contentType === 'string' ? input.contentType : '';
  if (contentBase64 && contentType) {
    // Guard BEFORE decoding + parsing (review fix): reject malformed base64 and cap
    // the DECODED size so a ~48 MB body can't drive an unbounded in-process
    // PDF/DOCX parse (a zip-bomb DOCX or pathological PDF is far worse than its
    // byte count). ~3/4 of the base64 length is the decoded byte count — cheap pre-check.
    if (!BASE64_RE.test(contentBase64) || contentBase64.length % 4 !== 0) {
      throw new OpenwopError('validation_error', 'Field `contentBase64` must be valid base64.', 400, { field: 'contentBase64' });
    }
    // Audio gets the larger cap (ADR 0111 — long-form transcription via the File API).
    const uploadCap = AUDIO_MIME.has(contentType.toLowerCase().split(';')[0]!.trim()) ? MAX_AUDIO_DECODED_BYTES : MAX_UPLOAD_DECODED_BYTES;
    if (Math.floor((contentBase64.length * 3) / 4) > uploadCap) {
      throw new OpenwopError('validation_error', `File exceeds the ${Math.round(uploadCap / (1024 * 1024))} MiB upload cap.`, 413, { maxBytes: uploadCap });
    }
    const extracted = await extractTextFromBytes(tenantId, Buffer.from(contentBase64, 'base64'), contentType);
    const text = extracted.slice(0, MAX.text);
    if (text.trim().length === 0) throw new OpenwopError('validation_error', 'No extractable text in the uploaded file.', 400, { contentType });
    return { text, source: { kind: 'media' } };
  }
  // NOT cleanString: a media token is a base64url capability credential that
  // legitimately looks secret-shaped, so `scrubSecretShaped` would redact it and
  // the lookup would 404. Validate the charset + length instead, no scrubbing.
  const mediaToken = typeof input.mediaToken === 'string' ? input.mediaToken.trim() : '';
  if (mediaToken) {
    if (mediaToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(mediaToken)) {
      throw new OpenwopError('validation_error', 'Invalid `mediaToken`.', 400, { field: 'mediaToken' });
    }
    const asset = await resolveMediaAsset(mediaToken);
    if (!asset || asset.tenantId !== tenantId) {
      throw new OpenwopError('not_found', 'Media asset not found.', 404, { mediaToken });
    }
    // Extract per-MIME (text/* + PDF + DOCX) — same path as a direct upload.
    const extracted = await extractTextFromBytes(tenantId, Buffer.from(asset.contentBase64, 'base64'), asset.contentType);
    const text = extracted.slice(0, MAX.text);
    if (text.trim().length === 0) throw new OpenwopError('validation_error', 'The media asset has no extractable text.', 400, {});
    return { text, source: { kind: 'media' } };
  }
  const text = cleanString(input.text, MAX.text);
  if (text.trim().length === 0) {
    throw new OpenwopError('validation_error', 'Provide `text`, a file upload, or a `mediaToken` to ingest.', 400, { field: 'text' });
  }
  return { text, source: { kind: 'text' } };
}

// ─── ADR 0398 P3 — versioned reindex machinery ─────────────────────────────

const REINDEX_PROVIDERS = new Set(['local', 'openai', 'google', 'cohere']);
const EMBED_BATCH_CHUNKS = 64;                 // chunks embedded per provider call
const DEFAULT_DRAIN_CHUNKS = 512;              // chunks processed per drain invocation
const reindexMaxChunks = (): number => { const v = Number(process.env.OPENWOP_KB_REINDEX_MAX_CHUNKS); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200_000; };

// ADR 0643 D1a — TWO expiry ceilings, because ONE wall-clock number cannot serve both
// live states. A `running` job's `updatedAt` is a DRAIN-LIVENESS lease: something is
// supposed to be moving the cursor, so 30 minutes of silence means the driver is gone
// (until D1b lands, the only driver is a browser tab). A `paused` job is budget-paused
// BY CONSTRUCTION — `drainReindex` is the only writer of `paused` and it writes it only
// when `checkEmbedBudget` says the DAILY cap is reached — so its clock is a budget
// rollover, not a batch duration, and a 30-minute lease over it would destroy exactly
// the legitimate work this lease exists to protect. 48 h = two rollovers: a job that
// sat through two of them is not waiting for budget, it is abandoned.
const reindexLeaseMs = (): number => { const v = Number(process.env.OPENWOP_KB_REINDEX_LEASE_MS); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 30 * 60_000; };
const reindexPauseMaxMs = (): number => { const v = Number(process.env.OPENWOP_KB_REINDEX_PAUSE_MAX_MS); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 48 * 60 * 60_000; };

/** `cutting-over` (ADR 0643 R4 review, Should 1) — the job has claimed the staging
 *  namespace and is flipping the collection onto it. LIVE (a write is still refused,
 *  `commitReindexJob` still accepts the next transition) but NOT cancellable while
 *  fresh: cancel and cutover arbitrate on this status, and a cancel that won here would
 *  GC a namespace the collection is about to serve. A row stuck here past the
 *  `running` lease (a crash mid-flip) is reclaimed by D1a's expiry like any other. */
export type ReindexStatus = 'running' | 'paused' | 'cutting-over' | 'done' | 'failed' | 'cancelled';
const REINDEX_LIVE = new Set<ReindexStatus>(['running', 'paused', 'cutting-over']);

/** A versioned reindex job. Keyed `${tenantId}:${orgId}:${collectionId}` (one live job per
 *  collection). `targetSpec` is applied to the collection only at CUTOVER — until then the
 *  collection keeps serving its old spec/namespace, so `hydrate` needs no special-casing. */
interface ReindexJob {
  key: string;
  tenantId: string; orgId: string; collectionId: string;
  targetSpec: EmbeddingSpec;
  /** ADR 0398 P3 (review fix) — enrichment is BAKED at start (it's part of `toSig`), so a
   *  mid-reindex config change can't make drain embed with a different enrichment than the
   *  target namespace assumes. */
  enrich: 'off' | 'heading-path';
  fromSig: string; toSig: string;
  /**
   * KB-2 R2 — the STAGING NAMESPACE, stamped at `startReindex` rather than re-derived
   * at every drain.
   *
   * `embeddedChunks` is a durable RESUME CURSOR into a namespace that used to be
   * DERIVED-never-stored. So a job that straddled the KB-1 namespace cutover resumed
   * against a DIFFERENT, EMPTY namespace (`orgId/collectionId#sig` instead of
   * `collectionId#sig`) and never wrote chunks `[0, embeddedChunks)` into it. Cutover
   * then flips `activeSignature` AND sets `hydrated`, so `doHydrate` short-circuits for
   * the rest of the process: dense search silently serves only the TAIL of the corpus,
   * with no error and no log, until a restart — and these jobs are explicitly long-lived
   * across days.
   *
   * Stamping makes the cursor and the namespace one durable fact. A job written BEFORE
   * this field existed has no stamp, and its cursor cannot be trusted against any
   * namespace we can derive today — so `drainReindex` REWINDS it to 0 rather than
   * resuming into a hole. (Absent on legacy rows only; every new job carries it.)
   */
  stagingNamespace?: string;
  totalChunks: number; embeddedChunks: number;
  status: ReindexStatus;
  costEstimateTokens: number; costSpentTokens: number;
  error?: string;
  startedAt: string; updatedAt: string;
  /**
   * ADR 0643 D1a R2 (review Should 3) — the last time `embeddedChunks` actually ADVANCED,
   * as distinct from the last time anything touched the row.
   *
   * The `paused` ceiling has to clock PROGRESS, not attempts. `updatedAt` is refreshed by
   * the budget branch every time it re-pauses, and the SPA drive loop re-pauses on every
   * iteration — so a job whose daily cap is smaller than one `EMBED_BATCH_CHUNKS` batch
   * makes zero progress while refreshing its own 48-hour clock forever. That is the
   * unbounded write-freeze D1a exists to remove, restored through a different door: a gate
   * with no exit is a defect. Absent on legacy rows ⇒ falls back to `startedAt`.
   */
  progressAt?: string;
  /**
   * ADR 0643 R3 review (Should 7) — WHICH driver this job actually has. `scheduled`
   * means `ensureKbReindexDriver` registered the chain + scheduler job; `interactive-only`
   * means it could not (chain pack not installed, `registerJob` refused) and the rebuild
   * progresses only while a browser tab drives it — so the console can say WHICH it is
   * instead of promising "continues on the server" unconditionally. Absent on a row that
   * predates this field ⇒ read as `interactive-only` (a legacy live job has no driver
   * until it ends or D1a's lease cancels it — see the ADR's D1b correction note).
   */
  driver?: 'scheduled' | 'interactive-only';
  /**
   * ADR 0643 D1a — OPTIMISTIC-CONCURRENCY GENERATION. Bumped by every mutation, including
   * the `startReindex` INSERT (which CASes against the row it replaces rather than
   * resetting the counter — R2 Blocker 2: a blind `gen: 0` insert made a NEW job at the
   * same key indistinguishable from the old one to a drain that had read the old one at
   * gen 0). Absent on rows written before this field existed (read as 0).
   *
   * A COUNTER IS NOT AN IDENTITY, and the drift check must not pretend otherwise: the row
   * can be DELETED and recreated at the same key, so every drift check compares
   * `startedAt` + `toSig` alongside `gen` (`sameReindexJob` below).
   *
   * WHY A JOB ROW NEEDS ONE. `kb:reindex` has no CAS of its own and `drainReindex`
   * READS the job, then SUSPENDS across a provider `embed()` call (seconds), then
   * writes back. A blind `put` there lost-updates any decision taken while it was
   * suspended — and the decision now taken while it is suspended is the LEASE CANCEL,
   * which drops the staging vectors. Lost-updating a cancel back to `running` resumes
   * the job into a namespace whose vectors were just deleted, with a cursor that skips
   * them, and cuts over onto the truncated result: precisely the corruption
   * `assertNoLiveReindex` exists to prevent, arriving through the fix for it.
   *
   * So `gen` is not decoration on top of `compareAndSwap`. CAS alone only proves the
   * stored BYTES have not moved; `gen` is what lets a writer say "the row I based this
   * whole local job copy on" — including a cursor and a staging namespace — and refuse
   * when anyone else has touched it.
   */
  gen?: number;
}
const reindexJobs = new DurableCollection<ReindexJob>('kb:reindex', (j) => j.key);
const reindexKey = (tenantId: string, orgId: string, collectionId: string): string => `${tenantId}:${orgId}:${collectionId}`;

/**
 * ADR 0398 P3 (review fix) — reject a document mutation while a reindex is BUILDING for the
 * collection. A concurrent ingest/delete lands only in the ACTIVE namespace, so the staging
 * build (a one-pass snapshot cursor) would miss an add, resurrect a delete, or skew its
 * cursor — corrupting the post-cutover index. Managed collections can't reindex, so their
 * indexers never hit this.
 *
 * COST, stated because this guard sits on a hot path (R2 review NIT). Past its ceiling the
 * guard runs a full `cancelReindex` INLINE — an O(documents-in-collection) scan plus a vector
 * delete — before it returns. It is bounded and self-limiting (the first caller to win the
 * CAS makes the row terminal, and every later caller then falls out at the status check one
 * `get` in), but the first caller pays it, and in a per-document loop such as the
 * knowledge-sync runner that first caller is one iteration of the loop. Acceptable against
 * the alternative (an unbounded write-freeze) and worth knowing before adding a fourth guard
 * site; a background sweeper would move the cost off the write path if it ever bites.
 *
 * THREE call sites, not two (ADR 0643 D1a, review of the grade's filed count):
 * `ingestDocument`, `deleteDocument` AND `upsertDocument` — the last being the in-process
 * replace path every managed indexer uses, so the freeze reached the derived-KB mirrors too.
 *
 * A DELIBERATE PRECEDENCE, recorded rather than discovered later (ADR 0643 D1a, review #8;
 * CORRECTED in R2 review Should 5, where the claim was asserted and half wrong). Because
 * expiry now CANCELS, an erasure (`eraseSubjectKb` → `deleteDocument`) can cancel a STALE
 * reindex — the right order, since a rebuild is re-runnable and an erasure deadline is not.
 * Two corrections to how that used to be written here: the cancel needs no admin on either
 * side (`eraseSubjectKb`'s docblock names the actual drivers, one of which has no acting
 * user), and the non-stale half is NOT "a 409 the erasure lane retries" — nothing retried
 * it. `eraseSubjectKb` now collects the 409 so one blocked collection cannot abandon the
 * rest, and rethrows it named. Witnessed, not asserted: see `kb-erasure-retention.test.ts`
 * and the D1a block in `kb-reindex.test.ts`.
 */
async function assertNoLiveReindex(tenantId: string, orgId: string, collectionId: string): Promise<void> {
  const job = await reindexJobs.get(reindexKey(tenantId, orgId, collectionId));
  if (!job || !REINDEX_LIVE.has(job.status)) return;
  // ADR 0643 D1a — a BOUNDED self-heal. Without one this guard is unbounded: the only
  // drain driver is a browser tab, so an abandoned tab (or the ordinary daily embed-budget
  // pause) froze writes on this collection FOREVER, for all three call sites below and
  // their eight production callers.
  // A `running` job is clocked by ANY activity (`updatedAt` is a drain-liveness heartbeat);
  // a `paused` job is clocked by PROGRESS, because the budget branch refreshes `updatedAt`
  // on every re-pause and the SPA loop re-pauses continuously — see `ReindexJob.progressAt`.
  const clock = job.status === 'paused' ? (job.progressAt ?? job.startedAt) : job.updatedAt;
  const ageMs = Date.now() - Date.parse(clock);
  const ceilingMs = job.status === 'paused' ? reindexPauseMaxMs() : reindexLeaseMs();
  if (Number.isFinite(ageMs) && ageMs > ceilingMs) {
    // EXPIRY MEANS CANCEL, NEVER "IGNORE". Ignoring the job and letting the write through
    // is the obvious fix and it CORRUPTS the index: the write lands only in the ACTIVE
    // namespace while the staging build is a one-pass snapshot cursor, so the build
    // resurrects the delete / misses the add and cuts over onto it (see the docblock above).
    // Cancelling drops the staging vectors and clears `pendingSignature` first.
    log.warn('kb_reindex_lease_expired', { tenantId, collectionId, reindexStatus: job.status, ageMs, ceilingMs, clock });
    // ADR 0643 D3 — the cancel emits `reindex.failed { reason: 'lease-expired' }`
    // (a bound operator chain can tell an abandoned rebuild from a deliberate cancel).
    const after = await cancelReindex(tenantId, orgId, collectionId, undefined, { reason: 'lease-expired' });
    // The cancel can legitimately LOSE its CAS — a drain that was merely slow, not dead,
    // committed a batch in the meantime and the job is live after all. Fail closed then:
    // report the refusal rather than proceeding on an assumption the store just falsified.
    if (after && REINDEX_LIVE.has(after.status)) {
      throw new OpenwopError('conflict', 'A reindex is in progress for this collection; retry after it completes or cancel it.', 409, { collectionId, reindexStatus: after.status, reason: 'reindex_in_progress' });
    }
    return;
  }
  // `reason` (R4 NIT 5) — the eraser collects THIS 409 and no other; a bare status+code
  // match would have swallowed `collection_cas_exhausted` as "blocked by a reindex".
  throw new OpenwopError('conflict', 'A reindex is in progress for this collection; retry after it completes or cancel it.', 409, { collectionId, reindexStatus: job.status, reason: 'reindex_in_progress' });
}

/** Fail-closed spec validation (400 on an unknown provider/model). */
function validateEmbeddingSpec(v: unknown): EmbeddingSpec {
  if (!v || typeof v !== 'object') throw new OpenwopError('validation_error', 'embeddingSpec MUST be an object.', 400, {});
  const o = v as Record<string, unknown>;
  if (typeof o.provider !== 'string' || !REINDEX_PROVIDERS.has(o.provider)) {
    throw new OpenwopError('validation_error', `embeddingSpec.provider MUST be one of ${[...REINDEX_PROVIDERS].join(', ')}.`, 400, { field: 'provider' });
  }
  const spec: EmbeddingSpec = { provider: o.provider as EmbeddingSpec['provider'] };
  if (o.model !== undefined) { if (typeof o.model !== 'string' || o.model.length > 128) throw new OpenwopError('validation_error', 'embeddingSpec.model MUST be a string.', 400, { field: 'model' }); spec.model = o.model; }
  if (o.credentialRef !== undefined) { if (typeof o.credentialRef !== 'string' || o.credentialRef.length > 128) throw new OpenwopError('validation_error', 'embeddingSpec.credentialRef MUST be a string.', 400, { field: 'credentialRef' }); spec.credentialRef = o.credentialRef; }
  if (o.dims !== undefined) { if (typeof o.dims !== 'number' || !Number.isInteger(o.dims) || o.dims < 1) throw new OpenwopError('validation_error', 'embeddingSpec.dims MUST be a positive integer.', 400, { field: 'dims' }); spec.dims = o.dims; }
  return spec;
}

/** The signature a target spec resolves to (mirrors hydrate's sig; `model` is the resolved
 *  provider model, or LOCAL_EMBEDDING_MODEL for the local floor). */
function signatureForResolved(providerMode: boolean, model: string, dims: number, enrich: 'off' | 'heading-path'): string {
  return `${providerMode ? 'provider' : 'local'}:${model}:${dims}:${enrich}:v${CHUNKER_VERSION}`;
}

/** The projected (wire-facing) job. `gen` is an internal concurrency token, so it is
 *  omitted alongside the routing keys — D1a changes no response shape. */
export type ReindexJobView = Omit<ReindexJob, 'key' | 'tenantId' | 'orgId' | 'gen'>;

function projectJob(j: ReindexJob): ReindexJobView {
  const { key: _k, tenantId: _t, orgId: _o, gen: _g, ...rest } = j;
  return rest;
}

/**
 * ADR 0643 D1a — the ONE writer for a LIVE reindex job. Compare-and-swap, with the
 * 4-attempt retry loop `recordOwnership` hand-rolls for the same reason
 * (`workflowOwnership.ts:91-99`), and TWO refusals `recordOwnership` does not need:
 *
 *  - **status.** It refuses to write over a row whose status has LEFT `running`/`paused`.
 *    A terminal row is owned by whoever made it terminal: the canceller owns the staging
 *    namespace it is GC-ing, and a `done` row owns a namespace that is now the collection's
 *    ACTIVE one. Rebasing a cancel onto a `done` row would delete the live index.
 *  - **no blind-put tail.** `recordOwnership` ends persistent contention with a
 *    last-writer `put`, because there the worst case is a stale list label. Here the worst
 *    case is a resurrected job over a half-GC'd namespace, so contention must FAIL the
 *    caller (which then aborts) rather than win.
 *
 * `mutate` receives the FRESH row so a rebasing caller (cancel) genuinely benefits from a
 * retry; a caller whose intent is only valid against the row it read (drain, carrying a
 * cursor) returns `null` to abandon.
 */
/**
 * ADR 0643 D1a R2 (review Blocker 2) — is `fresh` still the SAME JOB our local copy came
 * from? Generation equality alone answers "has the row been written since?" and that is a
 * different question: `startReindex` can delete-and-recreate a job at the same key, and the
 * new one starts its own counter, so a drain holding job #1 at gen 0 saw gen 0 on the row
 * and committed job #1's cursor, `startedAt` and `totalChunks` straight over job #2.
 * `startedAt` + `toSig` are the identity; `gen` is the freshness.
 */
function sameReindexJob(fresh: ReindexJob, ours: ReindexJob): boolean {
  return (fresh.gen ?? 0) === (ours.gen ?? 0) && fresh.startedAt === ours.startedAt && fresh.toSig === ours.toSig;
}

interface ReindexCommit { ok: boolean; job: ReindexJob | null }
async function commitReindexJob(key: string, mutate: (fresh: ReindexJob) => ReindexJob | null): Promise<ReindexCommit> {
  let current: ReindexJob | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    current = await reindexJobs.get(key);
    if (!current) return { ok: false, job: null };
    if (!REINDEX_LIVE.has(current.status)) return { ok: false, job: current };
    const mutated = mutate(current);
    if (!mutated) return { ok: false, job: current };
    const next: ReindexJob = { ...mutated, gen: (current.gen ?? 0) + 1 };
    if (await reindexJobs.compareAndSwap(current, next)) return { ok: true, job: next };
  }
  return { ok: false, job: await reindexJobs.get(key) };
}

/** The current reindex job for a collection (projected), or null. */
export async function getReindexJob(tenantId: string, orgId: string, collectionId: string, caller?: SubjectCaller): Promise<ReindexJobView | null> {
  if (!(await readableCollection(tenantId, orgId, collectionId, caller))) return null; // KBC-1
  const j = await reindexJobs.get(reindexKey(tenantId, orgId, collectionId));
  return j ? projectJob(j) : null;
}

/** Start a reindex to a new embedding spec: validate, resolve the target signature +
 *  embedder (a provider spec MUST have a resolvable key up front — a 400 otherwise), estimate
 *  the chunk count + token cost, enforce the hard chunk ceiling, and enqueue a `running` job.
 *  Builds NOTHING yet (the collection keeps serving its old namespace). Admin-gated. */
export async function startReindex(tenantId: string, orgId: string, collectionId: string, specInput: unknown, caller?: SubjectCaller): Promise<ReindexJobView> {
  // ADR 0643 D1a R2 (review Blocker 2) — a start is a WRITE to the reindex row, so it goes
  // through the same door every other write does: a live job 409s here rather than being
  // silently overwritten, and a job past its ceiling is cancelled first (so this is not a
  // new way to freeze the collection). It runs BEFORE the collection read for the reason
  // `ingestDocument` does — the guard can cancel, which clears `pendingSignature`, and a
  // `col` read first would carry the pre-cancel value into the write below.
  await assertNoLiveReindex(tenantId, orgId, collectionId);
  const col = await mustGetCollection(tenantId, orgId, collectionId, caller);
  if (col.managed) throw new OpenwopError('validation_error', `This collection is managed (synced from ${col.managed}); its embedding is not reindexable here.`, 400, { collectionId });
  const spec = validateEmbeddingSpec(specInput);
  const dims = effectiveEmbedDims();
  const enrich = enrichmentOf(col);
  const providerMode = spec.provider !== 'local';
  let model = LOCAL_EMBEDDING_MODEL;
  if (providerMode) {
    const embedder = await resolveHeadlessEmbedderForSpecMaybeTest(tenantId, spec, dims);
    if (!embedder) throw new OpenwopError('validation_error', `No resolvable embeddings credential for provider '${spec.provider}'. Add its BYOK key first.`, 400, { provider: spec.provider });
    model = embedder.model;
  }
  const toSig = signatureForResolved(providerMode, model, dims, enrich);
  const fromSig = col.activeSignature ?? col.vectorSignature ?? '(none)';
  if (toSig === (col.activeSignature ?? col.vectorSignature)) {
    throw new OpenwopError('validation_error', 'The collection is already on this embedding spec.', 400, { toSig });
  }
  const docs = await docsInCollection(tenantId, orgId, collectionId);
  const perDoc = docs.map((d) => ({ doc: d, meta: chunkMetaRows(d) }));
  const totalChunks = perDoc.reduce((n, p) => n + p.meta.length, 0);
  if (totalChunks > reindexMaxChunks()) {
    throw new OpenwopError('validation_error', `Reindex exceeds the ${reindexMaxChunks()}-chunk ceiling (${totalChunks} chunks).`, 400, { totalChunks, cap: reindexMaxChunks() });
  }
  const costEstimateTokens = providerMode
    ? perDoc.reduce((n, p) => n + p.meta.reduce((m, c) => m + estimateTokens(enrich === 'heading-path' ? enrichWithPath(c.metadata.title, c.metadata.headingPath, c.metadata.text) : c.metadata.text), 0), 0)
    : 0;
  const now = new Date().toISOString();
  const key = reindexKey(tenantId, orgId, collectionId);
  // The generation CONTINUES from whatever row we are replacing — it never resets. A
  // recreated job is told apart by `startedAt`/`toSig` (`sameReindexJob`), but a counter
  // that restarts at 0 would additionally make a stale drain's CAS *succeed*, which is
  // strictly worse than making it merely undetectable.
  const priorRow = await reindexJobs.get(key);
  const job: ReindexJob = { key, tenantId, orgId, collectionId, targetSpec: spec, enrich, fromSig, toSig, stagingNamespace: collectionNamespace(col, toSig), totalChunks, embeddedChunks: 0, status: 'running', costEstimateTokens, costSpentTokens: 0, startedAt: now, updatedAt: now, progressAt: now, gen: (priorRow?.gen ?? 0) + 1 };
  // Insert under CAS against the exact row we read, so a concurrent start LOSES instead of
  // clobbering (the guard above and this swap are two different instants).
  if (!(await reindexJobs.compareAndSwap(priorRow ?? null, job))) {
    throw new OpenwopError('conflict', 'A reindex was started concurrently for this collection; re-read its status and retry.', 409, { collectionId });
  }
  // Marker only; `embeddingSpec` flips at cutover. CAS — a blind put here would revert a
  // cutover that another collection writer landed in between (review Blocker 1's family).
  await commitCollection(tenantId, orgId, collectionId, (fresh) => ({ ...fresh, pendingSignature: toSig }));
  // ADR 0643 D1b — the job row is the AUTHORITY the surface's structural gate
  // checks, so the driver is registered only AFTER the row exists. Ordering
  // matters: a scheduled fire that landed first would find no job and refuse —
  // correct, but it burns a budget slot and logs a refusal that reads like a bug.
  const scheduled = await ensureKbReindexDriver(tenantId, orgId, collectionId);
  // R3 Should 7 — stamp the outcome on the row (CAS; a cancel that already landed keeps
  // its terminal row and this write is refused, which is correct — nothing to drive).
  const stamped = await commitReindexJob(key, (fresh) => ({ ...fresh, driver: scheduled ? 'scheduled' : 'interactive-only' }));
  // ADR 0643 D3 — the ONE `reindex.started` site, after the row's CAS insert
  // landed (a losing concurrent start threw above and emits nothing). Admin door
  // only, so no `origin`. Awaited (D6). R4 NIT 3 — gated on the row still being
  // ours-and-live: a cancel that landed between the insert and the stamp has already
  // emitted `failed`, and a `started` after it would narrate a job that is over.
  if (stamped.ok || stamped.job?.status === 'running') {
    await kbMutated({ entity: 'reindex', verb: 'started', tenantId, orgId, collectionId });
  }
  return projectJob(stamped.job ?? job);
}

// ── ADR 0643 D1b — the recorded, scheduler-driven drain ────────────────────
//
// The ADR 0398 reindex had NO host-side driver: the only loop was
// `for (let i = 0; i < 10000; i++) await drainReindex(...)` in the SPA. Closing
// the tab stopped the rebuild, and `assertNoLiveReindex` then froze every write
// on the collection for all eight of its production callers. D1a made the freeze
// self-healing; this is what makes the rebuild actually FINISH.
//
// Modelled on `knowledgeSyncService`'s `knowledge-sync.run` wiring (the ONE host
// scheduler, `WF-KB-14`'s tripwire forbids a bespoke KB daemon) with three
// deliberate divergences, each of which decides whether the mechanism works at
// all. They are stated here because each one reads like a copy-paste omission.

const KB_REINDEX_CHAIN_ID = 'kb.reindex';

/**
 * The per-collection workflow id — TENANT-QUALIFIED, unlike `knowledgeSyncWorkflowId`.
 *
 * DIVERGENCE 1 (ADR 0643 D1b, review #10). `registerWorkflowDurable` writes into
 * a GLOBAL id-keyed map (`wfreg:<workflowId>`), and `orgId` is caller-suppliable
 * (`accessControlService` resolves membership per (subject, org), but the org id
 * itself arrives in the URL). `knowledge-sync` gets away with `<chainId>:<sourceId>`
 * because a sourceId is a server-minted UUID; `<orgId>:<collectionId>` is not that,
 * so tenant B could mint a workflow id colliding with tenant A's. `reindexKey`
 * already carries the tenant for exactly this reason; the workflow id mirrors it.
 *
 * EXPORTED because it is the surface's STRUCTURAL authorization check — the verb
 * compares `scope.workflowId` against this, so the minting site and the checking
 * site are one function, not two spellings of a format string.
 */
export function kbReindexWorkflowId(tenantId: string, orgId: string, collectionId: string): string {
  return `${KB_REINDEX_CHAIN_ID}:${reindexKey(tenantId, orgId, collectionId)}`;
}

/** The per-collection scheduler job id (mirrors `knowledgeSyncJobId`'s shape). */
export function kbReindexJobId(tenantId: string, orgId: string, collectionId: string): string {
  return `kbreindex:${reindexKey(tenantId, orgId, collectionId)}`;
}

/**
 * DIVERGENCE 2 (review #6) — the CADENCE, and why it is not per-minute.
 *
 * The scheduler consumes the tenant's autonomous-run budget on EVERY fire — 120
 * per hour by default (`runBudgetService`), consumed on denial too — and an
 * over-budget fire is DROPPED, not queued (`scheduleDaemon`). A per-minute job
 * would eat half the tenant's entire budget for the life of the reindex, two
 * concurrent reindexes would eat all of it, and the drops would then stall the
 * job past D1a's 30-minute lease, which would CANCEL the reindex. D1a and D1b
 * together would have failed more reliably than either alone.
 *
 * The cron is `*\/10 * * * *` (escaped here only so it does not close this
 * comment) = 6 fires/hour, 5% of the budget, and each fire drains ONE LARGE
 * slice instead of a small one.
 */
const KB_REINDEX_CRON = '*/10 * * * *';

/**
 * Chunks per scheduled slice.
 *
 * Sized against the RFC 0058 run-duration ceiling (`RUN_DURATION_CEILING_MS`,
 * 600 000 ms), not guessed: the drain embeds in `EMBED_BATCH_CHUNKS`-sized
 * provider calls, so 2048 chunks is 32 provider round-trips. At a pessimistic
 * 5 s per batch that is 160 s — inside the ceiling with a 3.7x margin — and the
 * local (deterministic) embedder finishes in milliseconds. The slice is also
 * bounded by the same 4096 ceiling the REST drain door applies, so the scheduled
 * lane can never ask for more than an operator can.
 *
 * The budget arithmetic the cadence depends on: 6 fires/h x 2048 = 12 288
 * chunks/hour, so the 200 000-chunk `reindexMaxChunks()` ceiling is ~16 h of
 * unattended draining. Overridable per deployment.
 */
export const kbReindexSliceChunks = (): number => {
  const v = Number(process.env.OPENWOP_KB_REINDEX_SLICE_CHUNKS);
  return Number.isFinite(v) && v > 0 ? Math.min(4096, Math.floor(v)) : 2048;
};

/**
 * Idempotently register (+ own + first-revision) the collection's `kb.reindex`
 * workflow and its scheduler job.
 *
 * DIVERGENCE 3 (review #1) — NO `featureId` ON THE JOB, and this is the one that
 * decides whether any fire ever happens. The ADR 0599 §6 owning-feature gate
 * resolves `featureId` through `resolveOne`, which returns `null` for a feature
 * whose toggle has been REMOVED (`getToggleDefault` is undefined once a feature
 * graduates), and `scheduleDaemon` treats `null` as disabled and records
 * `recordJobSkipped(_, 'feature-disabled')`. `kb` graduated its toggle
 * (`feature.ts` — "No toggleDefault → always-on"), so copying knowledge-sync's
 * `featureId: 'knowledge-sync'` verbatim would skip EVERY fire, FOREVER, as an
 * `info` log rather than an error — and D1a would then cancel the stalled job 30
 * minutes later. `kb` takes the daemon's documented absent-`featureId`
 * (ungated) path. `kb-reindex-scheduled-drain.test.ts` asserts both halves: the
 * fire happened, AND no skip was recorded for `feature-disabled` or budget.
 *
 * Best-effort by design: a host running with `OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0`
 * has no `kb.reindex` chain, and a reindex must still be startable there (the
 * SPA drive loop calls the same route). It is logged at ERROR, not swallowed —
 * an operator on that configuration has an interactive-only reindex and should
 * know it.
 */
async function ensureKbReindexDriver(tenantId: string, orgId: string, collectionId: string): Promise<boolean> {
  const found = getChain(KB_REINDEX_CHAIN_ID);
  if (!found) {
    log.error('kb_reindex_chain_missing', {
      tenantId, collectionId, chainId: KB_REINDEX_CHAIN_ID,
      note: 'the kb-reindex workflow-chain pack is not installed — this reindex has no server-side driver and will only progress while a browser tab drives it',
    });
    return false;
  }
  const workflowId = kbReindexWorkflowId(tenantId, orgId, collectionId);
  try {
    const expanded = expandChain(found.chain, { params: { orgId, collectionId } });
    // ADR 0643 R3 review (Should 3 + Should 4) — TRANSIENT, host-stamped (ADR 0369 / ADR
    // 0595 `withHostLifecycle`, never the chain's own metadata). Two consequences, both
    // load-bearing: a transient definition is hidden from the `/builder` gallery and the
    // `/` picker (so no member can POST a run of it — check (b) of the surface's
    // structural gate is no longer satisfiable by "any run-creating member"), and it is
    // what `runRetentionSweeper`'s transient GC collects once its runs are gone, which is
    // how the row is reclaimed WITHOUT deleting a definition that recorded runs still
    // replay against (see `teardownKbReindexDriver`).
    const def = withHostLifecycle({ ...expanded, workflowId }, { transient: true, generatedBy: KB_REINDEX_CHAIN_ID });
    await registerWorkflowDurable(def);
    await recordRevision(tenantId, def);
    // The ownership record is what makes the workflow resolvable; it is also what
    // `teardownKbReindexDriver` archives, because unlike a long-lived sync source this
    // workflow is EPHEMERAL — one per reindex ever run.
    await recordOwnership(tenantId, workflowId, { name: found.chain.label, nodeCount: expanded.nodes.length, transient: true });
    const res = await registerJob({
      jobId: kbReindexJobId(tenantId, orgId, collectionId),
      tenantId,
      cronExpr: KB_REINDEX_CRON,
      workflowId,
      enabled: true,
      metadata: { orgId, collectionId },
      // NO `featureId` — see the docblock. This absence is load-bearing.
    });
    if (!res.ok) {
      log.error('kb_reindex_job_register_failed', { tenantId, collectionId, code: res.error.code, message: res.error.message });
      return false;
    }
    log.info('kb_reindex_driver_registered', { tenantId, collectionId, workflowId, cronExpr: KB_REINDEX_CRON });
    return true;
  } catch (err) {
    log.error('kb_reindex_driver_register_failed', { tenantId, collectionId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Terminal status ⇒ remove the job AND the workflow's ownership + registry rows.
 *
 * `knowledge-sync`'s `deleteSyncSource` drops only the JOB, which is survivable
 * for a long-lived sync source and is not for a per-reindex ephemeral workflow:
 * a tenant that reindexes weekly would otherwise collect one `/builder` gallery
 * entry per rebuild, forever. Idempotent and best-effort — a second terminal
 * observation (the REST drain and a scheduled fire can both see `done`) must not
 * throw, and the run that is executing this workflow has already been recorded,
 * so removing the definition does not invalidate its history (revisions are kept
 * by `deleteRegisteredWorkflow`'s own cascade policy).
 */
async function teardownKbReindexDriver(tenantId: string, orgId: string, collectionId: string): Promise<void> {
  const workflowId = kbReindexWorkflowId(tenantId, orgId, collectionId);
  try {
    await deleteJob(kbReindexJobId(tenantId, orgId, collectionId));
    // ADR 0643 R3 review (Should 3) — ARCHIVE, never delete, a definition that recorded
    // runs replay against. This used to `deleteRegisteredWorkflow` the moment the job
    // went terminal — i.e. after at least one recorded run of it — which is exactly what
    // `routes/workflows.ts` refuses with `workflow_referenced` (ADR 0369/0440: a run
    // re-resolves its definition by id at replay/`:fork`, so deleting it orphans the run
    // history and blanks the run page). The docblock above claimed "removing the
    // definition does not invalidate its history"; it did. So: when any run references
    // the workflow, mark it archived (it is already transient) and let the retention
    // sweeper's transient GC collect it once its runs are pruned; only a driver that
    // never ran (a start→cancel with no fire) is deleted outright.
    // ADR 0643 R4 review (Should 4) — ALWAYS archive; never delete here. The R3 shape
    // consulted `hasRunForWorkflow` after `deleteJob` and deleted a "never-fired" driver
    // outright — but a dispatch already past definition resolution and not yet past its
    // run-row write answers `false` there, and that run's later `:fork` could no longer
    // resolve. The transient GC (`runRetentionSweeper.__runTransientDefGcOnce`) already
    // deletes `transient && archivedAt && !hasRun` definitions and their ownership rows,
    // on its own tick, with the run row settled: that is the ONE deleter.
    const archivedAt = new Date().toISOString();
    const def = await getRegisteredWorkflowAsync(workflowId);
    if (def) await registerWorkflowDurable(withLifecycle(def, { transient: true, archivedAt }));
    await recordOwnership(tenantId, workflowId, { name: def?.metadata && typeof (def.metadata as { name?: unknown }).name === 'string' ? (def.metadata as { name: string }).name : 'KB reindex', nodeCount: def?.nodes.length ?? 0, transient: true, archivedAt });
    log.info('kb_reindex_driver_archived', { tenantId, collectionId, workflowId });
  } catch (err) {
    log.warn('kb_reindex_driver_teardown_failed', { tenantId, collectionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The terminal statuses that end a reindex — and so end its driver. */
const REINDEX_TERMINAL = new Set<ReindexStatus>(['done', 'failed', 'cancelled']);

/**
 * ADR 0643 D1b — tear the driver down once the job is terminal.
 *
 * Called from `drainReindex` and `cancelReindex` — the SERVICE, not the node —
 * so ONE owner covers every lane that can end a reindex: the scheduled drain,
 * the SPA's interactive loop (which finishes most of them), the admin cancel
 * button, and D1a's lease-expiry cancel inside `assertNoLiveReindex`. Putting it
 * on the node instead would have left a permanent `/builder` gallery entry per
 * reindex for the three lanes the node is not on.
 */
async function reapKbReindexDriverIfTerminal(tenantId: string, orgId: string, collectionId: string, status: ReindexStatus | undefined): Promise<void> {
  if (status && REINDEX_TERMINAL.has(status)) await teardownKbReindexDriver(tenantId, orgId, collectionId);
}

/** Drive a running/paused reindex: embed up to `maxChunks` more into the STAGING namespace
 *  (budget-checked per batch; PAUSE on cap, never half-embed-and-lie), then CUT OVER when
 *  the staging space is whole. Idempotent + resumable (resumes from `embeddedChunks`; a crash
 *  leaves the active space intact). The admin drain endpoint (or a heartbeat) calls this. */
async function drainReindexCore(tenantId: string, orgId: string, collectionId: string, maxChunks: number, caller: SubjectCaller | undefined, emit: KbEmitOptions): Promise<ReindexJobView | null> {
  await mustGetCollection(tenantId, orgId, collectionId, caller); // KBC-1 — before any job state is read or written
  const job = await reindexJobs.get(reindexKey(tenantId, orgId, collectionId));
  if (!job) return null;
  if (job.status !== 'running' && job.status !== 'paused') return projectJob(job); // terminal, or `cutting-over` (another drain owns the flip)

  // ADR 0643 D1a — EVERY job write below goes through this, never a blind `put`. `job` is a
  // local copy carrying a resume cursor and a staging-namespace stamp, so it is only valid
  // against the generation it was read at: if anyone else wrote the row while we were
  // suspended in a provider call, our copy describes a world that no longer exists and the
  // write is REFUSED (the mutator returns null) rather than lost-updating them.
  const commitOurs = async (): Promise<ReindexCommit> => {
    const ours: ReindexJob = { ...job };
    const res = await commitReindexJob(job.key, (fresh) => (sameReindexJob(fresh, ours) ? { ...job } : null));
    if (res.ok && res.job) job.gen = res.job.gen;
    else log.warn('kb_reindex_drain_write_refused', { tenantId, collectionId, intent: job.status, current: res.job?.status ?? '(gone)' });
    return res;
  };

  // ADR 0643 D3 — the ONE `reindex.failed` site for a drain-side failure. The
  // three failure branches below used to each spell the status flip; one helper
  // makes the transition guard (emit ONLY when OUR commit landed — a refused CAS
  // means someone else owns the row and its transition is theirs) impossible to
  // forget at one of them. `reason` is the closed enum; the provider's error
  // TEXT stays on the job row, never on the wire. Awaited (D6).
  const fail = async (reason: KbReindexFailReason, error: string): Promise<ReindexJobView> => {
    job.status = 'failed'; job.error = error; job.updatedAt = new Date().toISOString();
    const r = await commitOurs();
    if (r.ok) await kbMutated({ entity: 'reindex', verb: 'failed', tenantId, orgId, collectionId, reason, ...(emit.origin ? { origin: emit.origin } : {}) });
    return projectJob(r.job ?? job);
  };

  const col = await collectionRow(tenantId, orgId, collectionId);
  if (!col) return fail('collection-deleted', 'collection deleted');

  const dims = effectiveEmbedDims();
  const enrich = job.enrich; // BAKED at start (part of toSig) — not re-read from a possibly-changed config
  const providerMode = job.targetSpec.provider !== 'local';
  const embedder = providerMode ? await resolveHeadlessEmbedderForSpecMaybeTest(tenantId, job.targetSpec, dims) : null;
  if (providerMode && !embedder) return fail('embedder-unavailable', `embedder for '${job.targetSpec.provider}' became unavailable`);

  // The FULL deterministic chunk list (stable order), so `embeddedChunks` is a resume cursor.
  const docs = await docsInCollection(tenantId, orgId, collectionId);
  const allChunks = docs.flatMap((d) => chunkMetaRows(d).map((c) => ({
    id: c.id,
    metadata: c.metadata,
    embedInput: enrich === 'heading-path' ? enrichWithPath(c.metadata.title, c.metadata.headingPath, c.metadata.text) : c.metadata.text,
  })));
  // KB-2 R2 — see `ReindexJob.stagingNamespace`. An UNSTAMPED job predates the KB-1
  // namespace change, so its cursor points into a namespace this build no longer
  // derives; resuming would leave chunks [0, embeddedChunks) permanently missing from
  // the space that goes live at cutover. Rewind and rebuild the staging space whole.
  // Loud, and it costs a re-embed rather than a silently-truncated corpus.
  const stagingNs = job.stagingNamespace ?? collectionNamespace(col, job.toSig);
  if (job.stagingNamespace === undefined) {
    if (job.embeddedChunks > 0) {
      log.warn('kb_reindex_cursor_rewound', { tenantId, collectionId, embeddedChunks: job.embeddedChunks, stagingNs });
      job.embeddedChunks = 0;
    }
    job.stagingNamespace = stagingNs;
    job.updatedAt = new Date().toISOString(); // else this write is invisible to both ceilings
    const stamp = await commitOurs();
    if (!stamp.ok) return projectJob(stamp.job ?? job); // someone else owns the row now
  }
  job.status = 'running';
  let processed = 0;
  while (processed < maxChunks && job.embeddedChunks < allChunks.length) {
    const take = Math.min(EMBED_BATCH_CHUNKS, maxChunks - processed, allChunks.length - job.embeddedChunks);
    const batch = allChunks.slice(job.embeddedChunks, job.embeddedChunks + take);
    const batchTokens = providerMode ? batch.reduce((n, b) => n + estimateTokens(b.embedInput), 0) : 0;
    if (providerMode) {
      const budget = await checkEmbedBudget(tenantId, batchTokens);
      if (budget.exceeded) { job.status = 'paused'; job.error = `Daily embed budget reached (${budget.cap} tokens; ${budget.used} used). Resumes at 00:00 UTC.`; job.updatedAt = new Date().toISOString(); const r = await commitOurs(); return projectJob(r.job ?? job); }
    }
    let vectors: number[][];
    try {
      vectors = providerMode ? await embedder!.embed(batch.map((b) => b.embedInput)) : batch.map((b) => embedText(b.embedInput, dims));
    } catch (err) {
      return fail('embed-error', err instanceof Error ? err.message : String(err));
    }
    // ADR 0643 D1a — ABORT THE LOOP on a re-read that shows the row has left us. The
    // `embed()` above is the long suspension in this function (seconds, a network call), and
    // it is exactly when the lease expiry cancels a job it believes is dead. The canceller
    // has already GC'd `stagingNs`, so the upsert below would RESURRECT vectors into a
    // namespace nobody owns or will ever reclaim. Re-read BEFORE the write half of the batch
    // and leave the staging namespace to the canceller: write nothing, advance nothing.
    const fresh = await reindexJobs.get(job.key);
    if (!fresh || (fresh.status !== 'running' && fresh.status !== 'paused') || !sameReindexJob(fresh, job)) {
      log.warn('kb_reindex_drain_aborted', { tenantId, collectionId, current: fresh?.status ?? '(gone)', embeddedChunks: job.embeddedChunks });
      return projectJob(fresh ?? job);
    }
    await vectorSurface(tenantId).upsert({ namespace: stagingNs, items: batch.map((b, i) => ({ id: b.id, vector: vectors[i]!, metadata: b.metadata })) });
    if (providerMode) { await recordEmbedUsage(tenantId, batchTokens); job.costSpentTokens += batchTokens; }
    job.embeddedChunks += batch.length;
    processed += batch.length;
    // `progressAt` moves ONLY here, where the cursor actually advanced (review Should 3).
    job.updatedAt = new Date().toISOString();
    job.progressAt = job.updatedAt;
    const committed = await commitOurs();
    if (!committed.ok) {
      // The re-read above closes the wide window (a provider call). This closes the NARROW
      // one — a cancel that lands between that re-read and this write. The CAS refuses the
      // job write, but the vectors are already in `stagingNs`, and the canceller GC'd that
      // namespace BEFORE we wrote them: they would sit there forever, owned by nobody.
      //
      // GC them ONLY when the row went terminal (or vanished), i.e. the namespace really is
      // abandoned. A refusal against a still-LIVE row means a sibling drain won the race and
      // wrote the SAME ids from the same deterministic chunk list — deleting those would
      // truncate ITS build, which is worse than the orphan. `done` is excluded for the same
      // reason in the other direction: the namespace is now the collection's ACTIVE one.
      const cur = committed.job;
      if (!cur || cur.status === 'cancelled' || cur.status === 'failed') {
        try { await vectorSurface(tenantId).delete({ namespace: stagingNs, ids: batch.map((b) => b.id) }); }
        catch (err) { log.warn('kb_reindex_orphan_batch_gc_failed', { tenantId, collectionId, error: err instanceof Error ? err.message : String(err) }); }
      }
      return projectJob(cur ?? job); // do NOT fall through to cutover
    }
  }

  if (job.embeddedChunks >= allChunks.length) {
    // ADR 0643 D1a — CLAIM THE CUTOVER FIRST. Cutover and cancel are the two destructive
    // owners of the staging namespace, so they arbitrate on the ONE row both can CAS:
    // whoever moves the job out of `running`/`paused` owns the namespace, and the loser
    // does nothing (`commitReindexJob` refuses to write over a terminal row, so a cancel
    // that arrives after this point can no longer GC a namespace that is about to be, or
    // already is, the collection's ACTIVE one).
    //
    // The residual, restated after the R2 review FALSIFIED the first version of this note.
    // Between this commit and the flip below, `assertNoLiveReindex` sees a `done` job and
    // lets a write through. The note used to bound that at "one document's vectors"; it was
    // not bounded at all, because the ingest's trailing whole-row `put` reverted every
    // signature field this flip sets. That half is fixed at its source (both writers CAS the
    // collection row now, applying only the fields they own), and what remains really is
    // one document's vectors: an ingest that read the collection before the flip computes
    // the OLD namespace and upserts there, so the flip leaves those chunks behind until the
    // next hydrate re-derives them from the durable document. Re-derivable, and loud enough
    // to find. The alternative ORDERING still costs the whole index — it lets a canceller
    // delete the namespace the collection has just been pointed at, with no error and no
    // log — which is why the claim stays here rather than the order changing.
    //
    // ADR 0643 R4 review (Should 1) — the claim is `cutting-over`, NOT `done`. Claiming
    // `done` before the flip and then having the flip's CAS refuse (a 409 since R3's
    // Should 5) left a LYING terminal state: `done` on the row, the collection un-flipped,
    // `pendingSignature` stuck, the staging namespace orphaned, no `reindex.completed`
    // and no `reindex.failed`, and the throw skipping the driver reap. `cutting-over`
    // still wins the arbitration (a cancel refuses it while fresh — see `cancelReindex`)
    // and lets this function say what actually happened: `done` once the flip landed,
    // `failed { reason: 'cutover-conflict' }` when it did not.
    job.status = 'cutting-over';
    job.updatedAt = new Date().toISOString();
    const claimed = await commitOurs();
    if (!claimed.ok) return projectJob(claimed.job ?? job); // a cancel won — do NOT cut over
    // CUTOVER — flip the serving namespace FIRST (reads move to the fully-built staging
    // space atomically), THEN GC the old namespace (a crash in between orphans the old
    // vectors harmlessly; reads are already correct). Fail-closed.
    //
    // ADR 0643 D1a R2 (review Blocker 1) — RE-READ AND CAS, applying ONLY the four
    // signature fields. `col` was read before the first batch, minutes and a provider call
    // ago; writing that whole object back here silently reverted every field any other
    // writer had touched in the meantime — and, symmetrically, let any writer that had read
    // before this point revert the cutover itself. The four fields below are the only ones
    // this function owns; everything else on the row belongs to whoever wrote it last.
    let oldNs: string | null = null;
    let flipped: KnowledgeCollection | null;
    try {
      flipped = await commitCollection(tenantId, orgId, collectionId, (fresh) => {
        oldNs = collectionNamespace(fresh);
        return {
          ...fresh,
          embeddingSpec: job.targetSpec,
          activeSignature: job.toSig,
          vectorSignature: job.toSig,
          // Only ever clear OUR OWN marker.
          ...(fresh.pendingSignature === job.toSig ? { pendingSignature: undefined } : {}),
        };
      });
    } catch (err) {
      if (!isCasExhausted(err)) throw err;
      // R4 Should 1 — the flip lost to persistent contention. The staging namespace is
      // ours to reclaim (nothing else will), the marker is ours to clear (best-effort —
      // the same contention may refuse it), and the row goes `failed` with a typed
      // reason so the operator and any bound chain learn it. The rebuild is re-runnable.
      log.warn('kb_reindex_cutover_conflict', { tenantId, collectionId, stagingNs });
      try { const ids = allChunks.map((c) => c.id); if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: stagingNs, ids }); }
      catch (gcErr) { log.warn('kb_reindex_cutover_conflict_gc_failed', { tenantId, collectionId, error: gcErr instanceof Error ? gcErr.message : String(gcErr) }); }
      try { await commitCollection(tenantId, orgId, collectionId, (fresh) => (fresh.pendingSignature === job.toSig ? { ...fresh, pendingSignature: undefined } : null)); }
      catch (clearErr) { if (!isCasExhausted(clearErr)) throw clearErr; log.warn('kb_reindex_cutover_conflict_marker_stuck', { tenantId, collectionId }); }
      return fail('cutover-conflict', 'The collection was modified concurrently while cutting over; the rebuild was abandoned — start the reindex again.');
    }
    if (!flipped) { log.warn('kb_reindex_cutover_collection_gone', { tenantId, collectionId }); return fail('collection-deleted', 'collection deleted'); }
    // The flip landed: NOW the row is `done`. Our `cutting-over` claim is what makes this
    // commit ours to make (a cancel cannot have moved the row in between).
    job.status = 'done';
    job.updatedAt = new Date().toISOString();
    const finished = await commitOurs();
    if (!finished.ok) log.warn('kb_reindex_done_commit_refused', { tenantId, collectionId, current: finished.job?.status ?? '(gone)' }); // the flip is live regardless; the row is reconciled by the lease
    hydrated.set(hydrateKey(tenantId, orgId, collectionId), job.toSig); // serve the staged (now active) vectors directly — no re-embed
    if (oldNs !== null && oldNs !== collectionNamespace(flipped)) {
      // GC the old namespace by the UNION of old (durable chunkCount) + current ids so a
      // chunker-count skew can't orphan the old tail (mirror the P1 staleWipeIds guard).
      try { const oldIds = docs.flatMap((d) => staleWipeIds(d, chunkText(d.text).length)); if (oldIds.length > 0) await vectorSurface(tenantId).delete({ namespace: oldNs, ids: oldIds }); }
      catch (err) { log.warn('kb_reindex_old_namespace_gc_failed', { tenantId, collectionId, error: err instanceof Error ? err.message : String(err) }); }
    }
    // ADR 0643 D3 — the ONE `reindex.completed` site: the job claimed `done` AND the
    // collection flipped onto the staged namespace. Emitted LAST, after the old
    // namespace's GC, so a consumer that reacts by starting the next reindex cannot
    // race this function's own cleanup. Awaited (D6).
    await kbMutated({ entity: 'reindex', verb: 'completed', tenantId, orgId, collectionId, ...(emit.origin ? { origin: emit.origin } : {}) });
  }
  return projectJob(job);
}

/**
 * ADR 0643 D1b — the PUBLIC drain: `drainReindexCore` plus the driver reap.
 *
 * A wrapper rather than a reap at each of `drainReindexCore`'s six terminal
 * return points, because five of those six are error/abort paths and a teardown
 * that has to be remembered at each of them is a teardown that will be missed at
 * one of them. Every caller — the REST door the SPA loop drives, the scheduled
 * node, and the tests — goes through here.
 */
export async function drainReindex(tenantId: string, orgId: string, collectionId: string, maxChunks = DEFAULT_DRAIN_CHUNKS, caller?: SubjectCaller, emit: KbEmitOptions = {}): Promise<ReindexJobView | null> {
  const job = await drainReindexCore(tenantId, orgId, collectionId, maxChunks, caller, emit);
  await reapKbReindexDriverIfTerminal(tenantId, orgId, collectionId, job?.status);
  return job;
}

/**
 * Cancel a running/paused reindex: drop the job + its staging vectors; the active namespace
 * is untouched (it was never mutated during the build).
 *
 * ADR 0643 D1a — CLAIM BEFORE DESTROY. The status flip used to happen LAST, after the
 * staging GC, on a store with no CAS: so a `drainReindex` suspended in a provider `embed()`
 * call would blind-`put` its stale copy afterwards and resurrect the job to `running`, over
 * a namespace whose vectors this function had just deleted, with a cursor that skips them —
 * and the next drain would cut the collection over onto that truncated result. Both
 * destructive owners now arbitrate on the same row first: the flip to `cancelled` is a CAS,
 * and only the winner touches the vectors. A loser (a drain that legitimately committed a
 * batch first, or a cutover that already claimed `done`) returns the CURRENT row unchanged.
 */
export async function cancelReindex(tenantId: string, orgId: string, collectionId: string, caller?: SubjectCaller, emit: KbEmitOptions & { reason?: Extract<KbReindexFailReason, 'cancelled' | 'lease-expired'> } = {}): Promise<ReindexJobView | null> {
  await mustGetCollection(tenantId, orgId, collectionId, caller); // KBC-1
  const key = reindexKey(tenantId, orgId, collectionId);
  // ONE authority for "is this job still cancellable". The pre-D1a body asked twice — an
  // early read here, then an unguarded write at the end — and the answer could change in
  // between. `commitReindexJob` refuses a missing row and a terminal row, so the early read
  // is not merely redundant, it is a second opinion that can disagree with the write.
  // Rebasing mutator: a concurrent drain batch does NOT invalidate a cancel (we want to
  // cancel whatever the job has become), so a retry is meaningful here — unlike the drain's,
  // which carries a cursor and must refuse. `commitReindexJob` still refuses a TERMINAL row,
  // which is what stops a cancel from GC-ing a namespace a cutover has just made active.
  // R4 Should 1 — a `cutting-over` row is the other destructive owner MID-FLIP: refuse it
  // while fresh (the flip is milliseconds; the loser must not GC a namespace about to be
  // active). Past the `running` lease it is a crashed flip, and the D1a expiry cancel —
  // the only lane that reaches here with an aged row — reclaims it like any stale job.
  const claim = await commitReindexJob(key, (fresh) => (
    fresh.status === 'cutting-over' && Date.now() - Date.parse(fresh.updatedAt) <= reindexLeaseMs()
      ? null
      : { ...fresh, status: 'cancelled', updatedAt: new Date().toISOString() }
  ));
  if (!claim.ok || !claim.job) {
    log.warn('kb_reindex_cancel_refused', { tenantId, collectionId, current: claim.job?.status ?? '(gone)' });
    return claim.job ? projectJob(claim.job) : null;
  }
  const job = claim.job;
  // ADR 0643 D1b — the reindex is over, so its per-collection driver is too.
  await reapKbReindexDriverIfTerminal(tenantId, orgId, collectionId, job.status);
  const col = await collectionRow(tenantId, orgId, collectionId);
  let flipLanded = false;
  if (col) {
    // ADR 0643 D1a R5 — THE FLIP MAY ALREADY HAVE LANDED. A crash between the cutover's
    // `commitCollection` (which sets `activeSignature = toSig`) and its `status = 'done'`
    // commit leaves a `cutting-over` row over an ALREADY-FLIPPED collection; the D1a lease
    // then expires it and lands here. In that state `collectionNamespace(col, job.toSig)`
    // is not a staging namespace at all — it is the collection's SERVING namespace, and
    // GC-ing it wipes the live dense index (a full provider re-embed, or silent
    // lexical-only until the daily embed budget allows one — the KB-2 R2 class). The
    // freshness re-check was applied to the `pendingSignature` clear below and NOT to this
    // delete; that asymmetry was the defect. So: if the flip landed, the rebuild SUCCEEDED
    // and there is nothing of ours to collect — say so honestly rather than reporting
    // `lease-expired` for a build that worked.
    flipLanded = col.activeSignature === job.toSig;
    if (flipLanded) {
      log.warn('kb_reindex_cancel_after_landed_flip', { tenantId, collectionId, toSig: job.toSig });
    } else {
      // KB-2 R2 — GC the namespace the drain actually WROTE (the stamp), not a re-derived one.
      try { const docs = await docsInCollection(tenantId, orgId, collectionId); const ids = docs.flatMap((d) => staleWipeIds(d, chunkText(d.text).length)); if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: job.stagingNamespace ?? collectionNamespace(col, job.toSig), ids }); } catch { /* best-effort staging GC */ }
    }
    // ADR 0643 D1a R2 — CAS, and re-checked against the FRESH row: a cutover may have
    // landed since, in which case `pendingSignature` is no longer ours to clear.
    await commitCollection(tenantId, orgId, collectionId, (fresh) => (fresh.pendingSignature === job.toSig ? { ...fresh, pendingSignature: undefined } : null));
  }
  // ADR 0643 D3 — the ONE `reindex.failed` site for the CANCEL transition (the CAS claim
  // above is the guard: a loser returned before this line). `reason` is `'cancelled'`
  // for a deliberate cancel and `'lease-expired'` when D1a's guard cancelled a stale
  // job. Emitted LAST, after the staging GC: a consumer that reacts by starting a new
  // reindex to the same spec would otherwise mint the SAME staging namespace this
  // function is still deleting from. Awaited (D6).
  // ADR 0643 D1a R5 — but a cancel that arrived AFTER the flip landed is not a failure:
  // the rebuild finished and is serving. Reporting `lease-expired` there would tell a
  // bound operator chain that a successful reindex failed, which is the honesty rule this
  // ADR's event lane exists for. Emit `completed` instead, and leave the row's terminal
  // status alone — it is bookkeeping about a build whose OUTCOME was success.
  await (flipLanded
    ? kbMutated({ entity: 'reindex', verb: 'completed', tenantId, orgId, collectionId, ...(emit.origin ? { origin: emit.origin } : {}) })
    : kbMutated({ entity: 'reindex', verb: 'failed', tenantId, orgId, collectionId, reason: emit.reason ?? 'cancelled', ...(emit.origin ? { origin: emit.origin } : {}) }));
  return projectJob(job);
}

// ─── KB-3 — ADR 0464 erasure / ADR 0077 retention seams ────────────────────
//
// These live HERE rather than in a sibling module because the three derived
// stores (`documents`, `kb:veccache`, `kb:docrev`) are module-private, and the
// whole point of the fix is that erasure must reach the DERIVED artifacts, not
// just the document row. A deleted document whose embedding survives is still
// retrievable; a purged embedding whose per-chunk cache row survives is still
// re-assemblable without ever re-billing the provider.
//
// WHY THE EXEMPTION WAS WRONG. `retention-purgers.test.ts` recorded "kb is
// deliberately NOT in scope (it holds tenant knowledge content + a vector
// mirror, not data-subject PII)". That was defensible when ingest meant pasted
// text. KB now ingests uploaded PDF/DOCX/Office, image OCR and audio transcripts
// through a live provider, fetched URLs, whole media collections, and scheduled
// Drive/OneDrive folders — and the claim was already falsified in-tree by
// `profilesKnowledgeService.ts`, a registered subject eraser whose entire job is
// deleting a KB document.

/** The subject-keyed document-id conventions this host mints. A document under one
 *  of these IS the subject's own record and is DELETED on erasure (cascading its
 *  vectors, its per-chunk vector cache and its revision log). Anything else is the
 *  ORG's knowledge and is retained with the attribution anonymized — the same
 *  anonymize-don't-destroy decision `features/crm/erasure.ts` records. */
const subjectKeyedDocId = (subjectKey: string): readonly string[] => [subjectKey, `profile:${subjectKey}`, `user:${subjectKey}`];

/** The placeholder that replaces an erased actor id. Not the empty string: an absent
 *  `createdBy` is indistinguishable from a legacy row that never had one. */
export const ERASED_ACTOR = 'erased';

/**
 * ADR 0464 subject eraser for KB. STRICT — `eraseSubject` counts per-eraser failures,
 * so a swallowed error here would let the fan-out report a COMPLETE erasure over an
 * incomplete one. The ONE thing it catches is the reindex write-lock 409, and it still
 * rethrows it at the end (see the loop) — collecting is about not abandoning the other
 * collections, never about reporting success.
 *
 * ADR 0643 D1a R2 — ITS RELATIONSHIP TO A REINDEX, measured rather than asserted.
 * `deleteDocument` is guarded by `assertNoLiveReindex`, so:
 *   - a reindex past its ceiling is CANCELLED by this path and the erasure proceeds
 *     (erasure outranks a rebuild — the rebuild is re-runnable, the erasure deadline is
 *     not); and
 *   - a LIVE reindex refuses, and that refusal now reaches the caller as a 409 naming the
 *     blocked collections instead of an anonymous eraser failure.
 * The cancel is NOT admin-gated by construction. This eraser is registered on the ADR 0464
 * fan-out, whose drivers are the admin DSAR route (`features/users/routes.ts:365`) and
 * `consent.deleteSubject` — and the latter is called by `host/demoCdpSeed.ts:205` with no
 * acting user at all. So "an admin's reindex can be cancelled by an erasure" understates
 * it: no human need be present on either side.
 *
 * KNOWN RESIDUAL, stated rather than implied: free-text document CONTENT that merely
 * MENTIONS the subject is not reachable by an id match (the same residual the CRM
 * eraser records for approval `proposal` prose). Tenant teardown is the backstop.
 */
export async function eraseSubjectKb(tenantId: string, subjectKey: string): Promise<{ documentsDeleted: number; attributionsAnonymized: number }> {
  if (!tenantId || !subjectKey) return { documentsDeleted: 0, attributionsAnonymized: 0 };
  const keyed = new Set(subjectKeyedDocId(subjectKey));
  let documentsDeleted = 0;
  let attributionsAnonymized = 0;

  // ADR 0643 D1a R2 (review Should 5) — COLLECT, then rethrow. A LIVE reindex 409s
  // `deleteDocument`, and this loop spans every collection in the tenant: letting that
  // throw escape mid-loop abandoned every collection after it, having already deleted
  // documents and anonymized attributions in the ones before — a partial erasure that
  // `eraseSubject` then reports only as "this eraser failed". Every collection is now
  // attempted; the erasure still FAILS LOUD at the end (it must — the fan-out counts
  // failures, and a swallowed 409 would report a complete erasure over an incomplete one),
  // but with the blocked collections named so the retry is targeted.
  const blocked: string[] = [];
  // ADR 0643 R3 review (Blocker 1) — `PREAUTHORIZED_CALLER`, and an ERASER is THE
  // sanctioned bypass — at BOTH sites inside this function (the listing and the
  // delete), and at `profilesKnowledgeService.removeProfileStrict`, the DSAR remover
  // that reaches the same rows through `deleteDocument` (R4 NIT 2: that third site
  // used to pass `undefined`, which a bound Team-Portfolio collection would refuse).
  // KBC-1 made an omitted caller `{ subject: undefined }`, which
  // `filterReadable` refuses for every project/notebook-bound collection — so this loop
  // never SAW a bound corpus, never reached the subject's `profile:<key>` document or
  // `createdBy` attribution inside it, and returned `{ documentsDeleted: 0 }` as a
  // complete-looking erasure. A DSAR eraser has no membership to resolve and must not
  // need one: it reaches every row in the tenant by construction, and the ADR 0464
  // fan-out counts its failures precisely so a silent skip cannot pass for success.
  // Witnessed (bound-collection leg, `kb-erasure-retention.test.ts`).
  for (const col of await listAllTenantCollections(tenantId, PREAUTHORIZED_CALLER)) {
    try {
    for (const doc of await docsInCollection(tenantId, col.orgId, col.collectionId)) {
      if (keyed.has(doc.documentId)) {
        // The full cascade: vectors (staleWipeIds union — KB-4), the per-chunk
        // provider-vector cache, and the revision log.
        // ADR 0643 D3 (review #5) — `{ silent: true }` UNCONDITIONALLY, and not as a
        // volume trade-off: `doc.documentId` IS the subject key here, and a
        // `document.deleted { documentId }` would publish the just-erased person's
        // identifier to every webhook subscriber and bound run. Witnessed on both
        // count and payload in `kb-lifecycle-one-site.test.ts`.
        await deleteDocument(tenantId, col.orgId, col.collectionId, doc.documentId, PREAUTHORIZED_CALLER, { silent: true }); // R3 Blocker 1 — see the loop header
        documentsDeleted += 1;
        continue;
      }
      if (doc.createdBy === subjectKey) {
        doc.createdBy = ERASED_ACTOR;
        await documents.put(doc);
        attributionsAnonymized += 1;
      }
    }
    if (col.createdBy === subjectKey || col.updatedBy === subjectKey) {
      // ADR 0643 D1a R2 — CAS. This runs inside a scan over EVERY collection in the tenant,
      // so a whole-row put here could revert a cutover in a collection the erasure only
      // touched for an attribution string.
      await commitCollection(tenantId, col.orgId, col.collectionId, (fresh) => ({
        ...fresh,
        ...(fresh.createdBy === subjectKey ? { createdBy: ERASED_ACTOR } : {}),
        ...(fresh.updatedBy === subjectKey ? { updatedBy: ERASED_ACTOR } : {}),
      }));
      attributionsAnonymized += 1;
    }
    } catch (err) {
      // ONLY the reindex write-lock is collected. Anything else is a real failure of this
      // eraser and must surface immediately and unaltered.
      // R4 NIT 5 — by `details.reason`, not by status+code: `collection_cas_exhausted` is
      // also a 409 `conflict`, and it is NOT "blocked by a live reindex".
      if (err instanceof OpenwopError && err.httpStatus === 409 && (err.details as { reason?: unknown } | undefined)?.reason === 'reindex_in_progress') { blocked.push(col.collectionId); continue; }
      throw err;
    }
  }
  if (blocked.length > 0) {
    log.warn('kb_erasure_blocked_by_reindex', { tenantId, blocked: blocked.length, documentsDeleted, attributionsAnonymized });
    throw new OpenwopError('conflict', `A live reindex blocked erasure in ${blocked.length} collection(s); the rest completed. Cancel the reindex (or wait for its lease to expire) and retry.`, 409, { blockedCollections: blocked, documentsDeleted, attributionsAnonymized });
  }
  return { documentsDeleted, attributionsAnonymized };
}

/**
 * ADR 0077 retention purger for KB's DERIVED stores.
 *
 * It deletes ORPHANS only — `kb:veccache` and `kb:docrev` rows whose document no
 * longer exists — and never a live document. That boundary is deliberate and is the
 * honest answer to "what does age-based retention mean for a knowledge base?": a
 * tenant's KB content has no age semantics (a five-year-old policy document is still
 * the policy), so purging it on a clock would destroy the product. What DOES have a
 * defensible lifetime is the residue of a deleted document — per-chunk vector cache
 * rows and revision-log entries that carry the document's title and content hash and
 * that nothing can reach any more.
 *
 * Age is applied where the row CARRIES a timestamp (`kb:docrev.changedAt`); a
 * `kb:veccache` row has none, and an orphaned one has no retention value at any age,
 * so it is reclaimed whenever it is found. Said out loud because a purger that
 * quietly ignored `cutoffIso` would be the surprising half.
 */
export async function purgeOrphanKbDerivedRows(tenantId: string, cutoffIso: string): Promise<number> {
  if (!tenantId) return 0; // fail-closed — never a global purge
  const live = new Set((await documents.listByPrefix(`${tenantId}:`)).filter((d) => d.tenantId === tenantId).map((d) => d.documentId));
  let deleted = 0;
  for (const row of await vecCache.listByPrefix(`${tenantId}:`)) {
    // KB-7 — the prefix alone is NOT the tenant check. Tenant ids are colon-bearing
    // (`ws:…`, `anon:…`), so `listByPrefix('a:')` can return another tenant's rows; the
    // `live` set above already re-checks `row.tenantId`, and every sibling scan in this
    // file adds the same belt-and-braces guard (`docsInCollection`, `listCollections`).
    // This is a DELETE loop, so the missing guard was the one that mattered most.
    if (row.tenantId !== tenantId) continue;
    // key = `${tenantId}:${documentId}:${chunkIndex}` — the doc id is everything between.
    const rest = row.key.slice(tenantId.length + 1);
    const documentId = rest.slice(0, rest.lastIndexOf(':'));
    if (documentId.length === 0 || live.has(documentId)) continue;
    // KB-8 — `upsertDocument` is a delete-then-re-ingest, so between the two the document
    // row is GONE while its cache rows are not: a sweep landing in that window reclaims
    // them as orphans and the next hydrate re-embeds every chunk at provider cost — the
    // precise outcome this purger's docblock claims to avoid. In-flight upserts are
    // excluded. RESIDUAL, stated: the guard is per-PROCESS, so a sweep on another
    // instance during another instance's upsert can still land in the window. That is a
    // cost regression, never a correctness one (hydrate re-derives from durable text).
    if (upsertsInFlight.has(`${tenantId}:${documentId}`)) continue;
    await vecCache.delete(row.key);
    deleted += 1;
  }
  for (const row of await docRevisions.listByPrefix(`${tenantId}:`)) {
    if (row.tenantId !== tenantId) continue; // KB-7 — see above
    if (live.has(row.documentId)) continue;
    if (row.changedAt >= cutoffIso) continue;
    await docRevisions.delete(row.key);
    deleted += 1;
  }
  return deleted;
}

declarePiiFields('kb.collection', ['createdBy', 'updatedBy']);
declarePiiFields('kb.document', ['createdBy']);
registerSubjectEraser(async function eraseKbSubject(tenantId, subjectKey) { await eraseSubjectKb(tenantId, subjectKey); });
registerRetentionPurger({
  feature: 'kb',
  async purge(tenantId, classification, cutoffIso) {
    // Chunk vectors and revision rows carry document TEXT and content hashes.
    if (classification !== 'confidential-pii') return 0;
    return purgeOrphanKbDerivedRows(tenantId, cutoffIso);
  },
});
