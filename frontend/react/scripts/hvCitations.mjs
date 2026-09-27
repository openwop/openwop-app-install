/**
 * The DECISION LOGIC of `check-hv-citations.mjs`, extracted so the four
 * sabotages that hardened it become ASSERTIONS instead of a claim.
 *
 * #2974 found four ways that gate could pass while measuring nothing, fixed all
 * four, and its commit body states "All four sabotages re-run and now exit 1."
 * That was true when written and is unprotected: the sabotages were manual
 * probes, run once and discarded. The same lesson `GATE-5` recorded for the
 * merge-gate scripts — a probe you throw away protects nothing, and the next
 * edit to a regex here is exactly the kind of change that silently re-opens one.
 *
 * Pure functions only: no file IO, no `process.exit`. The script keeps the
 * scanning and the exit codes; this module owns what counts as evidence.
 */

/**
 * Test path, live-verification note, or a PR/issue reference.
 *
 * Each arm is deliberately narrow because #2974's grade pass broke the first
 * version three ways:
 *   - `verified\b` had no LEADING boundary, so it matched inside "UNverified" —
 *     a row saying "unverified, and there are no live walkthroughs" self-certified.
 *   - `#\d{3,}` meant to match a PR reference also matched `#123456`, a hex
 *     colour quoted in prose.
 * Hence a leading `\b`, and a PR reference must look like one.
 */
export const EVIDENCE =
  /__tests__|\.test\.tsx?|\bverified\b[^\n]{0,40}(live|\d{4}-\d{2}-\d{2})|(^|[\s(])#\d{3,4}\b/i;

/** Explicitly negated evidence — never a citation, whatever else the block says. */
export const NEGATED =
  /\bunverified\b|\bnot verified\b|no\s+__tests__|no tests? cover|nothing\s+(whatsoever\s+)?proves/i;

/**
 * The lines belonging to a row: the row itself plus INDENTED continuations.
 *
 * Stopping at the next list item is not enough. A following UNINDENTED paragraph
 * bled in, so a row reading "nothing whatsoever proves this" passed off a
 * `#2960` two lines below that belonged to no row at all.
 */
export function rowBlock(lines, i) {
  const block = [lines[i]];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (/^- \[|^#/.test(lines[j])) break;
    if (lines[j].trim() !== '' && !/^\s/.test(lines[j])) break;
    block.push(lines[j]);
  }
  return block.join('\n');
}

/**
 * Verdict for one ticked row's block.
 *
 * ORDER MATTERS. Positive evidence wins: a row citing a real test AND honestly
 * noting what that test does NOT cover ("it never clicks it, so nothing proves
 * the read re-runs") is the BEST kind of row. Only a block with no positive
 * citation at all is judged on its negations, which is where "unverified"
 * belongs.
 *
 * @returns {'cited' | 'negated' | 'bare'}
 */
export function classifyRow(text) {
  // STRIP THE NEGATING PHRASES FIRST, then look for evidence in what remains.
  //
  // Testing EVIDENCE against the raw text let a negation carry its own proof:
  // "no __tests__ cover this at all" contains the literal `__tests__`, so
  // EVIDENCE matched, the row was accepted, and NEGATED never got to veto —
  // it only shaped an error message that was never printed. That is one of the
  // three exploits #2974 set out to close, and it was still live; the other two
  // ("unverified", the hex colour) were genuinely fixed.
  //
  // Stripping preserves the rule the docblock states — POSITIVE EVIDENCE WINS —
  // because it only removes the negating phrase itself:
  //   "no __tests__ cover this"                    → nothing left → not cited
  //   "`x.test.tsx` covers it; nothing proves the read re-runs"
  //                                                → `x.test.tsx` survives → cited
  // which is exactly the honest split-row shape the comment protects.
  const withoutNegations = text.replace(new RegExp(NEGATED.source, 'gi'), ' ');
  if (EVIDENCE.test(withoutNegations)) return 'cited';
  return NEGATED.test(text) ? 'negated' : 'bare';
}

/** The committed row floor. Raise it when the corpus genuinely grows. */
export const FILE_ROW_FLOOR = 190;

/**
 * Resolve the effective row floor, honouring an env override that may only ever
 * RAISE it.
 *
 * The floor exists because renaming the `HV-` prefix in 25 of 91 trackers drops
 * the measured population 201 -> 134. As first shipped the override could LOWER
 * it, so `OPENWOP_HV_ROW_FLOOR=1` made `134 < 1` false and the drift went green
 * again — the env var handed back exactly the hole the floor closed. Raising
 * stays open because it is useful: prove a higher floor is met before committing
 * it.
 *
 * @returns {{ok: true, floor: number, note?: string} | {ok: false, error: string}}
 */
export function resolveRowFloor(envValue, fileFloor = FILE_ROW_FLOOR) {
  if (envValue === undefined || envValue === '') return { ok: true, floor: fileFloor };
  const n = Number(envValue);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `OPENWOP_HV_ROW_FLOOR=${envValue} is not a count.` };
  }
  if (n < fileFloor) {
    return {
      ok: false,
      error:
        `refusing OPENWOP_HV_ROW_FLOOR=${n} — it is LOWER than the committed floor ` +
        `(${fileFloor}). The override may only RAISE this gate, never relax it; lowering ` +
        'it re-opens the id-drift hole the floor exists to close.',
    };
  }
  return { ok: true, floor: n, note: `row floor raised to ${n} via OPENWOP_HV_ROW_FLOOR` };
}
