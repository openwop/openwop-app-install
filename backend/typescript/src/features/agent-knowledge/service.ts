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
import { PREAUTHORIZED_CALLER, type SubjectCaller } from '../../host/subjectAccess.js'; // KBC-1 — `PREAUTHORIZED_CALLER` stays ONLY on the use lane AFTER a binding exists (see `bindCollection`)
import type { HostEventOrigin } from '../../host/hostEventDispatcher.js';
import type { AgentProfile } from '../../types.js';
import {
  getAgentProfile,
  setAgentKnowledge,
} from '../../host/agentProfileService.js';
import { createAgentMemoryPort } from '../../host/agentMemoryAdapter.js';
import { mayPruneKnowledgeBinding } from '../../host/knowledgeBindingPrune.js';
import {
  addSubjectNote,
  listSubjectNotes,
  removeSubjectNote,
  countSubjectNotes,
  countRecallOnlyEntries,
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
import { resolveAgentKnowledgeRetrieve, diagnoseAgentKnowledgeRetrieve, type AgentKnowledgeUnavailable } from '../../host/agentKnowledgeComposition.js';
import type { KnowledgeSourceKind } from '../../host/agentDispatch.js';

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
async function profileInitFor(tenantId: string, agentId: string): Promise<{ roleKey: string; autonomy: { specLevel: 'draft-only' } }> {
  const entry = await getRosterEntry(tenantId, agentId); // ADR 0379 P1 — tenant threaded (was a context-gated raw read)
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
  const col = await getCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER); // KBC-1
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
}

/** The agent's full knowledge view (read). The note count + memory live in the
 *  agent's RFC-0004 namespace; collections in KB. The `documents` projection per
 *  collection is what the panel lists with citations. */
