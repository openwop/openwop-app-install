/**
 * Knowledge-lifecycle seam (ADR 0351 Phase 3) — the hook by which FEATURE-owned
 * consumers react when a KB document's CONTENT changes (a stable-id re-ingest
 * that produced a new revision), without `kb` importing features. Identical
 * contract to the canvas/conversation lifecycle seams: KEYED registration
 * (repeat boots overwrite), idempotent bounded handlers, best-effort fan-out
 * that never throws, fired AFTER the new revision is durably ingested.
 *
 * The campaign-brief feature registers here to flag kernels whose
 * `sourceDocIds` include the changed document (`kernelStale`) — the
 * KB-change → downstream-content staleness propagation CS-001 intended.
 *
 * @see host/canvasLifecycle.ts (the sibling this mirrors)
 * @see docs/adr/0351-kb-retrieval-fidelity-and-strict-grounding.md
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.knowledgeLifecycle');

export interface KnowledgeDocumentChangedEvent {
  tenantId: string;
  orgId: string;
  collectionId: string;
  documentId: string;
  title: string;
  /** On a content change: the NEW revision number (≥2 — first ingest is
   *  revision 1 and does not fire). On a delete: the LAST revision. */
  revision: number;
  /** Set when the document was DELETED (CS-DATA-1) — content citing it is just
   *  as stale as content citing a changed revision. Absent ⇒ content change. */
  deleted?: boolean;
}

type Handler = (e: KnowledgeDocumentChangedEvent) => Promise<void>;

const handlers = new Map<string, Handler>();

/** A consumer feature registers (idempotently, keyed) its reaction at boot. */
export function onKnowledgeDocumentChanged(key: string, fn: Handler): void {
  handlers.set(key, fn);
}

/** Called by kb AFTER a revision bump (or a delete); runs every registrant
 *  best-effort. Never throws (a consumer's failure must not fail the ingest) —
 *  but a swallowed failure is still LOGGED with its consumer key (KB-CODE-8). */
export async function fireKnowledgeDocumentChanged(e: KnowledgeDocumentChangedEvent): Promise<number> {
  let ran = 0;
  for (const [key, h] of handlers) {
    try {
      await h(e);
      ran += 1;
    } catch (err) {
      log.warn('knowledge_lifecycle_consumer_failed', { consumer: key, tenantId: e.tenantId, documentId: e.documentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetKnowledgeLifecycleHooks(): void {
  handlers.clear();
}
