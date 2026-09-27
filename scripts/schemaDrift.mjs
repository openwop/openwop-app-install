// schemaDrift — pure drift-direction classification for vendored JSON schemas.
//
// Extracted from check-vendored-schemas.mjs so it is unit-testable: this logic
// decides whether the guard recommends `sync-schemas.sh`, which OVERWRITES the
// vendored copy with canonical. Getting the direction wrong means recommending a
// command that silently deletes fields the app validates against at runtime.
//
// The comparison is by CONTAINMENT, not equality. Two schemas can differ while
// one still fully contains the other — that asymmetry is exactly the signal:
//   canonical ⊂ vendored  ⇒ the app is ahead (do NOT sync)
//   vendored  ⊂ canonical ⇒ the app is behind (sync is the right fix)
//   neither               ⇒ genuinely diverged (needs a human)

/** Flatten a JSON doc to a set of `path=value` leaves. Object key ORDER and
 *  formatting are irrelevant; only the set of leaf facts matters. */
export function leafSet(node, prefix = '', out = new Set()) {
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) leafSet(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.add(`${prefix}=${JSON.stringify(node)}`);
  }
  return out;
}

export const AHEAD = 'vendored AHEAD of canonical';
export const BEHIND = 'vendored BEHIND canonical';
export const DIVERGED = 'diverged (both sides differ)';
export const UNKNOWN = 'unknown';

/**
 * Whether a vendored corpus tag is the corpus actually certified by an
 * installed conformance suite. New suites carry that provenance explicitly in
 * schemas/CORPUS-STAMP.json, which lets a harness-only patch release without
 * pretending to be a new corpus release. The version comparison is retained
 * only for legacy suites that predate the stamp field.
 */
export function suiteCertifiesCorpusTag(vendoredTag, suiteVersion, certifiedCorpusTag = null) {
  if (typeof certifiedCorpusTag === 'string' && certifiedCorpusTag.length > 0) {
    return vendoredTag === certifiedCorpusTag;
  }
  const match = /^(?:openwop-conformance\/)?v(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/.exec(vendoredTag);
  return match?.[1] === suiteVersion;
}

/**
 * Classify drift between the vendored copy and canonical.
 * Returns one of AHEAD / BEHIND / DIVERGED / UNKNOWN (unparseable input).
 */
export function classifyDrift(vendoredText, canonicalText) {
  if (typeof vendoredText !== 'string' || typeof canonicalText !== 'string') return UNKNOWN;
  let mine;
  let theirs;
  try {
    mine = leafSet(JSON.parse(vendoredText));
    theirs = leafSet(JSON.parse(canonicalText));
  } catch {
    return UNKNOWN;
  }
  const missingHere = [...theirs].some((x) => !mine.has(x));
  const extraHere = [...mine].some((x) => !theirs.has(x));
  if (!missingHere && extraHere) return AHEAD;
  if (!extraHere && missingHere) return BEHIND;
  if (!missingHere && !extraHere) return UNKNOWN; // semantically equal — not drift
  return DIVERGED;
}
