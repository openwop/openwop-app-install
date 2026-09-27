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
 * TRUST (ADR 0587 / AGMEM-2): the transcript this reads includes AGENT turns,
 * which echo tool results, MCP content and fetched web text — so every fact it
 * produces is model-authored and is written `source:'auto-extract'`, which
 * `addSubjectNote` derives `contentTrust:'untrusted'` from and tags
 * `MEMORY_UNTRUSTED_TAG` on the recall row. That keeps it inside the untrusted
 * fence when composition folds recall into a tool-enabled system prompt. Before
 * ADR 0587 this path wrote `'trusted'` and marked provenance only with an English
 * `[auto-extracted] ` prefix glued into the content.
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 * @see docs/adr/0587-memory-trust-provenance-and-erasure.md
 */
import { isExtractionGranted } from './grantService.js';
import { runMemoryExtraction, type ExtractionResult } from './extractionOp.js';
import { addSubjectNote } from '../../host/subjectMemory.js';
import { personSubject } from '../../host/subject.js';

/** Run consent-gated extraction for a chat user. `extract` is the LLM summarizer
 *  (injected). Notes land on the user's `user:<id>` subject with
 *  `source:'auto-extract'` ⇒ `contentTrust:'untrusted'` + `MEMORY_UNTRUSTED_TAG`,
 *  which is what the review UI's provenance chip and the dispatch fence both read. */
export async function extractConversationMemory(
  tenantId: string,
  userId: string,
  conversationText: string,
  extract: (text: string) => Promise<string[]>,
): Promise<ExtractionResult> {
  // ADR 0666 D1 — the grant subject is the caller's subject VERBATIM, not `user:` + it.
  //
  // This line used to read `` `user:${userId}` ``, and that one added prefix meant the lane
  // never wrote in production. `userId` here is `run.metadata.actingUserId`, stamped from
  // `req.userId ?? principal.principalId` (`routes/runs.ts:495`) — the IDENTICAL expression
  // `callerSubject` uses when the consent route files the grant (`routes.ts:40`,
  // `host/requestSubject.ts:17-19`). And `User.userId` is ITSELF `user:<sha256>`
  // (`features/users/usersService.ts:216-218`), so the prefix was always doubled: the grant sat
  // at `${tenant}:user:<hash>` while the check asked for `${tenant}:user:user:<hash>`.
  // `getExtractionGrant` is an exact point-get with no key-form normalisation
  // (`grantService.ts:34-35`), so it could never recover. Fail-closed, so nothing leaked — the
  // cost was an inert feature and a consent control that did nothing.
  //
  // The WRITE side is canonical, and the reason is not symmetry: real grant rows exist (the UI
  // control ships — `frontend/react/src/features/profile-memory/ProfileMemoryTab.tsx`), so
  // fixing the read makes the grants people already gave effective, where "fixing" the write
  // would strand them behind a migration.
  //
  // NOT form-tolerant on purpose. The eraser in this same file matches the `subjectKeyForms`
  // over-set (`grantService.ts:77-85`) because over-erasing is the safe direction; this read
  // stays EXACT so a future caller that hand-builds a subject fails loudly here instead of
  // silently working on one path and not the other. (ADR 0666 D1 records why the first draft's
  // "over-sets are unsafe on authorizing reads" rule was withdrawn — this repo has a
  // counterexample at `host/emailApprovalDelivery.ts:155-156`.)
  const subjectRef = userId;
  return runMemoryExtraction(tenantId, subjectRef, conversationText, {
    isGranted: (t, s) => isExtractionGranted(t, s),
    extract,
    // DELIBERATELY UNCHANGED (ADR 0666 D1). `personSubject(userId)` yields scope
    // `user:user:<hash>`, which is IDENTICAL to how the person's own route writes —
    // `selfSubject(user.userId)` with `{kind:'user', id: user.userId}`
    // (`features/profile-memory/routes.ts:33,52`). The two stores differ legitimately: the
    // grant store is keyed by a SUBJECT string (already prefixed), the memory store by a SCOPE
    // that `kind` prefixes. A "consistent" prefix fix in both places would break this half,
    // which is correct today — verified against the note readers before changing the other line.
    addNote: (t, _s, fact) => addSubjectNote(t, personSubject(userId), fact, { source: 'auto-extract' }),
  });
}