export async function getAgentKnowledge(tenantId: string, agentId: string, caller: SubjectCaller): Promise<AgentKnowledgeView> {
  // `caller` is REQUIRED (ADR 0643 R4 Blocker 2): the default sentinel is what let two
  // of the four HTTP reads (`POST …/notes`, `PUT …/memory-writable`) slip through
  // pre-authorized, returning every bound corpus's document titles to a caller who
  // could not read them. The one non-HTTP caller, `demoAgentDepthSeed`, spells the
  // bypass by name.
  const profile = await getAgentProfile(tenantId, agentId);
  const knowledgeEnabled = Boolean(profile && (profile.capabilities ?? []).includes('knowledge'));
  const collectionIds = profile?.knowledge?.collectionIds ?? [];

  // The binding is a flat collectionId[] (the ADR data model); KB keys are
  // tenant+org+collection, so each id is resolved back to its org via KB (no
  // second store). Resolve the whole tenant's collections ONCE (not per id — a
  // per-binding full scan), then index by id. A deleted collection self-heals out.
  //
  // ADR 0643 R3 review (Blocker 2) — EXISTENCE and VISIBILITY are two questions here.
  // This listing answers EXISTENCE and feeds the prune below, so it is PREAUTHORIZED: a
  // caller-filtered listing would make a non-member's GET durably UNBIND every corpus
  // it cannot see. VISIBILITY is re-resolved per collection with the READER's principal
  // (`caller`, the HTTP route's `callerSubject`): a bound corpus the reader may not read
  // stays bound and is simply not projected — no titles, no counts.
  const listing = await listAllTenantCollections(tenantId, PREAUTHORIZED_CALLER); // KBC-1 — existence only (prune)
  const byId = new Map(listing.map((c) => [c.collectionId, c]));
  const collections: AgentKnowledgeView['collections'] = [];
  const liveIds: string[] = [];
  for (const collectionId of collectionIds) {
    const col = byId.get(collectionId);
    if (!col) continue; // a deleted collection self-heals out of the view
    liveIds.push(collectionId);
    if (!(await getCollection(tenantId, col.orgId, collectionId, caller))) continue; // R3 Blocker 2 — bound, but not this reader's to see
    const documents = await listDocuments(tenantId, col.orgId, collectionId, caller); // KBC-1 — the reader's principal
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
  //
  // GUARDED (`ADR 0603 R1 H1`, porting `TWIN-UX-10`). This is a DURABLE WRITE ON A
  // GET, resting on the inference "not in the listing ⇒ deleted" — and
  // `listAllTenantCollections` reads a secondary index that can answer SHORT, or
  // EMPTY, without throwing. One corrupt index row would have overwritten the
  // whole binding with `[]` and returned 200 with an empty knowledge panel. The
  // shared rule refuses in exactly the cases where the listing cannot prove a
  // deletion; see `host/knowledgeBindingPrune.ts` for why the cure is here and not
  // at the write layer.
  if (profile && mayPruneKnowledgeBinding({ boundIds: collectionIds, listingSize: listing.length, liveIds })) {
    // ADR 0664 D4 — the dangling-binding self-heal is a durable write on a GET. It must NOT
  // re-grant: before this, merely opening the knowledge panel restored a revoked capability.
  await setAgentKnowledge(tenantId, agentId, { collectionIds: liveIds }, await profileInitFor(tenantId, agentId), { activateCapability: false });
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
async function findBoundCollection(tenantId: string, collectionId: string, caller: SubjectCaller): Promise<BoundCollection | null> {
  // getCollection needs an orgId; the binding stores only the id (the ADR data
  // model). Recover the org via KB's tenant-wide list (single source of truth).
  const all = await listAllTenantCollections(tenantId, caller); // KBC-1 — the DOOR's principal (see `bindCollection`)
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
  input: { title?: unknown; text?: unknown; contentTrust?: 'trusted' | 'untrusted'; origin?: HostEventOrigin },
): Promise<Awaited<ReturnType<typeof ingestDocument>>> {
  const found = await findBoundCollection(tenantId, collectionId, PREAUTHORIZED_CALLER); // the USE lane — a binding exists (checked next), resolved at its door
  if (!found) throw new OpenwopError('not_found', 'Bound collection not found.', 404, { collectionId });
  const profile = await getAgentProfile(tenantId, agentId);
  await mustOwnedCollectionBound(tenantId, profile, found.orgId, collectionId);
  // H65 — `contentTrust` is a PRIVILEGED document field (#3333 / KB-1 R2), so it
  // must travel in `ingestDocument`'s `internal` argument, never inside the
  // caller-supplied content object. This function is an IN-PROCESS boundary: the
  // agent surface above it decides the trust label (defaulting to `untrusted`,
  // ADR 0038 §C) and we forward that decision through the privileged channel.
  // Passing it in `input` — which is what this line did between #3333 and H65 —
  // hits `assertNoPrivilegedFields` and throws `contentTrust is not
  // caller-settable`, which broke EVERY ingest through the agent surface, the
  // trusted ones too, because `surface.ts` always sets the field.
  const { contentTrust, origin, ...content } = input;
  return ingestDocument(
    tenantId,
    found.orgId,
    actor,
    collectionId,
    content,
    // `origin` (ADR 0617 D1a / ADR 0643 D3) rides the same privileged channel: the
    // run's `document.ingested` must not re-trigger a binding on its own workflow.
    { ...(contentTrust === undefined ? {} : { contentTrust }), ...(origin ? { origin } : {}) },
    PREAUTHORIZED_CALLER, // KBC-1
  );
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
  // A collection minted THIS instant carries no `boundSubject` (only the project /
  // notebook doors stamp one), and the route already checked org write — so there
  // is no membership to resolve; `PREAUTHORIZED_CALLER` is honest here.
  await bindCollection(tenantId, agentId, col.collectionId, PREAUTHORIZED_CALLER);
  return { collectionId: col.collectionId, orgId, name: col.name, documentCount: col.documentCount, chunkCount: col.chunkCount };
}

/**
 * Bind an EXISTING KB collection (owned by the caller's tenant) to the agent.
 * Idempotent; activates the `knowledge` capability.
 *
 * EVERY WRITER OF `profile.knowledge.collectionIds` (ADR 0643 R4 Blocker 1 — the
 * grant is the FIELD, so the class is its writers, not this function's callers):
 *   - this file: `bindCollection` (gated, capped), `unbindCollection`, the
 *     `getAgentKnowledge` prune (existence-only), `setMemoryWritable` (a merge that
 *     preserves the array);
 *   - `routes/agentProfile.ts` PUT — REFUSES the field (400) since R4; it was the
 *     ungated seventh door;
 *   - `kicktodo-core/kickbotService.ts` — unions ITS OWN managed collection id
 *     (`ensureKickbotKnowledge`, never subject-bound) into the agent's set;
 *   - `host/demoAgentDepthSeed.ts` — via `createBoundCollection` (a freshly minted,
 *     unbound org collection; `PREAUTHORIZED_CALLER` by name);
 *   - `host/exampleDataSeed.ts` / `host/advisoryBoardSeed.ts` / the portability
 *     import — write `knowledge` WITHOUT `collectionIds` (`upsertAgentProfile` now
 *     preserves the curator's array on such a write).
 *
 * ADR 0643 R3 review (Blocker 2) — `caller` is the principal AT THE DOOR, never
 * `PREAUTHORIZED_CALLER`. This is the lane that turns a user-supplied `collectionId`
 * into a durable grant: every later read of the binding (the composition's retriever
 * on chat/run turns, the surface's `ingestDocument`) is PRE-AUTHORIZED because the
 * binding exists — so a non-member who could bind a project-bound corpus here
 * laundered it: `getCollection` refused them, the bind did not ask, and the agent
 * then served the private titles and chunk text to anyone. The HTTP door passes
 * `callerSubject(req)`; the advisory-board reconciler passes `PREAUTHORIZED_CALLER`
 * because it binds only share-kind PROVIDER collections (managed org KBs, never
 * subject-bound) whose share it resolved at its own door.
 *
 * WHAT IS NOT DONE, stated: a binding OUTLIVES the binder's membership. The chat/run
 * use lane keeps `PREAUTHORIZED_CALLER` (a binding is an owner-scoped grant; the
 * speaker is not the binder), so a member who binds a private project corpus and
 * later leaves the project leaves the agent able to read it. The two HTTP reads
 * (`getAgentKnowledge`, `retrieveForAgent`) re-resolve with the READER, which
 * bounds what a human can pull out; reconciling agent bindings on project-membership
 * removal needs a membership-change seam the host does not expose today and is
 * filed against the ADR rather than half-built here.
 */
export async function bindCollection(tenantId: string, agentId: string, collectionId: string, caller: SubjectCaller): Promise<void> {
  const found = await findBoundCollection(tenantId, collectionId, caller);
  if (!found) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  const profile = await getAgentProfile(tenantId, agentId);
  const current = profile?.knowledge?.collectionIds ?? [];
  if (current.includes(collectionId)) return;
  if (current.length >= BINDING_CAP) {
    throw new OpenwopError('validation_error', `This agent already has the maximum ${BINDING_CAP} bound collections. Unbind one first.`, 400, { cap: BINDING_CAP });
  }
  // A bind IS the grant.
  await setAgentKnowledge(tenantId, agentId, { collectionIds: [...current, collectionId] }, await profileInitFor(tenantId, agentId), { activateCapability: true });
}

/** Unbind a collection from the agent (does NOT delete the KB collection — it
 *  may be shared by other twins). */
export async function unbindCollection(tenantId: string, agentId: string, collectionId: string): Promise<void> {
  const profile = await getAgentProfile(tenantId, agentId);
  const current = profile?.knowledge?.collectionIds ?? [];
  if (!current.includes(collectionId)) {
    throw new OpenwopError('not_found', 'Collection is not bound to this agent.', 404, { collectionId });
  }
  // An unbind is the opposite of a grant.
  await setAgentKnowledge(tenantId, agentId, { collectionIds: current.filter((id) => id !== collectionId) }, await profileInitFor(tenantId, agentId), { activateCapability: false });
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
  return ingestDocument(tenantId, orgId, actor, collectionId, input, {}, PREAUTHORIZED_CALLER); // KBC-1
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
  return ingestDocument(tenantId, orgId, actor, collectionId, { title: fetched.title, text: fetched.text }, { contentTrust: 'untrusted' }, PREAUTHORIZED_CALLER); // KBC-1
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
  await deleteDocument(tenantId, orgId, collectionId, documentId, PREAUTHORIZED_CALLER); // KBC-1
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

/** MEM-UX-1 — rows the agent RECALLS that this list does not show (turn
 *  summaries). Surfaced so the browser can disclose the gap instead of implying
 *  the curated list is everything the agent remembers. */
export function countAgentRecallOnly(tenantId: string, agentId: string): Promise<number> {
  return countRecallOnlyEntries(tenantId, agentSubject(agentId));
}

/** Remove a curated note by id. Only a curated note is removable (a dispatch
 *  turn-summary in the same namespace is not). Resolves false when none matched. */
export async function removeAgentNote(tenantId: string, agentId: string, noteId: string): Promise<boolean> {
  // ADR 0666 D2 follow-up — `removeSubjectNote` now reports whether the recall index was also
  // cleared. This lane keeps its boolean contract deliberately: surfacing the partial state is
  // a per-surface UX decision, and the agent Memory tab is a different feature's surface. The
  // failure is logged with its scope by the seam, so it is not lost — filed as `PKWF-15`.
  return (await removeSubjectNote(tenantId, agentSubject(agentId), noteId)).removed;
}

/** Set the `memoryWritable` knob on the binding (opt the agent in/out of curated
 *  notes). Activates the `knowledge` capability. */
export async function setMemoryWritable(tenantId: string, agentId: string, writable: boolean): Promise<void> {
  // ADR 0664 D4 — a PRIVACY action must never re-grant the capability it is narrowing.
  await setAgentKnowledge(tenantId, agentId, { memoryWritable: writable }, await profileInitFor(tenantId, agentId), { activateCapability: false });
}

/** Read-only retrieval over the agent's bound knowledge (the `ctx.features
 *  .agentKnowledge.retrieve` surface, ADR 0038 §3 / ADR 0014). Returns cited KB
 *  chunks + private memory facts for `query`. Tenant-scoped; never writes.
 *
 *  KB-UX-3 / ADR 0583 — `failedSources` is what makes this preview honest. The
 *  composition swallows a per-source fault so a live agent turn survives it, so
 *  a KB backend error and an empty corpus both arrived here as
 *  `{chunks:[], hasResults:false}` at HTTP 200 and the panel said "No matches".
 *  A failed read is not an empty one; it now says which source could not be
 *  searched. The SPA could not fix this — the lie was manufactured here.
 *
 *  WF-AKM-3 (ADR 0587 §4) — the SAME rule, one level UP, where it was still
 *  broken. `resolveAgentKnowledgeRetrieve` returns `undefined` for three distinct
 *  states and this returned the identical `{chunks:[], hasResults:false,
 *  failedSources:[]}` for all three, so a NON-EXISTENT agent and a
 *  `knowledge`-capability-off agent were both reported as an empty corpus, at
 *  `status:'success'`, to a caller that is often a MODEL. Only "nothing bound" is
 *  an empty corpus: a missing/unknown subject is a TYPED FAILURE and
 *  capability-off is a NAMED REASON. `unavailable` carries the distinction
 *  without changing the shape for the happy path (absent on success). */
export async function retrieveForAgent(
  tenantId: string,
  agentId: string,
  query: string,
  /** ADR 0643 R3 (Blocker 2) — the HTTP read re-resolves with the READER; a run/chat
   *  lane omits it and reads the binding as the owner-scoped grant it is. */
  caller?: SubjectCaller,
): Promise<{
  chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust: 'trusted' | 'untrusted' }>;
  hasResults: boolean;
  failedSources: KnowledgeSourceKind[];
  /** Present ONLY when no retriever could be resolved — see the docblock. */
  unavailable?: AgentKnowledgeUnavailable;
}> {
  const memory = createAgentMemoryPort(tenantId);
  // ADR 0442 P3 — a read surface with no acting participant; a default-scope
  // agent reads `agent:<id>` as before (the scope is derived from the profile),
  // a `per-user` agent fails closed (empty recall, never the shared scope).
  const retrieve = await resolveAgentKnowledgeRetrieve(tenantId, agentId, memory, undefined, caller);
  if (!retrieve) {
    const unavailable = await diagnoseAgentKnowledgeRetrieve(tenantId, agentId);
    // A missing/unknown subject is a FAULT, not an empty corpus — the same shape
    // just fixed in the consent node, where a gate answered `allowed:true` for a
    // subject it never received. Thrown so no caller can render it as "empty".
    if (unavailable === 'agent-missing') {
      throw new OpenwopError('not_found', 'Agent not found.', 404, { agentId });
    }
    return { chunks: [], hasResults: false, failedSources: [], unavailable };
  }
  const failedSources: KnowledgeSourceKind[] = [];
  const out = await retrieve(query, (s) => { if (!failedSources.includes(s)) failedSources.push(s); });
  return {
    chunks: out.map((c) => ({
      content: c.content,
      ...(c.title ? { title: c.title } : {}),
      kind: c.kind,
      contentTrust: c.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
    })),
    hasResults: out.length > 0,
    failedSources,
  };
}
