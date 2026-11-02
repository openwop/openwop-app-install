/**
 * The ADVERT path, end to end, over the REAL vendored `conformance-fixtures/`
 * (suite 2.43.1): the loader in `host/index.ts` loads
 * `conformance-approval-reject-loopback`, and `fixtures[]` must not offer it,
 * because the executor refuses its graph (`cycle_detected`). Its DAG siblings
 * from the same scenario stay advertised. Corpus: suite 2.43.1, openwop#1697.
 *
 * Tracker: TST-CGK-4. Red when `fixtureIsAdvertisable` (host/index.ts) stops
 * withholding a graph `fixtureGraphRefused` rejects, or when the withholding
 * spreads to the DAG siblings (the two positive controls).
 *
 * DEDUPE-NEEDS-HUMAN-ASK (TST-CGK-4b): the negative half is also asserted by
 * conformance-fixture-advert-graph-refused.test.ts case 3 ("over every vendored
 * fixture, the predicate withholds exactly the graphs the executor refuses"), which
 * reds under the same sabotage. The sibling positive controls are unique to this
 * file. Both files are protected advert tests; kept by ruling.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let listLoadedConformanceFixtures: () => readonly string[];

beforeAll(async () => {
  const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
  ensureNodesRegistered();
  ({ listLoadedConformanceFixtures } = await import('../src/host/index.js'));
});

describe('fixtures[] withholds a fixture whose graph the executor refuses', () => {
  it('the vendored loopback fixture is NOT advertised; its DAG siblings still are', () => {
    // Non-vacuity: the file this test is about is really vendored at this pin.
    expect(existsSync(join(import.meta.dirname, '..', '..', '..', 'conformance-fixtures', 'conformance-approval-reject-loopback.json'))).toBe(true);
    const advertised = listLoadedConformanceFixtures();
    expect(advertised).toContain('conformance-approval');
    expect(advertised).toContain('conformance-approval-reject-routed');
    expect(advertised).not.toContain('conformance-approval-reject-loopback');
  });
});
