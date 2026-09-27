/**
 * M2 — the degradation-ledger label lookup, with an explicit allowlist and a
 * real fallback.
 *
 * The backend's `degraded` ledger (`host/chatContext.ts`) is a list of BLOCK
 * NAMES, and `ChatInput` composed the label key dynamically — ``t(`voiceCtxBlock_${b}`)``
 * — in both the tooltip and the screen-reader span. `check-i18n.mjs` cannot see a
 * dynamically composed key, so a ledger value with no catalog entry is green at
 * build time and reaches the user as a RAW KEY: a voice session on a boardroom
 * whose planning context failed announced *"Voice is running with reduced
 * context: voiceCtxBlock_board_context"*. `twin_borrowed_recall` had the same
 * gap and had shipped that way since ADR 0044 Phase 2.
 *
 * Two changes make that unreachable rather than merely fixed-once:
 *   1. the set of ledger values this catalog covers is an EXPLICIT list here, so
 *      it is greppable and testable against the real catalogs (see
 *      `__tests__/voiceCtxLabels.test.ts`, which asserts every key exists in en /
 *      es / fr / pt-BR — the drift guard `check-i18n.mjs` structurally cannot be);
 *   2. anything NOT on the list resolves to a translated generic, so the NEXT
 *      ledger value the backend adds degrades to "other context" instead of
 *      leaking an identifier.
 *
 * Keep in step with `DEGRADED_BLOCK_LABELS` + the `degraded.push(...)` sites in
 * `backend/typescript/src/host/chatContext.ts` and the `'preamble'` / `'whole'` /
 * `'identity'` pushes in `features/voice/realtime/routes.ts`. The two live in
 * different deploy artifacts, so this cannot be a compile-time link — which is
 * exactly why the fallback, not the list, is the guarantee.
 */

/** Ledger values this catalog has a `voiceCtxBlock_<value>` string for. */
export const VOICE_CTX_BLOCKS = [
  'identity',
  'persona',
  'agent_knowledge',
  'owner_knowledge',
  'twin_borrowed_recall',
  'twin_borrowed_recall_partial',
  'board_context',
  'board_context_partial',
  'preamble',
  'whole',
] as const;

/** The i18n key for a ledger value — the generic when it is not one we know.
 *  (A plain `includes` over nine entries, not a Set: this module is in the SPA's
 *  ENTRY chunk, which has single-digit BYTES of budget headroom.) */
export function voiceCtxBlockKey(block: string): string {
  return (VOICE_CTX_BLOCKS as readonly string[]).includes(block) ? `voiceCtxBlock_${block}` : 'voiceCtxBlock_other';
}

/** The whole ledger as one comma-joined label list (what the chip renders). */
export function voiceCtxBlockLabels(t: (key: string) => string, blocks: readonly string[]): string {
  return blocks.map((b) => t(voiceCtxBlockKey(b))).join(', ');
}
