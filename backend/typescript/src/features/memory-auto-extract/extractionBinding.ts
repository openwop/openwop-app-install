/**
 * ADR 0120 Phase 2b — bind the Phase-2 extraction op to the REAL host services.
 *
 * Supplies `runMemoryExtraction` with the real fail-closed consent gate
 * (`isExtractionGranted`) + the real note store (`addSubjectNote`, written to the
 * chat user's `user:<id>` subject). The LLM extractor is INJECTED — the call site
 * (Phase 2c) provides a dispatch-backed one; tests inject a stub. So the
 * security-relevant wiring (consent + where notes land) is covered here without the
 * dispatch coupling.
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import { isExtractionGranted } from './grantService.js';
import { runMemoryExtraction, type ExtractionResult } from './extractionOp.js';
import { addSubjectNote } from '../../host/subjectMemory.js';
import { personSubject } from '../../host/subject.js';

/** Run consent-gated extraction for a chat user. `extract` is the LLM summarizer
 *  (injected). Notes land on the user's `user:<id>` subject, stamped (the op caps +
 *  the store treats them as the subject's own curated notes — provenance is the
 *  `auto-extracted` convention the review UI surfaces). */
export async function extractConversationMemory(
  tenantId: string,
  userId: string,
  conversationText: string,
  extract: (text: string) => Promise<string[]>,
): Promise<ExtractionResult> {
  const subjectRef = `user:${userId}`;
  return runMemoryExtraction(tenantId, subjectRef, conversationText, {
    isGranted: (t, s) => isExtractionGranted(t, s),
    extract,
    addNote: (t, _s, fact) => addSubjectNote(t, personSubject(userId), `[auto-extracted] ${fact}`),
  });
}
