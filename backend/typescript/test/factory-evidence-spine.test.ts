/**
 * ADR 0494 P2 — the Challenge Factory's evidence spine must actually GROUND.
 *
 * Before this, the spine was `search → normalize → evidence-graph`: it recorded
 * source URLs and titles and nothing else. `claims` was never wired, so the dossier
 * carried ZERO claims, `unsupportedClaimIds` was always empty, and `plan-generate`
 * was instructed to "ground every claim ONLY in the provided evidence" while its
 * evidence summary read, literally, "no source-supported claims recorded". The
 * flagship plan was ungrounded while claiming to be grounded.
 *
 * The spine now fetches content and extracts cited claims from it. These assertions
 * are about WIRING, which is where this class of defect hides: the code was all
 * correct, it simply was not connected.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  _resetChainRegistryForTest,
  getChain,
  expandChain,
} from '../src/host/workflowChainPackLoader.js';

const FACTORY = 'openwop-app.kicktodo.challenge-factory';

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
});

function factoryDef() {
  const entry = getChain(FACTORY);
  expect(entry, `${FACTORY} must be loaded`).toBeDefined();
  return expandChain(entry!.chain, { deferred: true });
}

/** `a.port -> b.port` for every edge into `target`. */
function edgesInto(def: ReturnType<typeof factoryDef>, target: string): string[] {
  return (def.edges ?? [])
    .filter((e) => e.targetNodeId.endsWith(target))
    .map((e) => `${e.sourceNodeId.replace(/^.*_/, '')}${e.sourceOutput ? '.' + e.sourceOutput : ''}`
      + ` -> ${e.targetNodeId.replace(/^.*_/, '')}${e.targetInput ? '.' + e.targetInput : ''}`)
    .sort();
}

describe('Challenge Factory evidence spine', () => {
  it('READS the sources it found — a fetch step exists', () => {
    const def = factoryDef();
    const typeIds = def.nodes.map((n) => n.typeId);
    expect(typeIds).toContain('core.web.search');
    expect(typeIds, 'the spine must FETCH content, not just list URLs').toContain('core.web.fetch');
  });

  it('EXTRACTS claims from that content', () => {
    expect(factoryDef().nodes.map((n) => n.typeId))
      .toContain('feature.kicktodo.nodes.claim-extract');
  });

  it('THE FIX — evidence-graph receives CLAIMS, not just sources', () => {
    // The defect in one assertion: `claims` had no inbound edge, so `recordResearch`
    // always got `[]`.
    const into = edgesInto(factoryDef(), 'evidence-graph');
    expect(into.some((e) => e.endsWith('evidence-graph.claims')), `evidence-graph inbound: ${JSON.stringify(into)}`).toBe(true);
    expect(into.some((e) => e.endsWith('evidence-graph.sources'))).toBe(true);
    expect(into.some((e) => e.endsWith('evidence-graph.questions'))).toBe(true);
  });

  it('claim-extract receives BOTH the sources and the fetched pages', () => {
    // It joins content to recorded sources by url; either half alone is useless.
    const into = edgesInto(factoryDef(), 'extract-claims');
    expect(into.some((e) => e.endsWith('extract-claims.sources'))).toBe(true);
    expect(into.some((e) => e.endsWith('extract-claims.pages'))).toBe(true);
  });

  it('every CONCURRENT fan-in names an explicit PORT (or inputs clobber each other)', () => {
    // `buildNodeInputs` keys by `targetInput ?? "input"`, so two unported parents
    // both write `input` and the second wins — silently dropping one parent's
    // output.
    //
    // Scoped to the evidence spine on purpose. Elsewhere the chain fans in from
    // MUTUALLY EXCLUSIVE branches (`fail-N`/`gate-N` → `decompose`), where the
    // scheduler skips edges whose source never completed, so exactly one parent
    // contributes and unported edges are correct. The distinction is concurrency,
    // not arity — asserting it chain-wide would flag correct pre-existing edges.
    const def = factoryDef();
    expect(def.edges, 'the expanded factory must have edges').toBeDefined();
    const concurrentFanIn = ['extract-claims', 'evidence-graph'];
    for (const e of def.edges ?? []) {
      if (!concurrentFanIn.some((n) => e.targetNodeId.endsWith(n))) continue;
      expect(
        e.targetInput,
        `edge ${e.sourceNodeId} -> ${e.targetNodeId} feeds a CONCURRENT fan-in but names no targetInput, so it would clobber a sibling edge`,
      ).toBeTruthy();
    }
  });

  it('search still feeds normalize directly (fetch is a FAN-OUT, not an insert)', () => {
    // Putting fetch BETWEEN search and normalize would starve normalize of
    // `results`/`engine` — outputs flow along edges, so a serial insert changes
    // what the downstream node receives.
    const into = edgesInto(factoryDef(), 'normalize');
    expect(into.some((e) => e.startsWith('search'))).toBe(true);
  });
});
