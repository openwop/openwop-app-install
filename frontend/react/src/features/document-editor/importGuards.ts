/**
 * DOC-G1 / DOC-G2 — the two decisions the .docx import has to make, kept out of
 * the 500-line editor surface so they can be exercised directly.
 *
 * The import REPLACES the document, and the server's converter reports what it
 * could not carry across. Both facts were previously invisible: the replace had
 * no confirmation, and the `warnings` the route already serializes were dropped
 * by a destructuring that took only `html`.
 */

/** Does replacing this document destroy anything? An empty doc has nothing to
 *  lose, and demanding a confirmation there would be noise on the common path
 *  (import into a fresh document). Whitespace-only counts as empty. */
export function importWouldDestroyContent(existingText: string): boolean {
  return existingText.trim().length > 0;
}

/** The conversion messages the route returns, normalized: de-duplicated (mammoth
 *  emits one per occurrence, so a table-heavy file repeats the same sentence
 *  dozens of times) and stripped of blanks. */
export function importWarningsOf(payload: unknown): string[] {
  const raw = (payload as { warnings?: unknown } | null)?.warnings;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const w of raw) {
    if (typeof w !== 'string') continue;
    const trimmed = w.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}
