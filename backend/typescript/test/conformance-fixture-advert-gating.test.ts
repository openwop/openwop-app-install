/**
 * The conformance-fixture advert must not promise fixtures this host cannot run.
 *
 * A fixture whose graph references a `core.conformance.*` node is only runnable
 * when those nodes are registered (`conformanceNodesEnabled()` — deliberately OFF
 * in the auth deploy posture). Advertising it anyway has a nasty failure mode:
 * the suite's outer `isFixtureAdvertised` gate passes, the scenario runs, the run
 * fails because the typeId does not resolve, and a **correctly configured
 * production host is reported non-conformant for a fixture it never offered**.
 *
 * That is the mirror image of the advertise-and-skip problem the corpus already
 * guards: advertise-and-spuriously-fail. Both are dishonest adverts.
 *
 * Found while reviewing RFC 0140's `conformance-replay-side-effect`, which added
 * a fresh instance; the pre-existing `core.conformance.mock-agent` fixtures had
 * it already and are covered by the same predicate.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// WS0: the advert now asks the node REGISTRY whether each fixture's typeIds
// resolve, so every block below needs the real registrations — the same
// `ensureNodesRegistered()` boot runs. Registered once, with the conformance
// nodes ON: registration is a boot snapshot, and the env-flip legs below
// exercise the per-call posture predicate on top of it.
beforeAll(async () => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
  const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
  ensureNodesRegistered();
});

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', '..', 'conformance-fixtures');

interface FixtureDoc { id?: string; nodes?: { typeId?: string; config?: Record<string, unknown> }[] }

function fixtures(): Array<{ file: string; doc: FixtureDoc }> {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, doc: JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as FixtureDoc }));
}

/** The same predicate `host/index.ts` uses — kept here as an independent restatement
 *  so a change to one without the other is visible.
 *
 *  H21 added a second clause for the pre-rewrite spelling (`core.ai.callPrompt`
 *  carrying `config.mcp`), because the host applied its predicate AFTER the
 *  loader rewrote that node. H47 deleted the rewrite — the corpus renamed the
 *  node to `core.conformance.mcp-invoke` at suite 1.136.0 and the fixture is
 *  re-vendored — so the restatement is back to the bare prefix, matching the
 *  host again.
 *
 *  H48: BOTH prefixes, because `registerConformanceNodes()` has always
 *  registered five typeIds under the BARE `conformance.` prefix, which
 *  `core.conformance.` does not match. This restatement carried the same hole as
 *  the host, which is exactly the failure an "independent restatement" is
 *  supposed to prevent — it was copied from the host rather than derived from
 *  the registration, so it agreed with the bug. The non-vacuity test below now
 *  derives the expected set from `bootstrap/nodes.ts` itself. */
const needsConformanceNodes = (d: FixtureDoc): boolean =>
  (d.nodes ?? []).some(
    (n) => (n.typeId ?? '').startsWith('core.conformance.') || (n.typeId ?? '').startsWith('conformance.'),
  );

describe('conformance fixture advert — gated on the nodes actually being registered', () => {
  it('fixture corpus is non-empty (else every assertion below is vacuous)', () => {
    expect(fixtures().length).toBeGreaterThan(10);
  });

  it('at least one fixture DOES need conformance nodes — the gate has a subject', () => {
    // Without this, the filter could be a no-op and the suite would still pass.
    const needing = fixtures().filter(({ doc }) => needsConformanceNodes(doc));
    expect(needing.length).toBeGreaterThan(0);
    // RFC 0140's fixture is one of them.
    expect(needing.some(({ file }) => file === 'conformance-replay-side-effect.json')).toBe(true);
    // H21/H47: and so is the MCP roundtrip fixture — via the loader rewrite
    // under H21, and now directly, because the corpus renamed its node to
    // `core.conformance.mcp-invoke` (suite 1.136.0, S33) and the fixture is
    // re-vendored at that pin. Before H21 it was advertised unconditionally and
    // its only node (`core.ai.callPrompt` with `config.mcp`) resolved to a
    // prompt-library node that fails `prompt_not_found` —
    // advertise-and-spuriously-fail.
    expect(needing.some(({ file }) => file === 'conformance-mcp-tool-roundtrip.json')).toBe(true);
    // H47: the A2A roundtrip fixture had the same shape under the deleted
    // `core.a2a.invoke` alias, and is likewise covered by the bare prefix now.
    expect(needing.some(({ file }) => file === 'conformance-a2a-task-roundtrip.json')).toBe(true);
  });

  it('the advert INCLUDES conformance-node fixtures when the nodes are enabled', async () => {
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
    const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
    const listed = listLoadedConformanceFixtures();
    expect(listed).toContain('conformance-replay-side-effect');
    expect(listed).toContain('conformance-mcp-tool-roundtrip');
  });

  it('the advert EXCLUDES them when the nodes are disabled — the load-bearing case', async () => {
    // NOTE: this must FLIP the gate itself. An earlier cut of this test read the
    // ambient value and early-returned when nodes were enabled — which, since the
    // previous test sets the env to 'true', made it vacuous. `conformanceNodesEnabled()`
    // re-reads process.env per call and `listLoadedConformanceFixtures()` re-evaluates
    // per call, so flipping it here is sound.
    const prev = process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
    try {
      const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
      const listed = new Set(listLoadedConformanceFixtures());

      const promisedButUnrunnable = fixtures()
        .filter(({ doc }) => needsConformanceNodes(doc))
        .map(({ doc, file }) => doc.id ?? file.replace(/\.json$/, ''))
        .filter((id) => listed.has(id));

      expect(
        promisedButUnrunnable,
        'advertised but references core.conformance.* nodes this host has not registered — a conformance run would fail them spuriously',
      ).toEqual([]);

      // And the advert is not simply empty — ordinary fixtures survive the filter.
      expect(listed.size).toBeGreaterThan(10);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
      else process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = prev;
    }
  });
});

