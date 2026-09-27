/**
 * The memory-entry trust marker, in a LEAF module.
 *
 * Extracted from `agentDispatch.ts` (which re-exports it, so every pre-existing
 * importer is byte-identical — the no-fork guarantee) so that
 * `inMemorySurfaces.ts` can read it for AGMEM-3 compaction trust carry-forward
 * without an `inMemorySurfaces → agentDispatch → inMemorySurfaces` import cycle.
 *
 * The value is load-bearing across three layers — the recall recency projection,
 * the RAG metadata projection, and the dispatch fence split — so it has exactly
 * ONE definition, here.
 *
 * @see docs/adr/0587-memory-trust-provenance-and-erasure.md
 */

/** Memory-entry tag marking content DERIVED FROM UNTRUSTED knowledge (ADR 0038
 *  §C): recall FENCES tagged entries, never re-injecting them as agent-trusted. */
export const MEMORY_UNTRUSTED_TAG = 'derived-from-untrusted';

/**
 * LEGACY-ONLY discriminator for the AGMEM-2 backlog. Lives HERE, beside the tag,
 * because it is the tag's other half: a pre-0587 auto-extracted row carries no
 * tag at all, so any code that asks "is this untrusted?" by reading the tag alone
 * is asking half the question.
 *
 * Before AGMEM-2 was fixed, `features/memory-auto-extract/extractionBinding.ts`
 * wrote LLM-inferred facts through `addSubjectNote` with `contentTrust:'trusted'`
 * hardcoded and marked them ONLY by gluing this English prefix into the stored
 * content. Those rows carry no tag, no field and no metadata that says what they
 * are — **this string is the only signal they will ever have**, so every read
 * path honours it as `'untrusted'`.
 *
 * This is a HEURISTIC and is NOT a backfill. It is fail-CLOSED in the only
 * direction that matters (it can over-fence a note a user literally typed with
 * this prefix; it can never GRANT trust a row did not have), but it cannot be
 * complete — see the honesty note in ADR 0587 § "The AGMEM-2 backlog".
 * New writes never produce it: `AddSubjectNoteOptions.source` carries provenance
 * as DATA on the durable row and stamps `MEMORY_UNTRUSTED_TAG` on the recall row.
 *
 * MOVED HERE from `subjectMemory.ts` (where it was module-private) by review
 * finding F2: `compactMemory` in `inMemorySurfaces.ts` could not import it —
 * `subjectMemory → inMemorySurfaces` already exists, so the reverse edge is a
 * cycle — and so read the tag alone. That made compaction the ONE path that
 * could DESTROY the signal: it joins source contents, and a legacy row that is
 * not first leaves an archive that no longer *starts with* the prefix, written
 * untagged. Fenced row in, permanently trusted row out. See
 * `assertLegacyPrefixSurvivesCompaction` coverage in
 * `test/memory-trust-compaction.test.ts`.
 */
export const LEGACY_AUTO_EXTRACTED_PREFIX = '[auto-extracted] ';

/** True when `content` bears the legacy auto-extraction prefix (see above). */
export const hasLegacyAutoExtractedPrefix = (content: unknown): boolean =>
  typeof content === 'string' && content.startsWith(LEGACY_AUTO_EXTRACTED_PREFIX);

/**
 * The ONE question every read path must ask of a memory row: is it untrusted?
 *
 * Both halves, always — the tag (post-0587 writes) OR the legacy content prefix
 * (pre-0587 auto-extraction, which has no tag). Asking only the tag is how F2
 * happened; there is no read path for which the tag alone is the right question.
 */
export const isUntrustedMemoryRow = (tags: readonly string[], content?: unknown): boolean =>
  tags.includes(MEMORY_UNTRUSTED_TAG) || hasLegacyAutoExtractedPrefix(content);
