/**
 * ADR 0099 — the pure tool-output compaction kernel.
 *
 * Deterministic, zero-dependency, no I/O. Given a tool-result string and a
 * resolved decision, returns a (usually smaller) string carrying the same
 * information the LLM actually consumes. Same input → byte-identical output.
 *
 *   - `lossless` — minify only, by DELETING INSIGNIFICANT WHITESPACE FROM THE
 *     SOURCE TEXT. Every other byte survives: keys, string values, numeric
 *     literals, key order, duplicate keys. See "why not re-serialise" below.
 *   - `lossy` (per-agent opt-in) — re-serialises, and additionally DROPS
 *     structurally-empty fields and collapses long arrays, each with an
 *     explicit disclosure marker.
 *
 * Non-JSON content (prose, code, error text) is returned untouched — the kernel
 * never mangles a string it cannot parse as JSON.
 *
 * ── TOCC-3 / TOCWF-7 (ADR 0604): WHY `dropEmpty` MOVED OUT OF `lossless` ──
 *
 * `lossless` used to mean "minify + drop `""`/`null`/`[]`/`{}` recursively",
 * described in four places as structure-preserving and lossless. Measured, it
 * was neither:
 *
 *     {"results":[],"query":"q"}                   -> {"query":"q"}
 *     {"ok":false,"error":""}                      -> {"ok":false}
 *     {"agents":[],"workflows":[],"roster":[],…}   -> {}
 *     {"type":"object","required":[],…}            -> required: gone
 *
 * (`false` and `0` ARE preserved — the classic `[]`-truthy / `''`-falsy trap was
 * correctly avoided. The defect is semantic, not that one.)
 *
 * An empty array that means "we looked and found nothing" is not noise. Dropping
 * it converts an honest empty into an ABSENT FIELD, which is the
 * success-with-empty family this codebase treats as a defect wherever a model is
 * on the other end — and here the app is the one lying to the model.
 * `agent-author.nodes.get`'s honest fail-empty compacted to `{}`.
 *
 * There is no rule that separates a "noise" empty from a "claim" empty without
 * the payload's schema, and the kernel has no schema. That is the whole finding:
 * a transform that cannot tell them apart must not be the DEFAULT-ON mode, and
 * must not be called lossless.
 *
 * ── AND WHAT THAT COSTS, MEASURED, BECAUSE IT IS NOT NOTHING ──
 *
 * `lossless` is now minification only, and minification saves NOTHING on this
 * host's tool outputs: **0 of 336 `JSON.stringify(...)` call sites across
 * `src/features/*​/agentTools.ts` pass an indent argument** — every builtin tool
 * already emits minified JSON. So 100% of the measurable saving `lossless` ever
 * produced came from the semantically-lossy half, and removing that half makes
 * the default mode a near-no-op on tool output.
 *
 * That is recorded rather than hidden. The feature's advertised savings were
 * resting on the defect; the savings are still available, but only through the
 * explicit per-agent `lossy` opt-in, where the name tells the truth and both
 * transforms disclose what they removed.
 *
 * ── H2 (ADR 0604 review): WHY `lossless` DOES NOT RE-SERIALISE ──
 *
 * The first cure for TOCC-3 left `lossless` as `JSON.parse` → `JSON.stringify`
 * and claimed, in four shipped places, that this is "provably
 * information-preserving". At the level that matters — the STRING the model
 * reads — it is not. MEASURED:
 *
 *     {"a": 9007199254740993}                -> {"a":9007199254740992}   (IEEE-754)
 *     {"a":1e400}                            -> {"a":null}               (Infinity)
 *     {"x": 1.0}                             -> {"x":1}
 *     {"status":"ok","status":"degraded"}    -> {"status":"degraded"}    (dup key)
 *
 * The witness could not see any of it BY CONSTRUCTION: it asserted
 * `expect(JSON.parse(out)).toEqual(JSON.parse(input))`, and both sides go
 * through the same `JSON.parse` that causes the loss. A round-trip oracle
 * cannot detect a defect in the round trip. (That was the third instance of
 * this family in this batch — inside the cure for the second one.)
 *
 * So `lossless` now deletes whitespace from the ORIGINAL TEXT instead
 * (`minifyJsonText`). `JSON.parse` still runs, but ONLY as a validator — a
 * payload that is not JSON is returned untouched, exactly as before, and the
 * scanner never runs on text `JSON.parse` rejected. Every byte the scanner does
 * not delete is a byte it copied, so the guarantee is now the one the mode's
 * NAME claims, and it is checkable as a STRING property rather than through the
 * transform that loses the information.
 *
 * The savings are unchanged, MEASURED rather than assumed (a savings claim is
 * exactly what this feature has been wrong about before): on the kernel test's
 * 40-row indented fixture, whitespace deletion produces 7721 bytes from 13809
 * — BYTE-IDENTICAL to what `JSON.stringify` produced; on the 336/0
 * already-minified lane both save 0. `lossy` still re-serialises — it has to, it is rebuilding
 * the value — so the four cases above remain true THERE, where the mode's name
 * already says so. They are pinned as documented `lossy` behaviour in the
 * kernel test rather than left for the next reader to rediscover.
 */

import type { CompactionDecision } from '../../executor/types.js';

