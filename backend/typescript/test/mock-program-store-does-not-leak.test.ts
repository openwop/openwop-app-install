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
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  dispatchMock, programMock, resetMockPrograms, hasPendingMockProgram, mockProgramCount,
} from '../src/providers/dispatchMock.js';
import { registerTestSeamRoutes } from '../src/routes/testSeam.js';
import { openStorage } from '../src/storage/index.js';

/** The REAL reset seam (`routes/testSeam.ts`), mounted on a bare Express app so
 *  the case drives the route the out-of-process suite calls, not a copy of its
 *  body. The seam is env-gated and refuses an anonymous principal, so this
 *  enables the gate for the mount and stands in an authenticated principal the
 *  way `authMiddleware` would. */
let server: http.Server;
let BASE = '';
const savedSeam = process.env.OPENWOP_TEST_SEAM_ENABLED;
beforeAll(async () => {
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = { principalId: 'seam-probe', tenants: ['default'], token: 'seam-probe' };
    next();
  });
  registerTestSeamRoutes(app, { storage: await openStorage('memory://') });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  if (savedSeam === undefined) delete process.env.OPENWOP_TEST_SEAM_ENABLED; else process.env.OPENWOP_TEST_SEAM_ENABLED = savedSeam;
  await new Promise<void>((res) => server.close(() => res()));
});

const SCENARIO_A_NODE = 'node:envelope-truncation-cap-exhaustion';
const SCENARIO_B_NODE = 'node:replay-observable-sequence-determinism';

beforeEach(() => resetMockPrograms());

describe('the mock program store does not leak across scenarios', () => {
  it('THE leak: an UNDRAINED truncation program stays pending after its scenario', () => {
    // Scenario A seeds three truncated responses and consumes none of them —
    // exactly what happens when a scenario asserts on the first attempt and ends.
    programMock(SCENARIO_A_NODE, [
      { content: '{"partial":', stopReason: 'length' },
      { content: '{"partial":', stopReason: 'length' },
      { content: '{"partial":', stopReason: 'length' },
    ]);

    // Scenario A is over. Without a reset the entries are still there, waiting
    // for whoever dispatches on that nodeId next.
    expect(hasPendingMockProgram(SCENARIO_A_NODE), 'this is the leak').toBe(true);
    expect(mockProgramCount()).toBe(1);
  });

  it('the reset seam clears it — and REPORTS what it cleared', async () => {
    programMock(SCENARIO_A_NODE, [{ content: '{"partial":', stopReason: 'length' }]);
    programMock(SCENARIO_B_NODE, [{ content: '{"ok":true}' }]);
    expect(mockProgramCount()).toBe(2);

    // Through the ROUTE the conformance suite calls. The count must be read
    // BEFORE the wipe — a reset that returned nothing would be indistinguishable
    // from a reset that never ran, which is the whole defect.
    const res = await fetch(`${BASE}/host/openwop-app/test/mock-ai/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json(), 'the seam must be able to say what it removed').toEqual({ ok: true, cleared: 2 });
    expect(mockProgramCount()).toBe(0);
    expect(hasPendingMockProgram(SCENARIO_A_NODE)).toBe(false);
    expect(hasPendingMockProgram(SCENARIO_B_NODE)).toBe(false);
  });

  it("a DRAINED program is still cleared — 'consumed' is not 'gone'", async () => {
    // The subtle half. `hasPendingMockProgram` goes false once the cursor
    // reaches the end, so a drained program looks harmless — but its ENTRY
    // survives, and a re-seed on the same nodeId is what `programMock` treats as
    // a replacement. A reset that only removed PENDING programs would leave the
    // map growing for the life of the process.
    programMock(SCENARIO_A_NODE, [{ content: '{"ok":true}' }]);
    // DRAIN it — consume the one entry, so the program is no longer pending but
    // its entry is still in the map. (The first version of this case never
    // dispatched, so the program was still PENDING and a pending-only reset
    // passed it.)
    await dispatchMock({ provider: 'mock', model: 'mock-mini', apiKey: '', messages: [{ role: 'user', content: 'x' }], nodeId: SCENARIO_A_NODE });
    expect(hasPendingMockProgram(SCENARIO_A_NODE), 'precondition: the program is drained').toBe(false);
    expect(mockProgramCount(), 'precondition: the drained entry survives').toBe(1);
    resetMockPrograms();
    expect(mockProgramCount(), 'drained entries are removed too').toBe(0);
  });
});
