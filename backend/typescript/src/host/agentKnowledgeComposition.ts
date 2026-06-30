/**
 * Per-agent knowledge composition into dispatch (ADR 0038 Phase 3) — host route
 * layer.
 *
 * Builds the `AgentKnowledgeRetrieve` that the live dispatch turn injects, from
 * three HOST-OWNED primitives:
 *   - `agentProfile.knowledge` (the binding — ADR 0031/0038, host store)
 *   - the `KnowledgeBackend` seam (cited KB docs — ADR 0011/0014, installed by
 *     the `kb` feature at boot; read via `getKnowledgeBackend()`, NOT imported)
 *   - the `AgentMemoryPort` (the agent's private RFC-0004 memory namespace)
 *
 * Because every input is host-owned, the composition lives here in the host —
 * NOT in the `agent-knowledge` feature — so core dispatch needs no core→feature
 * import (ADR 0038 § "Seam map"). Returns `undefined` when the agent has no
 * `knowledge` capability or no binding ⇒ dispatch behaves exactly as today.
 *
 * @see docs/adr/0038-per-agent-knowledge-memory.md §"Seam map" / Phase 3
 */

import type { AgentKnowledgeRetrieve, AgentMemoryPort } from './agentDispatch.js';
import { getAgentProfile } from './agentProfileService.js';
import { contextEconomy } from './contextEconomy.js';
import { budgetByChars, memoryBudgetConfig } from './memoryBudget.js';
import { getKnowledgeBackend } from './knowledgeSurface.js';
import { neutralizeUntrusted, fenceUntrustedItems } from './untrustedContent.js';
import { getSubjectKnowledge } from './subjectKnowledge.js';
import { createSubjectMemoryPort, subjectMemoryScope } from './subjectMemory.js';
import type { Subject } from './subject.js';

/**
 * Compose a per-agent knowledge CONTEXT block for a CHAT turn (ADR 0043 Phase
 * 5B). Retrieves against the latest user text, then mirrors the live-dispatch
 * trust fencing (ADR 0038 §C): trusted KB/memory chunks become a cited block the
 * agent may quote; untrusted (auto-ingested — Drive import / trigger ingest)
 * chunks are whitespace-neutralized and wrapped in a BEGIN/END UNTRUSTED CONTENT
 * fence so they're data-only, never instructions (RFC 0021 anti-laundering).
 *
 * Returns '' when nothing is bound/retrieved (the caller injects nothing, so the
 * turn behaves exactly as before). Best-effort: a retriever error yields ''.
 * The block is appended to the agent's system prompt by the chat responder.
 */
export async function composeAgentKnowledgeContext(
  retrieve: AgentKnowledgeRetrieve,
  query: string,
): Promise<string> {
  let chunks: Awaited<ReturnType<AgentKnowledgeRetrieve>> = [];
  try {
    chunks = await retrieve(query);
  } catch {
    return '';
  }
  if (chunks.length === 0) return '';
  const trusted = chunks.filter((c) => c.contentTrust !== 'untrusted');
  const untrusted = chunks.filter((c) => c.contentTrust === 'untrusted');
  const sections: string[] = [];
  if (trusted.length > 0) {
    sections.push(
      'Relevant knowledge for this agent (cite the bracketed source):\n' +
        trusted.map((c) => (c.title ? `- [${c.title}] ${c.content}` : `- ${c.content}`)).join('\n'),
    );
  }
  if (untrusted.length > 0) {
    sections.push(
      fenceUntrustedItems(
        untrusted.map((c) => (c.title ? `- [${neutralizeUntrusted(c.title)}] ${neutralizeUntrusted(c.content)}` : `- ${neutralizeUntrusted(c.content)}`)),
      ),
    );
  }
  return sections.join('\n\n');
}

/** Default top-K bound knowledge chunks injected per turn (when the binding does
 *  not set its own `retrieval.topK`). */
const DEFAULT_KNOWLEDGE_TOP_K = 6;

/** A subject's knowledge binding — bound KB collections + retrieval tuning.
 *  Shared by agents (`agentProfile.knowledge`) and humans (`Profile.knowledge`,
 *  ADR 0042). A reference only: `collectionIds` point into `kbService`. */