export type { CompactionDecision };

const DEFAULT_HEAD = 3;
const DEFAULT_TAIL = 1;

/** The disclosure marker `dropEmpty` leaves behind, naming what it removed. */
export const EMPTIED_MARKER = '_emptied';
/** The disclosure marker `elideArrays` leaves in place of the removed rows. */
export const ELIDED_MARKER = '_elided';

/**
 * LOSSLESS. Delete insignificant whitespace from well-formed JSON TEXT.
 *
 * Precondition: `text` has already been accepted by `JSON.parse`. That is what
 * makes this scanner sound — it only has to skip string literals correctly, and
 * a well-formed JSON string literal is `"` … `"` with `\` escaping the next
 * character. RFC 8259 insignificant whitespace is exactly space / tab / LF / CR.
 *
 * The invariant, which `tool-output-compaction-kernel.test.ts` proves by walking
 * both strings with two pointers: **every character of the output is a
 * character of the input, in order, and every character dropped is whitespace
 * outside a string literal.** No key, value, numeric literal, escape sequence,
 * duplicate key or ordering can change, because nothing is ever WRITTEN — only
 * copied or skipped.
 */
export function minifyJsonText(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      i += 1;
      while (i < text.length) {
        const d = text[i]!;
        if (d === '\\') { i += 2; continue; } // escape: copy both bytes verbatim
        i += 1;
        if (d === '"') break;
      }
      out += text.slice(start, i); // the literal, byte-for-byte (inner whitespace kept)
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

function isStructurallyEmpty(v: unknown): boolean {
  if (v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/**
 * LOSSY. Recursively drop `""`/`null`/`[]`/`{}` fields, recording the dropped
 * key names in an appended `_emptied` array so the removal is DISCLOSED rather
 * than silent — an absent field then means "no information", and an
 * `_emptied`-named field means "present and empty", which is the distinction
 * the un-disclosed version destroyed (TOCC-3).
 *
 * Preserves key insertion order (deterministic). An object that already carries
 * a `_emptied` key is left ALONE: overwriting a real payload field with our
 * marker would be a worse lie than the one we are fixing.
 */
function dropEmpty(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropEmpty);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(src, EMPTIED_MARKER)) {
      const passthrough: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(src)) passthrough[k] = dropEmpty(val);
      return passthrough;
    }
    const out: Record<string, unknown> = {};
    const emptied: string[] = [];
    for (const [k, val] of Object.entries(src)) {
      const cleaned = dropEmpty(val);
      if (isStructurallyEmpty(cleaned)) emptied.push(k);
      else out[k] = cleaned;
    }
    if (emptied.length) out[EMPTIED_MARKER] = emptied;
    return out;
  }
  return v;
}

/** Collapse homogeneous arrays longer than head+tail+1 to head + marker + tail. */
function elideArrays(v: unknown, head: number, tail: number): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map((x) => elideArrays(x, head, tail));
    if (mapped.length > head + tail + 1) {
      return [
        ...mapped.slice(0, head),
        { [ELIDED_MARKER]: mapped.length - head - tail },
        ...mapped.slice(mapped.length - tail),
      ];
    }
    return mapped;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // ADR 0604 — NEVER elide the `_emptied` disclosure. Caught by the witness
      // that was written to prove the disclosure works: with eight dropped keys
      // the marker became `['a','b','c',{_elided:4},'h']`, i.e. this fix
      // silently truncated its OWN honesty affordance — the same
      // absence-is-a-claim family the disclosure exists to close. The guard is
      // explicit rather than order-dependent so a later reordering of the two
      // transforms cannot quietly reopen it.
      out[k] = k === EMPTIED_MARKER ? val : elideArrays(val, head, tail);
    }
    return out;
  }
  return v;
}

/**
 * Compact a tool-result string per the decision. Pure + deterministic. Never
 * throws on bad input — non-JSON / parse failures return the original string.
 */
export function compactToolOutput(content: string, decision: CompactionDecision): string {
  if (decision.mode === 'off') return content;
  if (typeof content !== 'string') return content;
  if (decision.minChars && content.length <= decision.minChars) return content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content; // non-JSON: untouched
  }

  // `lossless` stops here, and DOES NOT re-serialize (review H2 — see the
  // header): the parse above was a validator, and the transform is a whitespace
  // delete over the ORIGINAL text, so numeric literals, duplicate keys, key
  // order and escapes all survive byte-exact. Both dropping transforms are
  // LOSSY and gated behind the explicit per-agent opt-in (ADR 0604 / TOCC-3).
  if (decision.mode !== 'lossy') {
    const minified = minifyJsonText(content);
    return minified.length < content.length ? minified : content;
  }

  const head = Number.isInteger(decision.head) && decision.head! >= 0 ? decision.head! : DEFAULT_HEAD;
  const tail = Number.isInteger(decision.tail) && decision.tail! >= 0 ? decision.tail! : DEFAULT_TAIL;
  const out = elideArrays(dropEmpty(parsed), head, tail);

  // Minified re-serialization. If the original was already smaller (e.g. an
  // array of scalars where dropEmpty adds nothing), keep whichever is shorter so
  // compaction is never a regression.
  const compacted = JSON.stringify(out);
  return compacted.length < content.length ? compacted : content;
}
