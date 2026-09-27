/**
 * A grep ratchet on the vocabulary of DEFECT PINS.
 *
 * A production incident (`provider_not_supported: Provider "undefined"`) survived
 * repeated review because eight test files asserted it as correct, under names
 * like "fails cleanly at the AI node (no provider configured)". A later sweep
 * found the phrase-level tell is confined to a handful of files — *"papering
 * over"*, *"NOT FIXED"*, *"pinned, NOT fixed"*, *"honest, reproducible current
 * behavior"* — which makes it cheap to ratchet, and it would have caught the
 * original.
 *
 * THE FALSE-POSITIVE CLASS THIS HAS TO HANDLE: the same words appear in the
 * CORRECTIONS that describe those pins ("was: NOT FIXED", quoting the old
 * docblock). A count-based ceiling cannot tell the two apart, and would also let
 * a new pin hide behind a reworded correction. So this pins the FILE SET: a file
 * not on the list must not use the vocabulary at all, and each entry below says
 * which kind it is.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST_ROOT = join(import.meta.dirname);
const FE_ROOT = join(import.meta.dirname, '../../../frontend/react/src');

// `pinned, NOT fixed` — the FULL documented tell, not the `pinned, NOT` prefix
// this used to carry. The prefix was a loosening of the phrase the docblock
// above actually names, and it collided with unrelated domain vocabulary the
// moment "pin" acquired a second meaning: UX_UPGRADE-content R2 added
// `repinContentApproval` (re-point an approval row at the page's current
// version), and a comment reading "re-pinned, not duplicated" tripped this gate
// while pinning no defect at all. Widening a matcher beyond its stated tell
// buys false positives, and a gate that cries wolf on correct code is one a
// later session silences. Every real target below still matches.
const PATTERN = /papering over|NOT FIXED|not fixed \(documented|pinned, NOT fixed|honest, reproducible current behavio|documented \(unfixed\)|OUT OF SCOPE \(found/i;

/**
 * Known files, and WHY. `correction` = prose describing a pin that has since
 * been fixed (keep). `pin` = a live defect still asserted as expected behaviour
 * (shrink-only — each is real debt).
 */
const KNOWN = new Map<string, 'correction' | 'pin'>([
  // Corrections — these quote the vocabulary while describing the fix.
  ['workflow-chain-it-support-execution.test.ts', 'correction'],
  ['kb-rag-chain-wiring.test.ts', 'correction'],
  // REMOVED 2026-08-11 with the PATTERN tightening above. This file never
  // carried the defect vocabulary: its only match was the assertion message
  // "ZIP entry timestamps must be pinned, not `new Date()`" — TIMESTAMP
  // pinning, caught by the over-broad `pinned, NOT` prefix. The registry entry
  // had a plausible rationale written for it after the fact (EPUB-DET-1's
  // correction prose), which is how a false positive acquires a justification
  // and stops looking like one.
  // SESS-PRE-2 — carries a §CORRECTION recording that I diagnosed this as a
  // ~24-second blocking render and was WRONG (measured: import=1005ms
  // render=91ms). Prose about a defect that is FIXED, so: correction.
  ['menuLoadGuard.test.tsx', 'correction'],
  // REMOVED 2026-08-18: `workflow-chain-knowledge-execution.test.ts` no longer
  // matches the pattern at all. #3348 ("the chains deliver what they promise")
  // fixed the defects its correction prose described and deleted the prose with
  // them, which is the intended end state — this registry is a list of files
  // that USE the vocabulary, so a file that has stopped using it must leave.
  // The staleness check is what noticed; it is doing exactly its job.
  // Retired 2026-07-30: its two 'OUT OF SCOPE — NOT fixed' defects were both
  // fixed (the core.flow.if branch wiring + the newsletter render inputs), so
  // the file no longer carries the vocabulary at all.
  // Live pins — real debt, tracked. Each asserts a shipped defect as correct.
  ['workflow-chain-market-intel-digest-execution.test.ts', 'pin'],
  ['workflow-chain-campaign-journeys-execution.test.ts', 'pin'],
  // ADDED 2026-08-23 (ADR 0604). Both are ENUMERATION ratchets — they classify
  // every run-creation / tool-result caller site — and both classify the SAME
  // two live gaps as expected: the anonymous lane (`host/anonymousActor.ts`,
  // `routes/anonSurfaceSeam.ts`) creates its run with a bare
  // `storage.insertRun`, bypassing `insertRunWithStartContext` entirely, and
  // the realtime voice bridge has no run at all. Neither can be compacted
  // today, and each file says so in the vocabulary this gate watches for.
  //
  // They are `pin`, not `correction`: the gap is SHIPPED and open, so these
  // tests bless current behaviour and will need editing when it is closed —
  // which is the whole point of the category. Recorded rather than reworded on
  // purpose: rephrasing the `why` strings would have turned this gate green
  // while leaving the debt exactly as real, and a gate dodged once stays
  // dodged.
  //
  // Do NOT "fix" the anon lane by routing it through the seam without a
  // decision of its own — the seam runs the AUTHORITY contributor, and doing
  // that for an ANONYMOUS principal is a security change wearing the costume
  // of a token-savings cleanup. That reasoning is recorded at the call site.
  ['run-metadata-copy-sites.test.ts', 'pin'],
  ['tool-result-compaction-callers.test.ts', 'pin'],
  // ADR 0664 / `AGKM-11`, 2026-09-12. The census records `deleteRosterMemberCascade` and the
  // `purgeNamespaceVectors` it calls as lanes that assert NO retention hold — a live defect,
  // written down rather than fixed, which is exactly what this registry calls a `pin`.
  //
  // This gate fired on the words "not fixed" and it was RIGHT to. The tempting move was to
  // reword until it passed; that is policing a spelling instead of the invariant, and it is
  // how a ratchet stops meaning anything. Registered instead.
  ['destructive-lane-census.test.ts', 'pin'],
]);