export interface SubjectKnowledgeBinding {
  collectionIds?: string[];
  retrieval?: {
    topK?: number;
    sources?: ('kb' | 'memory')[];
    /** GENERIC document-level exclusion (ADR 0084 Context Levels): KB chunks whose
     *  document (`chunk.assetId`, which kbService sets `= documentId`) is in this set
     *  are dropped from retrieval BEFORE composition. No notebook concept here — it is
     *  simply "this subject's binding excludes these documents." Opt-in: a binding that
     *  never sets it is unaffected (the filter is a no-op for the empty/absent set). */
    excludeDocumentIds?: string[];
    /** GENERIC extra context items (ADR 0084 Transformations T1): inject these
     *  caller-supplied items as additional chunk-like entries APPENDED after the
     *  KB-chunk retrieval, flowing through the SAME `composeAgentKnowledgeContext`
     *  fence path. The seam knows nothing of where they come from — notebooks use
     *  it to inject a stored per-source SUMMARY in place of a source's excluded raw
     *  chunks, but it is simply "this subject's binding always contributes these
     *  items." `contentTrust:'untrusted'` keeps the item fenced (a summary derived
     *  from untrusted material stays data-only). Opt-in: absent ⇒ no-op. */
    extraContext?: Array<{ title?: string; content: string; contentTrust?: 'trusted' | 'untrusted' }>;
  };
}

/**
 * Resolve the per-AGENT knowledge retriever (ADR 0038) — the agent wrapper over
 * the subject-agnostic core. Loads the agent's host profile, gates on the
 * `knowledge` capability (fail-closed: an absent profile is no binding), then
 * delegates to `resolveSubjectKnowledgeRetrieve`. Behavior is unchanged from
 * before ADR 0042 — every existing caller keeps the same contract.
 */
export async function resolveAgentKnowledgeRetrieve(
  tenantId: string,
  agentId: string,
  memory: AgentMemoryPort,
  memoryScope: string,
): Promise<AgentKnowledgeRetrieve | undefined> {
  const profile = await getAgentProfile(tenantId, agentId);
  if (!profile || !(profile.capabilities ?? []).includes('knowledge')) return undefined;
  return resolveSubjectKnowledgeRetrieve(tenantId, profile.knowledge, memory, memoryScope);
}

/**
 * Resolve a knowledge retriever from a binding (ADR 0042) — the single,
 * subject-agnostic owner of "compose bound KB docs + a memory namespace into a
 * read-only retriever," used by agents (via the wrapper above) and humans alike.
 * Returns `undefined` when nothing is bound (the caller injects nothing).
 *
 * Tenant isolation (CTI-1): `tenantId` is threaded into every read — the KB
 * backend buckets by tenant, the memory port is tenant-bound at construction.
 * READ-ONLY (RFC 0004 / ADR 0038 §9): never writes memory or KB.
 */
