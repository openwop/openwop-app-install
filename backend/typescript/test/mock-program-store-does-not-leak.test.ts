/**
 * The conformance mock's program store must not leak ACROSS scenarios.
 *
 * WHAT THIS PINS, and why it is not "the reset route returns 200". The store
 * (`dispatchMock.ts`) is module-level, keyed by `nodeId`, with a cursor. Several
 * conformance scenarios deliberately seed programs that return
 * `finishReason: 'length'` to exercise RFC 0033 truncation handling. A program
 * that is not fully drained stays PENDING for the life of the host process — and
 * the out-of-process conformance suite had no way to wipe it, because the seam
 * exposed `programMock` (seed) and nothing for the reset, while
 * `resetMockPrograms`'s own header claimed it was "called between conformance
 * scenarios".
 *
 * The result was a defect that points at the wrong file: a later scenario
 * consumes the leftover truncation entries, its run fails
 * `envelope_truncation_unrecoverable`, and nothing in ITS diff explains it.
 * Measured on `replay-observable-sequence-determinism` — red in-suite, green
 * alone, across five runs on unchanged bases, one red at load1 3.4 on an idle
 * box. It cost a peer two full gate cycles.
 *
 * So the load-bearing case below asserts the LEAK ITSELF: a program seeded and
 * left undrained is still pending afterwards, and is NOT pending once the reset
 * seam has run. Asserting only that the route answers 200 would pass against a
 * route that cleared nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  programMock, resetMockPrograms, hasPendingMockProgram, mockProgramCount,
} from '../src/providers/dispatchMock.js';

const SCENARIO_A_NODE = 'node:envelope-truncation-cap-exhaustion';
const SCENARIO_B_NODE = 'node:replay-observable-sequence-determinism';

beforeEach(() => resetMockPrograms());

describe('the mock program store does not leak across scenarios', () => {
  it('THE leak: an UNDRAINED truncation program stays pending after its scenario', () => {
    // Scenario A seeds three truncated responses and consumes none of them —
    // exactly what happens when a scenario asserts on the first attempt and ends.
    programMock(SCENARIO_A_NODE, [
      { content: '{"partial":', finishReason: 'length' },
      { content: '{"partial":', finishReason: 'length' },
      { content: '{"partial":', finishReason: 'length' },
    ] as never);

    // Scenario A is over. Without a reset the entries are still there, waiting
    // for whoever dispatches on that nodeId next.
    expect(hasPendingMockProgram(SCENARIO_A_NODE), 'this is the leak').toBe(true);
    expect(mockProgramCount()).toBe(1);
  });

  it('the reset seam clears it — and REPORTS what it cleared', () => {
    programMock(SCENARIO_A_NODE, [{ content: '{"partial":', finishReason: 'length' }] as never);
    programMock(SCENARIO_B_NODE, [{ content: '{"ok":true}' }] as never);
    expect(mockProgramCount()).toBe(2);

    // The count is read BEFORE the wipe — a reset that returned nothing would be
    // indistinguishable from a reset that never ran, which is the whole defect.
    const cleared = mockProgramCount();
    resetMockPrograms();

    expect(cleared, 'the seam must be able to say what it removed').toBe(2);
    expect(mockProgramCount()).toBe(0);
    expect(hasPendingMockProgram(SCENARIO_A_NODE)).toBe(false);
    expect(hasPendingMockProgram(SCENARIO_B_NODE)).toBe(false);
  });

  it("a DRAINED program is still cleared — 'consumed' is not 'gone'", () => {
    // The subtle half. `hasPendingMockProgram` goes false once the cursor
    // reaches the end, so a drained program looks harmless — but its ENTRY
    // survives, and a re-seed on the same nodeId is what `programMock` treats as
    // a replacement. A reset that only removed PENDING programs would leave the
    // map growing for the life of the process.
    programMock(SCENARIO_A_NODE, [{ content: '{"ok":true}' }] as never);
    expect(mockProgramCount()).toBe(1);
    resetMockPrograms();
    expect(mockProgramCount(), 'drained entries are removed too').toBe(0);
  });
});