/**
 * H48 — the predicate must cover EVERY typeId `conformanceNodesEnabled()` gates,
 * not just the ones spelled `core.conformance.*`.
 *
 * `registerConformanceNodes()` registers five typeIds under the BARE
 * `conformance.` prefix. Six vendored fixtures depend on them — four CANONICAL
 * corpus ones (`conformance-capability-missing`,
 * `conformance-model-capability-insufficient`, `openwop-smoke-byok-roundtrip`,
 * `openwop-smoke-cost-emit`) plus the two host-authored
 * `conformance-replay-effect*` — and all six were advertised unconditionally.
 * A host with conformance nodes OFF (the production/auth deploy posture the
 * predicate exists to protect) therefore advertised six fixtures whose only real
 * node is unregistered.
 *
 * The expected set is DERIVED by reading the registration source rather than
 * restated, because a restatement is what failed: the old test carried the same
 * `core.conformance.`-only hole as the host and agreed with the bug for as long
 * as it existed.
 */
describe('conformance fixture advert — covers BOTH conformance typeId prefixes (H48)', () => {
  /** Every typeId registered inside `registerConformanceNodes()`, read from source. */
  function gatedTypeIds(): string[] {
    const src = readFileSync(join(__dirname, '..', 'src', 'bootstrap', 'nodes.ts'), 'utf8');
    const start = src.indexOf('function registerConformanceNodes');
    expect(start, 'registerConformanceNodes() not found — this test cannot verify anything').toBeGreaterThan(-1);
    // The function runs to the next top-level `\n}` after its opening.
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    return [...body.matchAll(/typeId: '([^']+)'/g)].map((m) => m[1]!).sort();
  }

  it('the gated registration really does use a bare conformance.* prefix', () => {
    // Non-vacuity + the premise of the whole block. If this ever returns only
    // `core.conformance.*` ids, the widened predicate is dead weight and should
    // be narrowed again — deliberately, not by drift.
    const ids = gatedTypeIds();
    expect(ids.length, 'no conformance typeIds parsed — the source shape changed').toBeGreaterThanOrEqual(5);
    expect(ids.some((t) => t.startsWith('conformance.') && !t.startsWith('core.conformance.'))).toBe(true);
    expect(ids).toContain('conformance.effect.emit');
  });

  it('the host predicate catches EVERY gated typeId — no spelling escapes it', async () => {
    const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
    const gated = new Set(gatedTypeIds());

    const prev = process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
    try {
      const listed = new Set(listLoadedConformanceFixtures());
      const leaked = fixtures()
        .filter(({ doc }) => (doc.nodes ?? []).some((n) => gated.has(n.typeId ?? '')))
        .map(({ doc, file }) => doc.id ?? file.replace(/\.json$/, ''))
        .filter((id) => listed.has(id));

      expect(
        leaked,
        'advertised with conformance nodes OFF while depending on a typeId that registration gates — the run would fail at dispatch on a correctly-configured production host',
      ).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
      else process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = prev;
    }
  });

  it('the six bare-prefix fixtures ARE advertised again once the nodes are enabled', async () => {
    // The filter must be conditional, not a blanket exclusion: with the nodes
    // registered these fixtures are genuinely runnable and the suite needs them.
    const prev = process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
    try {
      const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
      const listed = new Set(listLoadedConformanceFixtures());
      for (const id of [
        'conformance-capability-missing',
        'conformance-model-capability-insufficient',
        'openwop-smoke-byok-roundtrip',
        'openwop-smoke-cost-emit',
        'conformance-replay-effect',
        'conformance-replay-effect-unreached',
      ]) {
        expect(listed.has(id), `${id} must be advertised when its node IS registered`).toBe(true);
      }
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
      else process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = prev;
    }
  });
});