export function resolveSubjectKnowledgeRetrieve(
  tenantId: string,
  binding: SubjectKnowledgeBinding | undefined,
  memory: AgentMemoryPort,
  memoryScope: string,
): AgentKnowledgeRetrieve | undefined {
  const collectionIds = binding?.collectionIds ?? [];
  const sources = binding?.retrieval?.sources ?? ['kb', 'memory'];
  const wantKb = sources.includes('kb') && collectionIds.length > 0;
  const wantMemory = sources.includes('memory');
  if (!wantKb && !wantMemory) return undefined;

  const topK =
    typeof binding?.retrieval?.topK === 'number' && binding.retrieval.topK > 0
      ? Math.floor(binding.retrieval.topK)
      : DEFAULT_KNOWLEDGE_TOP_K;
  // GENERIC document exclusion (ADR 0084): a binding may exclude specific documents
  // from retrieval (used by notebooks to honor a per-source 'excluded' context level,
  // but the seam itself knows nothing of notebooks). Empty/absent ⇒ no filtering.
  const excludedDocumentIds = new Set(binding?.retrieval?.excludeDocumentIds ?? []);
  // GENERIC extra context items (ADR 0084 Transformations T1): items the binding
  // always contributes (e.g. a notebook's stored per-source summary). Captured at
  // resolve time so the returned retriever appends them on every query.
  const extraContext = binding?.retrieval?.extraContext ?? [];
  const backend = getKnowledgeBackend();

  return async (query: string) => {
    const out: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust: 'trusted' | 'untrusted' }> = [];

    // KB collections — cited docs (ADR 0011). Each chunk carries its document's
    // content-trust (ADR 0038 §C) so dispatch fences untrusted (provider/trigger-
    // derived) content. Best-effort: a backend miss / error contributes nothing.
    if (wantKb && backend) {
      try {
        const res = await backend.retrieve(tenantId, { query, collectionIds, resultLimit: topK });
        if (res) {
          for (const chunk of res.chunks) {
            // ADR 0084: drop chunks whose document is excluded by the binding
            // (kbService sets chunk.assetId = documentId — verified in kbService.ts).
            if (excludedDocumentIds.has(chunk.assetId)) continue;
            out.push({
              content: chunk.content,
              title: chunk.documentTitle,
              kind: 'kb',
              contentTrust: chunk.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
            });
          }
        }
      } catch {
        /* best-effort */
      }
    }

    // Private per-agent memory facts (RFC 0004). Recalled by relevance; no title
    // (these are notes, not cited documents). Memory is the tenant's own curated
    // notes / prior-run summaries → trusted, EXCEPT a summary derived from
    // untrusted knowledge (ADR 0038 §C), which the port surfaces as
    // contentTrust:'untrusted' so it stays fenced here too.
    if (wantMemory) {
      try {
        const entries = await memory.read(memoryScope, query);
        for (const e of entries.slice(0, topK)) {
          out.push({ content: e.content, kind: 'memory', contentTrust: e.contentTrust === 'untrusted' ? 'untrusted' : 'trusted' });
        }
      } catch {
        /* best-effort */
      }
    }

    // ADR 0148 A4 — memory injection budget (gated; off ⇒ unchanged). Cap the
    // total size of the relevance-RETRIEVED items (KB + memory) — `topK` bounds
    // the count, this bounds the chars. `extraContext` below is EXEMPT (caller-
    // curated, already summary-sized). Trust/fence treatment is per-item and
    // unaffected by dropping lower-priority items.
    const composed = contextEconomy().memoryBudget
      ? budgetByChars(out, memoryBudgetConfig().maxChars, (i) => i.content.length)
      : out;

    // GENERIC extra context (ADR 0084 T1): append the binding's caller-supplied
    // items as chunk-like entries so they flow through the SAME composition + fence
    // path as KB chunks. An item marked untrusted stays fenced (a summary derived
    // from untrusted material is data-only, never agent-trusted). Query-independent:
    // these are always-on context, not retrieved by relevance.
    for (const item of extraContext) {
      if (typeof item?.content !== 'string' || item.content.length === 0) continue;
      composed.push({
        content: item.content,
        ...(item.title ? { title: item.title } : {}),
        kind: 'kb',
        contentTrust: item.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
      });
    }

    return composed;
  };
}

/**
 * Compose a FENCED knowledge CONTEXT block for an arbitrary owner `Subject` (ADR
 * 0084 Phase 2) — the single composition path the conversation flow uses to ground
 * a chat in its owner-subject's bound knowledge (a notebook/project's KB sources).
 *
 * Self-gating: a subject with no bound collections returns '' (so subjects without
 * bound knowledge are wholly unaffected). The block wraps the SAME
 * `composeAgentKnowledgeContext` primitive the live agent dispatch uses, so the
 * trusted-cite / untrusted-fence treatment can never drift between the two flows
 * (untrusted notebook chunks stay fenced — never agent-trusted). Returns '' on any
 * retrieval failure (the caller injects nothing, so the turn behaves as before).
 *
 * READ-ONLY (RFC 0004 / ADR 0038 §9): never writes memory or KB.
 *
 * AUTHORIZATION is the CALLER's responsibility — this helper does NOT gate access.
 * `conversationExchange` resolves the exchanging caller's `resolveSubjectAccess`
 * BEFORE calling this, so a non-member never reaches it.
 */
export async function composeKnowledgeForSubject(
  tenantId: string,
  subject: Subject,
  query: string,
  opts?: { topK?: number },
): Promise<string> {
  const binding = await getSubjectKnowledge(tenantId, subject);
  if (!binding.collectionIds || binding.collectionIds.length === 0) return '';
  const topK = typeof opts?.topK === 'number' && opts.topK > 0 ? Math.floor(opts.topK) : undefined;
  const effectiveBinding: SubjectKnowledgeBinding = {
    collectionIds: binding.collectionIds,
    ...(binding.retrieval || topK !== undefined
      ? { retrieval: { ...binding.retrieval, ...(topK !== undefined ? { topK } : {}) } }
      : {}),
  };
  const memory = createSubjectMemoryPort(tenantId);
  const retrieve = resolveSubjectKnowledgeRetrieve(tenantId, effectiveBinding, memory, subjectMemoryScope(subject));
  if (!retrieve) return '';
  return composeAgentKnowledgeContext(retrieve, query);
}
