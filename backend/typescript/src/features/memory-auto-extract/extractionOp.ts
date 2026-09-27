/**
 * ADR 0120 Phase 2 — the consent-gated memory extraction op.
 *
 * FAIL-CLOSED: nothing is written without an explicit grant (Phase 1). Given a
 * grant, the op extracts durable facts (an injected LLM `extract`) and writes each
 * as a subject note. Deps are injected so the consent gate + the extraction flow
 * are unit-testable without the dispatch/memory coupling; the post-turn wiring is
 * Phase 2b.
 *
 * This op does NOT decide trust — it has no view of the store. The BINDING
 * (`extractionBinding.ts`) passes `source:'auto-extract'`, from which
 * `addSubjectNote` derives `contentTrust:'untrusted'` (ADR 0587 / AGMEM-2).
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 * @see docs/adr/0587-memory-trust-provenance-and-erasure.md
 */
export interface ExtractionDeps {
  isGranted: (tenantId: string, subject: string) => Promise<boolean>;
  /** LLM extraction: conversation text → durable fact strings (bounded by caps). */
  extract: (conversationText: string) => Promise<string[]>;
  /** Persist one extracted fact. The binding is responsible for stamping
   *  `source:'auto-extract'` (⇒ untrusted) — this op passes the fact verbatim. */
  addNote: (tenantId: string, subject: string, fact: string) => Promise<void>;
}

const MAX_FACTS = 10;

export interface ExtractionResult { extracted: number; skipped: 'no-consent' | 'empty' | null }

export async function runMemoryExtraction(
  tenantId: string,
  subject: string,
  conversationText: string,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  // FAIL-CLOSED consent gate — no grant ⇒ no extraction, no write.
  if (!(await deps.isGranted(tenantId, subject))) return { extracted: 0, skipped: 'no-consent' };
  if (!conversationText.trim()) return { extracted: 0, skipped: 'empty' };

  const facts = (await deps.extract(conversationText)).map((f) => f.trim()).filter((f) => f.length > 0).slice(0, MAX_FACTS);
  for (const fact of facts) await deps.addNote(tenantId, subject, fact);
  return { extracted: facts.length, skipped: null };
}
