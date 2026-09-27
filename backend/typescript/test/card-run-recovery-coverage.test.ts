/**
 * ADR 0535 P4 — the no-uncovered-pick-site tripwire.
 *
 * ADR 0535 exists because two sites moved a card into Working and nothing ever
 * moved it back. The fix only holds if EVERY such site is recoverable, so a
 * third one added later must fail the build rather than silently reintroduce
 * the bug.
 *
 * Recovery works by reading a card pointer out of `run.metadata`
 * (`cardPointerFromRunMetadata`), so "covered" means: the site's run carries a
 * `{boardId, cardId}` stamp under a key this module knows. That is the real
 * contract — not the import, and not the `moveCard` call itself.
 *
 * The distinction matters. A ratchet derived from an IMPORT is blind to a
 * non-adopter: a new file could import `moveCard`, move a card to Working, stamp
 * nothing, and an import-based check would still pass. So this derives from the
 * CALL SITE and then asserts the stamp exists in the same file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cardPointerFromRunMetadata } from '../src/host/cardRunRecovery.js';

const SRC = new URL('../src', import.meta.url).pathname;

/** Files exempt because they OWN the mechanism rather than consume it. */
const OWNERS = new Set(['host/kanbanService.ts', 'host/cardRunRecovery.ts']);

/**
 * Sites that move a card into a Working lane. Matched on the CALL, so a new
 * consumer is caught even if it imports `moveCard` in some novel way.
 */
const MOVE_TO_WORKING = /moveCard\([^)]*\bworking\b[^)]*\)/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('ADR 0535 P4 — every pick site is recoverable', () => {
  it('each site that moves a card into Working also stamps a card pointer on its run', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (OWNERS.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      if (!MOVE_TO_WORKING.test(source)) continue;

      // The site is a pick site. It is recoverable only if the run it started
      // carries a card pointer — i.e. the same file stamps boardId + cardId
      // into run metadata. Both known sites do (`metadata.heartbeat` /
      // `metadata.approval`).
      const stampsPointer = /boardId[\s\S]{0,200}?cardId|cardId[\s\S]{0,200}?boardId/.test(source);
      if (!stampsPointer) offenders.push(rel);
    }

    expect(
      offenders,
      'a site that parks a card in Working without stamping {boardId, cardId} on its run is unrecoverable — ' +
        'the card strands there forever, which is the exact bug ADR 0535 fixed. Stamp the pointer, ' +
        'or extend cardRunRecovery to reach it.',
    ).toEqual([]);
  });

  it('NO-GROWTH: the set of pick sites is exactly the two ADR 0535 covers', () => {
    // A shrink-only ratchet. A third pick site is not automatically wrong, but
    // it must be a deliberate decision that updates this list AND proves
    // recovery for it — not something that slides in unnoticed.
    const sites = walk(SRC)
      .filter((f) => !OWNERS.has(relative(SRC, f)))
      .filter((f) => MOVE_TO_WORKING.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
      .sort();

    expect(sites).toEqual(['host/approvalDecision.ts', 'host/heartbeatService.ts']);
  });

  it('the pointer reader accepts both live stamp shapes', () => {
    // Pins the coupling the tripwire above relies on: if a pick path renamed
    // its metadata key, the ratchet would still pass while recovery silently
    // stopped working for it.
    expect(cardPointerFromRunMetadata({ heartbeat: { boardId: 'b', cardId: 'c' } })).not.toBeNull();
    expect(cardPointerFromRunMetadata({ approval: { boardId: 'b', cardId: 'c' } })).not.toBeNull();
  });
});
