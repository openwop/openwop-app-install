/**
 * ADR 0525 — `core.web.search` honours `maxResults` from config OR inputs.
 *
 * THE LIVE DEFECT this pins: the node read `config.maxResults` only, while its
 * sibling `suitability` reads config-or-inputs THIRTEEN LINES BELOW in the same
 * function (ADR 0502 fixed that one and left this one). Chain packs
 * overwhelmingly author node parameters under `inputs`, so
 * `kicktodo.research` and `openwop-app.kicktodo.challenge-factory` both asked
 * for 8 results and silently ran at the default 5 — no error, no UI anywhere
 * showing the effective cap, just three fewer citations than the author
 * intended.
 *
 * WHY THIS FILE EXISTS SEPARATELY: emptying the `chain-node-undeclared-keys`
 * baseline is a SCHEMA ratchet — it proves the key is declared, not that the
 * node reads it. A code review pointed out the behaviour fix had no guard at
 * all, which is how it would silently regress.
 */
import { describe, expect, it } from 'vitest';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';

ensureNodesRegistered();
const node = getNodeRegistry().get('core.web.search');

/** Capture what the node asks the research surface for. */
function probe(config: Record<string, unknown>, inputs: Record<string, unknown>) {
  const asked: { query?: string; maxResults?: number; suitability?: string }[] = [];
  const ctx = {
    config,
    inputs,
    webResearch: {
      // Mirrors the REAL call shape `{ query, maxResults, suitability }`. The
      // first version of this stub omitted `query` and the test still passed,
      // because `execute(ctx as never)` disabled every structural check — a stub
      // free to drift from the thing it stands in for proves nothing about it.
      search: async (req: { query: string; maxResults: number; suitability: string }) => {
        asked.push({ query: req.query, maxResults: req.maxResults, suitability: req.suitability });
        return { results: [], engine: 'test', totalResults: 0 };
      },
    },
  };
  return { ctx, asked };
}

describe('core.web.search maxResults', () => {
  it('fixture guard: the node is registered and reachable', () => {
    // Without this the assertions below would silently not run at all.
    expect(node, 'core.web.search is not in the registry — nothing is being tested').toBeDefined();
  });

  it('honours `config.maxResults` (the path that always worked)', async () => {
    const { ctx, asked } = probe({ maxResults: 8 }, { query: 'q' });
    await node!.execute(ctx as unknown as Parameters<NonNullable<typeof node>['execute']>[0]);
    expect(asked[0]?.maxResults).toBe(8);
  });

  it('honours `inputs.maxResults` — THE LIVE DEFECT', async () => {
    // Two shipped chains ask this way and ran at 5.
    const { ctx, asked } = probe({}, { query: 'q', maxResults: 8 });
    await node!.execute(ctx as unknown as Parameters<NonNullable<typeof node>['execute']>[0]);
    expect(asked[0]?.maxResults, 'a chain asking via inputs is still silently capped at the default').toBe(8);
  });

  it('config WINS when both are set', async () => {
    const { ctx, asked } = probe({ maxResults: 3 }, { query: 'q', maxResults: 9 });
    await node!.execute(ctx as unknown as Parameters<NonNullable<typeof node>['execute']>[0]);
    expect(asked[0]?.maxResults).toBe(3);
  });

  it('falls back to the default when neither is set', async () => {
    const { ctx, asked } = probe({}, { query: 'q' });
    await node!.execute(ctx as unknown as Parameters<NonNullable<typeof node>['execute']>[0]);
    expect(asked[0]?.maxResults).toBe(5);
  });

  it('clamps an absurd request rather than forwarding it', async () => {
    const { ctx, asked } = probe({}, { query: 'q', maxResults: 5000 });
    await node!.execute(ctx as unknown as Parameters<NonNullable<typeof node>['execute']>[0]);
    expect(asked[0]?.maxResults).toBe(50);
  });

  it('accepts a NUMERIC STRING — a filled {{params.n}} arrives as one', async () => {
    // `chainPackManifest` declares exported params `type: 'string'` and embedded
    // tokens coerce to string, so an author who correctly fills in 8 delivers
    // '8'. A number-only guard discarded that back to 5 — the same silent loss,
    // one layer along.
    const { ctx, asked } = probe({}, { query: 'q', maxResults: '8' });
    await node!.execute(ctx as unknown as Parameters<NonNullable<typeof node>['execute']>[0]);
    expect(asked[0]?.maxResults, "a correctly-filled numeric token was discarded").toBe(8);
  });

  it('forwards the query the node resolved', async () => {
    // Pins the stub against the real call shape, so it cannot silently drift.
    const { ctx, asked } = probe({}, { query: 'hello' });
    await node!.execute(ctx as unknown as Parameters<NonNullable<typeof node>['execute']>[0]);
    expect(asked[0]?.query).toBe('hello');
  });

  it('ignores a non-numeric value rather than trusting it', async () => {
    // A `{{params.n}}` that never got a value freezes to a STRING, which is not
    // nullish — so it must not shadow a valid sibling or reach the surface.
    const { ctx, asked } = probe({ maxResults: '' }, { query: 'q', maxResults: 8 });
    await node!.execute(ctx as unknown as Parameters<NonNullable<typeof node>['execute']>[0]);
    expect(asked[0]?.maxResults, 'an empty frozen token shadowed a real value').toBe(8);
  });
});