/**
 * H49 — the SECOND route to the same dishonest advert, and the one that is
 * quieter.
 *
 * The corpus expresses its memory scenarios as a `core.identity` node carrying
 * `config.memoryAction`, not as a dedicated typeId. So an unimplemented action
 * does not fail to RESOLVE — the node runs as a pass-through, the run reaches
 * `completed`, and the variable bag stays empty. `isFixtureAdvertised` passes
 * and the scenario fails a host that could start the fixture but not execute it.
 *
 * The invariant these tests hold is "advertised ⟺ EXECUTABLE", in BOTH
 * directions and under BOTH deploy postures. Both directions matter: gating too
 * little advertises what cannot run (the H48 finding); gating too much hides a
 * fixture the host now genuinely drives, which would silently un-measure the
 * seam H49 built.
 *
 * The implemented-action set is imported from the handler map rather than
 * restated here. A restatement copied from the implementation agrees with the
 * bug for as long as the bug exists — that is precisely how H48's bare-prefix
 * hole survived in the predicate above for as long as it did.
 */
describe('conformance fixture advert — memoryAction is gated on the DRIVER, not on a hand-kept list (H49)', () => {
  const memoryActionsOf = (d: FixtureDoc): string[] =>
    (d.nodes ?? [])
      .map((n) => n.config?.['memoryAction'])
      .filter((a): a is string => typeof a === 'string');

  const needsMemoryAction = (d: FixtureDoc): boolean => memoryActionsOf(d).length > 0;

  it('at least five fixtures DO declare a memoryAction — the gate has a subject', () => {
    // Non-vacuity. Without this the filter could be a permanent no-op and every
    // assertion below would pass for the wrong reason.
    const needing = fixtures().filter(({ doc }) => needsMemoryAction(doc));
    expect(needing.map(({ file }) => file).sort()).toContain('conformance-agent-memory-injection-budget.json');
    expect(needing.length, 'the five vendored memory-probe fixtures').toBeGreaterThanOrEqual(5);
  });

  it('every action the vendored fixtures declare HAS a handler — derived from the map, not restated', async () => {
    const { MEMORY_PROBE_ACTIONS } = await import('../src/bootstrap/conformanceMemoryProbe.js');
    const declared = new Set(fixtures().flatMap(({ doc }) => memoryActionsOf(doc)));
    expect(declared.size).toBeGreaterThanOrEqual(5);
    const unhandled = [...declared].filter((a) => !MEMORY_PROBE_ACTIONS.has(a)).sort();
    expect(unhandled, 'a vendored memoryAction with no handler must not exist silently').toEqual([]);
  });

  it('with the driver ENABLED, every memoryAction fixture IS advertised', async () => {
    // The direction H48 could not assert (its set was deliberately empty). This
    // is what proves H49 actually turned the advert back on rather than leaving
    // five fixtures permanently filtered.
    const prev = process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
    try {
      const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
      const listed = new Set(listLoadedConformanceFixtures());
      const missing = fixtures()
        .filter(({ doc }) => needsMemoryAction(doc))
        .map(({ doc, file }) => doc.id ?? file.replace(/\.json$/, ''))
        .filter((id) => !listed.has(id));
      expect(
        missing,
        'the host drives every declared memoryAction, so none of these fixtures may be filtered out — filtering them would un-measure the seam',
      ).toEqual([]);
      expect(listed.has('conformance-agent-memory-injection-budget')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
      else process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = prev;
    }
  });

  it('with the driver DISABLED, NO memoryAction fixture is advertised', async () => {
    // The posture the whole gate exists for. `identityNode` only delegates when
    // `conformanceNodesEnabled()`, so with the switch off the probe is inert and
    // the fixtures MUST leave the advert with it — otherwise a production host
    // advertises five fixtures whose node is a pass-through. A gate that is only
    // ever exercised in one posture is half-tested.
    const prev = process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
    try {
      const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
      const listed = new Set(listLoadedConformanceFixtures());
      const promisedButInert = fixtures()
        .filter(({ doc }) => needsMemoryAction(doc))
        .map(({ doc, file }) => doc.id ?? file.replace(/\.json$/, ''))
        .filter((id) => listed.has(id));
      expect(
        promisedButInert,
        'advertised while the probe is inert — the run would complete having done nothing and the scenario would fail on an empty variable bag',
      ).toEqual([]);
      // ...and the advert is not simply empty.
      expect(listed.size).toBeGreaterThan(10);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
      else process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = prev;
    }
  });

  it('the fixture is VENDORED as well as advertised — parity and advert stay independent (H48)', async () => {
    // H48 added this while the advert was deliberately NARROWER than the tree; it
    // asserted the fixture was vendored but NOT advertised. H49 supplied the
    // driver, so the advert caught up and that half is now false — folded into
    // the driver-ENABLED case above rather than deleted. The surviving half still
    // matters: the tree stays at parity with the pinned suite
    // (scripts/check-vendored-fixtures.mjs) while the ADVERT is filtered
    // separately, so a future author "fixing" an advert problem by DELETING the
    // fixture would red the parity guard — which is the correct outcome.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(FIXTURE_DIR, 'conformance-agent-memory-injection-budget.json'))).toBe(true);
  });
});

/**
 * WS0 (2026-09-24) — the structural rule: advertised ⟹ every node typeId the
 * fixture (and every child fixture it runs) names RESOLVES in the executor's
 * registry. The prefix and memoryAction predicates each guard one spelling of
 * the hazard; this ratchet is over ALL vendored fixtures and every typeId, so a
 * newly vendored fixture naming a node this host never registered cannot enter
 * `fixtures[]` — `conformance-artifact-emit` had, and was a live false claim.
 *
 * The expected set is computed from the REGISTRY, not restated: a hand-kept
 * list of "known unregistered" ids is exactly the second source of truth H48
 * warns about.
 */
describe('conformance fixture advert — every advertised fixture\'s nodes RESOLVE (WS0 ratchet)', () => {
  it('no advertised fixture names a typeId the executor could not resolve', async () => {
    const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
    const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const registry = getNodeRegistry();
    const byId = new Map(fixtures().map(({ doc, file }) => [doc.id ?? file.replace(/\.json$/, ''), doc]));
    const listed = listLoadedConformanceFixtures();
    expect(listed.length, 'the advert must not be empty — else this ratchet is vacuous').toBeGreaterThan(10);
    const offenders = listed.flatMap((id) =>
      (byId.get(id)?.nodes ?? [])
        .map((n) => n.typeId ?? '')
        .filter((t) => !registry.isResolvable(t))
        .map((t) => `${id} → ${t}`),
    );
    expect(offenders, 'advertised, but the executor would fail `node module not registered`').toEqual([]);
  });

  it('the ratchet has a subject: vendored fixtures DO name unresolvable nodes, and they are withheld', async () => {
    const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
    const listed = new Set(listLoadedConformanceFixtures());
    // The live false claim WS0 closed: its node is registered nowhere in this host.
    expect(listed.has('conformance-wasm-pack-roundtrip')).toBe(false);
    // `conformance-artifact-emit` WAS the other subject here; WS3 (ADR 0746)
    // registered `conformance.artifact.emit`, so it flipped to its honest state —
    // advertised — exactly as this leg said it would.
    expect(listed.has('conformance-artifact-emit')).toBe(true);
    // ...while fixtures whose nodes resolve stay advertised (not a blanket cut).
    expect(listed.has('conformance-replay-side-effect')).toBe(true);
  });

  it('a fixture whose CHILD fixture is withheld is withheld with it', async () => {
    const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
    const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const registry = getNodeRegistry();
    // Every parent that runs a child fixture is advertised only alongside it.
    const listed = new Set(listLoadedConformanceFixtures());
    const parents = fixtures().filter(({ doc }) =>
      (doc.nodes ?? []).some((n) => typeof n.config?.['workflowId'] === 'string'),
    );
    expect(parents.length, 'sub-workflow fixtures exist — the closure has a subject').toBeGreaterThan(0);
    for (const { doc, file } of parents) {
      const id = doc.id ?? file.replace(/\.json$/, '');
      if (!listed.has(id)) continue;
      for (const n of doc.nodes ?? []) {
        const child = n.config?.['workflowId'];
        if (typeof child === 'string' && fixtures().some(({ doc: d }) => d.id === child)) {
          expect(listed.has(child), `${id} is advertised but its child ${child} is not`).toBe(true);
        }
      }
    }
    // Sanity: the closure is not reached by accident — the registry resolves core.subWorkflow.
    expect(registry.isResolvable('core.subWorkflow')).toBe(true);
  });
});
