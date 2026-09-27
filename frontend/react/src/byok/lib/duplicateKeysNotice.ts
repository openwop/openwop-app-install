/**
 * Which "you have more than one key for this provider" message to show — and
 * whether to show one at all (ADR 0517 open question 1).
 *
 * Extracted from `KeysPage` so the DECISION is testable without mounting a page
 * that pulls in eight modules. The three branches are not interchangeable copy:
 * each makes a different factual claim, and picking the wrong one is how a user
 * deletes the key their chat is actually using.
 *
 *   - `withActive`    — we know which ref is live, so we can name it and say
 *                       plainly that the rest are safe to remove.
 *   - `noneActive`    — we read the binding and it points at none of these
 *                       (or there is none). "Pick one" is the honest ask.
 *   - `unknownActive` — we could NOT read the binding. Saying "the others are
 *                       inactive" here would be a guess, and a guess that invites
 *                       deleting the live key. So it says it does not know.
 *
 * The `unknown` sentinel is deliberately distinct from `null`: "the server said
 * there is no binding" and "we never heard back" are different facts, and
 * collapsing them is the exact conflation ADR 0517 exists to remove.
 */

/** `null` = no binding; `'unknown'` = the binding could not be read. */
export type ActiveRefState = string | null | 'unknown';

export interface DuplicateKeysNotice {
  /** i18n key in the `byok` namespace. */
  key: 'duplicateKeysWithActive' | 'duplicateKeysNoneActive' | 'duplicateKeysUnknownActive';
  params: { count: number; active?: string; provider?: string };
}

/**
 * @param refs      every stored credentialRef for ONE provider
 * @param activeRef the workspace's active chat binding
 * @param provider  the provider's display label
 */
export function duplicateKeysNotice(
  refs: readonly string[],
  activeRef: ActiveRefState,
  provider: string,
): DuplicateKeysNotice | null {
  // One key (or none) is not a duplicate situation — no notice at all.
  if (refs.length <= 1) return null;

  if (activeRef === 'unknown') {
    return { key: 'duplicateKeysUnknownActive', params: { count: refs.length, provider } };
  }
  if (activeRef !== null && refs.includes(activeRef)) {
    // count = the INACTIVE ones, not the total — "the other N".
    return { key: 'duplicateKeysWithActive', params: { count: refs.length - 1, active: activeRef } };
  }
  return { key: 'duplicateKeysNoneActive', params: { count: refs.length, provider } };
}
