/**
 * ADR 0666 follow-ups on the digital-twin RECALL lane (feature 18), it.18.
 *
 * `RCLWF-4` — the model-facing anti-fabrication notice has ONE owner. It had two: the exported
 * `degradationNotice` and a hand-inlined copy in `agentDispatch`, and the two had ALREADY
 * DRIFTED ("could not be read" vs "could not be searched"; "missing from the context below" vs
 * "missing from the context"). Two wordings of the single sentence that stops a model reporting
 * a FAILED read as an EMPTY one is precisely the drift a shared helper exists to prevent.
 *
 * `RCLWF-3` — and the notice must NOT be wrapped in the untrusted fence. Its docblock claimed it
 * was, at every commit since the function was born. The fence marks content a model may read but
 * must never follow as instruction; this sentence IS an instruction ("do NOT tell the user you
 * have nothing on record"), so fencing it would disarm the one thing it is for. A reader
 * trusting that docblock would have "fixed" it into uselessness, which is why the claim is
 * pinned here rather than only corrected in prose.
 *
 * Sabotage witnesses (w12): softening "FAILED read" reds case 1; a re-typed copy in
 * agentDispatch reds case 2; wrapping the notice in `fenceUntrustedItems` reds case 3.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeBorrowedRecallContext, degradationNotice } from '../src/host/agentKnowledgeComposition.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const DISPATCH = readFileSync(join(SRC, 'host', 'agentDispatch.ts'), 'utf8');
const COMPOSITION = readFileSync(join(SRC, 'host', 'agentKnowledgeComposition.ts'), 'utf8');

describe('RCLWF-4 — one owner for the degradation notice', () => {
  it('the notice carries the two claims that make it load-bearing', () => {
    const n = degradationNotice(["your owner's shared corpus"]);
    // Anti-vacuity: if these ever softened, the legs below would still pass while the notice
    // stopped doing its job.
    expect(n, 'names what could not be read').toContain("your owner's shared corpus");
    expect(n, 'must say it is a FAILED read, not an empty one').toMatch(/FAILED read, not an empty one/);
    expect(n, 'must forbid the false claim explicitly').toMatch(/do NOT tell the user you have nothing on record/);
  });

  it('the dispatch lane CALLS the owner instead of re-typing it', () => {
    // The structural half: a second hand-written copy is how the two drifted in the first place,
    // and a text assertion alone would pass against a fresh duplicate.
    expect(DISPATCH, 'agentDispatch must call the shared notice').toMatch(/sections\.push\(degradationNotice\(/);
    expect(
      DISPATCH.includes('This is a FAILED read, not an empty one'),
      'agentDispatch must not carry its own copy of the sentence',
    ).toBe(false);
  });

  it('RCLWF-3 — the notice is NOT fenced, and the docblock no longer claims it is', async () => {
    // Behaviour, not spelling: a PARTIAL fault composes both the notice and fenced chunks, and
    // the notice must sit BEFORE (outside) the BEGIN marker. Fencing it reds this.
    const { block } = await composeBorrowedRecallContext(async (_q, onErr) => {
      onErr?.('kb');
      return [{ content: 'owner note', kind: 'memory' as const }];
    }, 'q');
    const begin = block.indexOf('BEGIN UNTRUSTED CONTENT');
    const notice = block.indexOf('this turn is DEGRADED');
    expect(begin, 'the partial case must still fence its chunks').toBeGreaterThan(-1);
    expect(notice, 'the notice must be present').toBeGreaterThan(-1);
    expect(notice, 'the notice must sit OUTSIDE (before) the fence').toBeLessThan(begin);
    // Prose: the claim must not be ASSERTED. It may still appear QUOTED inside a correction
    // note — this repo's convention is "correct, don't rewrite", so the retired sentence is
    // deliberately preserved in the record. A bare `includes` here fired on my own correction
    // note, which is the ratchet-polices-a-spelling trap: assert the claim's STANDING, not the
    // presence of its words.
    const asserted = COMPOSITION.split('CORRECTED')[0] ?? '';
    expect(asserted.includes('Fenced as untrusted-content'), 'the false claim must not stand un-corrected').toBe(false);
    expect(COMPOSITION, 'and the docblock must say WHY fencing it would be wrong').toMatch(/must never follow as instruction|neuter/i);
  });
});