/** Live pins may only SHRINK. Raising this means a new defect was pinned.
 *
 *  RAISED 4 -> 5, 2026-09-12 (ADR 0664 / `AGKM-11`). Said plainly: this is the SECOND ceiling
 *  loosened for one gap — `destructive-lane-census.ts`'s own `MAX_UNPINNED` went 2 -> 4 in the
 *  same change. Two independent ratchets both flagged the same missing hold gate, which is the
 *  system working, not redundancy to tune away. Closing `AGKM-11` lowers BOTH; nothing else
 *  should be added under either until it is. */
const PIN_CEILING = 5;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const SELF = 'defect-pin-vocabulary.test.ts';

const offenders = [...walk(TEST_ROOT), ...walk(FE_ROOT)]
  .filter((p) => PATTERN.test(readFileSync(p, 'utf8')))
  .map((p) => p.split('/').pop()!)
  // This file necessarily contains the vocabulary — it DEFINES it. Excluding
  // the definition is not a loophole; including it made the ratchet fail on
  // itself the moment it was written.
  .filter((f) => f !== SELF);

describe('defect-pin vocabulary', () => {
  it('is non-vacuous — the scan really reads files and the pattern really matches', () => {
    expect(offenders.length, 'no hits at all — the walker or pattern is broken').toBeGreaterThan(0);
    expect(offenders).toContain('workflow-chain-market-intel-digest-execution.test.ts');
  });

  it('no NEW file adopts the vocabulary', () => {
    const unknown = [...new Set(offenders)].filter((f) => !KNOWN.has(f));
    expect(
      unknown,
      'This file describes a defect as expected behaviour. If you are FIXING one, add it as a '
      + '`correction`. If you are pinning a live defect, that is debt — add it as a `pin` and '
      + 'raise PIN_CEILING deliberately, knowing a broken shipped surface is being blessed.',
    ).toEqual([]);
  });

  it('live pins only shrink', () => {
    const pins = [...KNOWN.entries()].filter(([, kind]) => kind === 'pin');
    expect(
      pins.length,
      `${pins.length} test files still assert a shipped defect as correct. Fixing one means `
      + 'moving it to `correction` and lowering PIN_CEILING.',
    ).toBeLessThanOrEqual(PIN_CEILING);
  });

  it('the registry is not stale — every listed file still matches', () => {
    const stale = [...KNOWN.keys()].filter((f) => !offenders.includes(f));
    expect(stale, 'Listed but no longer matching — remove it so the list stays honest.').toEqual([]);
  });
});
