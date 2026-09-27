/**
 * CDP-1d — RFC 0128 (Draft, frozen d8b2df3b) permitted-purpose label algebra.
 *
 * Pure functions implementing the conformance-critical `permittedPurposes` semantics the
 * host must honor on OpenWOP-envelope onward hops (A2A forwards + trigger/sync events to
 * OpenWOP peers). Kept dependency-free + pure so the never-widen invariants are exhaustively
 * unit-testable — the exact behavior the steward's `purpose-propagation-onward` scenario gates.
 *
 * Vocabulary is OPAQUE strings (the wire does NOT freeze an enum); a host maps them to its
 * local consent vocabulary elsewhere. Absence (`undefined`) and the empty array (`[]`) are
 * DISTINCT and never conflated:
 *   - `undefined`  = UNLABELLED — the sender asserts no constraint (the top element).
 *   - `[]`         = NO onward use permitted (contagious through a join; blocks all egress).
 *   - `[a, b, …]`  = the permitted set.
 */

export type PurposeLabel = readonly string[] | undefined;

/** Normalize a raw label to a deduped, sorted array — or `undefined` for unlabelled.
 *  A non-array (malformed) input is treated as unlabelled (fail-open on the READ side;
 *  the egress guards below are what fail closed). */
export function normalizeLabel(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out = [...new Set(raw.filter((p): p is string => typeof p === 'string' && p.length > 0))];
  return out.sort();
}

/** `[]` asserts "no onward use" — the contagious, egress-blocking label. */
export function isNoOnwardUse(label: PurposeLabel): boolean {
  return Array.isArray(label) && label.length === 0;
}

/**
 * The label a DERIVED output carries when it combines inputs (RFC 0128 §3 + G5). The only
 * composition that never widens ANY input's grant is the INTERSECTION of the labelled inputs:
 *   - UNLABELLED inputs contribute no constraint (the top element — skipped).
 *   - a `[]` input is contagious: the result is `[]` (no onward use).
 *   - all-unlabelled inputs ⇒ `undefined` (the derived output is itself unlabelled).
 */
export function intersectLabels(inputs: readonly PurposeLabel[]): string[] | undefined {
  const labelled = inputs.map(normalizeLabel).filter((l): l is string[] => l !== undefined);
  if (labelled.length === 0) return undefined; // all unlabelled ⇒ unlabelled
  if (labelled.some((l) => l.length === 0)) return []; // a `[]` is contagious
  let acc = new Set(labelled[0]);
  for (const l of labelled.slice(1)) acc = new Set([...acc].filter((p) => l.includes(p)));
  return [...acc].sort();
}

/**
 * The never-widen check (the conformance-tested MUST NOT): an onward label is VALID iff it
 * adds no purpose the inbound grant did not carry.
 *   - inbound UNLABELLED (undefined) ⇒ no constraint ⇒ any onward label is allowed.
 *   - otherwise every onward purpose MUST be in the inbound set (narrowing/equal ok, widening not).
 *   - an `[]` inbound permits only an `[]` (or unlabelled→[]) onward — nothing may be forwarded.
 */
export function isNonWidening(inbound: PurposeLabel, onward: PurposeLabel): boolean {
  const inb = normalizeLabel(inbound);
  const onw = normalizeLabel(onward);
  if (inb === undefined) return true; // no inbound constraint
  if (onw === undefined) return true; // dropping the label is a narrowing (safe)
  return onw.every((p) => inb.includes(p));
}

/**
 * The re-emit label for an onward hop: preserve the inbound grant, optionally narrowed.
 * Defaults to carrying the inbound label verbatim (the safe MUST — never widens); a caller
 * MAY pass a `narrowTo` subset, which is intersected with the inbound grant so it can never
 * accidentally widen. Unlabelled inbound stays unlabelled.
 */
export function reEmitLabel(inbound: PurposeLabel, narrowTo?: PurposeLabel): string[] | undefined {
  const inb = normalizeLabel(inbound);
  if (inb === undefined) return normalizeLabel(narrowTo); // unlabelled: a narrowTo may add an (asserted) constraint
  if (narrowTo === undefined) return inb; // carry verbatim
  return intersectLabels([inb, narrowTo]); // narrowed, guaranteed non-widening
}
