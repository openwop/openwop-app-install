/**
 * ADR 0099 — the pure tool-output compaction kernel.
 *
 * Deterministic, zero-dependency, no I/O. Given a tool-result string and a
 * resolved decision, returns a (usually smaller) string carrying the same
 * information the LLM actually consumes. Same input → byte-identical output.
 *
 * Two structure-preserving transforms (lossless for LLM comprehension — see the
 * present-vs-absent caveat in ADR 0099 §kernel) plus an opt-in lossy elision:
 *   - minify pretty-printed JSON (strip insignificant whitespace);
 *   - drop structurally-empty fields (""/null/[]/{}), recursively;
 *   - (lossy, per-agent opt-in only) collapse long homogeneous arrays to
 *     head + {"_elided": N} + tail, preserving the true count.
 *
 * Non-JSON content (prose, code, error text) is returned untouched — the kernel
 * never mangles a string it cannot parse as JSON.
 */

import type { CompactionDecision } from '../../executor/types.js';

export type { CompactionDecision };

const DEFAULT_HEAD = 3;
const DEFAULT_TAIL = 1;

function isStructurallyEmpty(v: unknown): boolean {
  if (v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** Recursively drop ""/null/[]/{} fields. Preserves key insertion order (deterministic). */
function dropEmpty(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropEmpty);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const cleaned = dropEmpty(val);
      if (!isStructurallyEmpty(cleaned)) out[k] = cleaned;
    }
    return out;
  }
  return v;
}

/** Collapse homogeneous arrays longer than head+tail+1 to head + marker + tail. */
function elideArrays(v: unknown, head: number, tail: number): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map((x) => elideArrays(x, head, tail));
    if (mapped.length > head + tail + 1) {
      return [...mapped.slice(0, head), { _elided: mapped.length - head - tail }, ...mapped.slice(mapped.length - tail)];
    }
    return mapped;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = elideArrays(val, head, tail);
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

  let out = dropEmpty(parsed);
  if (decision.mode === 'lossy') {
    const head = Number.isInteger(decision.head) && decision.head! >= 0 ? decision.head! : DEFAULT_HEAD;
    const tail = Number.isInteger(decision.tail) && decision.tail! >= 0 ? decision.tail! : DEFAULT_TAIL;
    out = elideArrays(out, head, tail);
  }

  // Minified re-serialization. If the original was already smaller (e.g. an
  // array of scalars where dropEmpty/minify add nothing), keep whichever is
  // shorter so compaction is never a regression.
  const compacted = JSON.stringify(out);
  return compacted.length < content.length ? compacted : content;
}
