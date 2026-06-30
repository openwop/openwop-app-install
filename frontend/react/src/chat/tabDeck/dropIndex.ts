/**
 * computeDropIndex — translate a drag-and-drop gesture (drop `fromSid` before/after
 * `targetSid`) into the `toIndex` that `tabDeckReducer`'s `reorder` expects (ADR 0140
 * P4). The reducer treats `toIndex` as the FINAL index in the POST-REMOVAL array, so a
 * naive "drop onto tab X → X's current index" is off-by-one for left-to-right drags
 * (removing the dragged item first slides the target left). This adjusts for the
 * removal so both drag directions land correctly. Pure + unit-tested.
 *
 * Returns null for a no-op (unknown id, or dropping a tab onto itself).
 */
export function computeDropIndex(
  order: readonly string[],
  fromSid: string,
  targetSid: string,
  side: 'before' | 'after',
): number | null {
  if (fromSid === targetSid) return null;
  const from = order.indexOf(fromSid);
  const target = order.indexOf(targetSid);
  if (from < 0 || target < 0) return null;
  // Insertion index in the ORIGINAL array (before removing the dragged item).
  const desired = target + (side === 'after' ? 1 : 0);
  // Removing `from` shifts every later index left by one.
  const final = desired - (from < desired ? 1 : 0);
  if (final === from) return null; // no movement
  return final;
}
