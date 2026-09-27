/**
 * DOCTPL-19 / ADR 0516 §Provenance — bidi isolation for PACK-AUTHORED text.
 *
 * A hostile template pack can embed RTL-override / reordering control
 * characters in its labels so the rendered string reads as something other
 * than what it is (the classic filename-spoof shape, aimed here at making a
 * pack-supplied template masquerade as a trusted one). Wrapping the string in
 * FIRST-STRONG ISOLATE … POP DIRECTIONAL ISOLATE (U+2068/U+2069 — the
 * plain-string equivalent of `<bdi>`) confines any directional state to the
 * untrusted span, so it cannot reorder the trusted copy around it. Apply to
 * every string a PACK authored (labels, descriptions, categories, pack names)
 * at the point it is mixed into app chrome; app-authored copy needs nothing.
 */
export function bidiIsolate(text: string): string {
  return `\u2068${text}\u2069`;
}
