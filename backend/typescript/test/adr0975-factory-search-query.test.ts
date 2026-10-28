/**
 * ADR 0975 D3 — the Challenge Factory searches with a query built from the
 * candidate, not its bare title.
 *
 * MEASURED on kicktodo.com (2026-10-25): the chain searched `{{params.topic}}`
 * verbatim; "The Daily Walk" returned only Bible-reading plans of that name, the
 * claim extractor (correctly) found nothing to support, and the run failed.
 *
 * Pins `frameSearchQuery` (deterministic, model-free, transformation then audience
 * as the disambiguator, capped at a word boundary) and the wiring in BOTH chains
 * that research a candidate: the search node takes no declared `query` (declared
 * inputs override edge-derived ones, so a leftover `{{params.topic}}` would win
 * silently), its query arrives on the research-frame's `searchQuery` port, and
 * `maxResults` sits in `config`, where `core.web.search` reads it.
 *
 * Red when (sabotage-witnessed): the query drops the transformation or the
 * audience fallback; the cap cuts mid-word or is removed; either chain puts
 * `query: "{{params.topic}}"` back, reverts the port edge to a bare edge, or
 * leaves `maxResults` in `inputs`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameSearchQuery, SEARCH_QUERY_MAX } from '../src/features/kicktodo-creator/surface.js';

const TAIL = ' — research evidence and practical guidance';

describe('ADR 0975 D3 — frameSearchQuery', () => {
  it('the transformation disambiguates the title (the kicktodo.com failure)', () => {
    expect(frameSearchQuery('The Daily Walk', 'adults', 'from rarely walking on purpose to a steady daily walk'))
      .toBe(`The Daily Walk: from rarely walking on purpose to a steady daily walk${TAIL}`);
  });

  it('falls back to the audience when there is no transformation, and to the title alone when there is neither', () => {
    expect(frameSearchQuery('The Daily Walk', 'busy adults new to walking', '  ')).toBe(`The Daily Walk: busy adults new to walking${TAIL}`);
    expect(frameSearchQuery('The Daily Walk', '', '')).toBe(`The Daily Walk${TAIL}`);
  });

  it('collapses whitespace and caps a long brief at a word boundary', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join('\n  ');
    const q = frameSearchQuery('Topic', '', long);
    expect(q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
    expect(q.endsWith(TAIL)).toBe(true);
    const body = q.slice(0, -TAIL.length);
    expect(body).not.toMatch(/\s{2,}|\n/);
    // Every kept token is a whole token of the source.
    for (const tok of body.replace(/^Topic: /, '').split(' ')) expect(tok).toMatch(/^word\d+$/);
  });

  it('is deterministic (no clock, no randomness): same inputs, same query', () => {
    expect(frameSearchQuery('A', 'b', 'c')).toBe(frameSearchQuery('A', 'b', 'c'));
  });
});

type Node = { id: string; typeId: string; inputs?: Record<string, unknown>; config?: Record<string, unknown> };
type Edge = { from: string; to: string };
const chainOf = (pack: string) => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'examples', 'workflow-chain-packs', pack, 'pack.json'), 'utf8')) as { chains: { dag: { nodes: Node[]; edges: Edge[] } }[] };
  return raw.chains[0]!.dag;
};

describe.each([
  ['kicktodo-challenge-factory', 'research-frame'],
  ['kicktodo-research', 'frame'],
])('ADR 0975 D3 — %s wires the research query into the search', (pack, frameId) => {
  const dag = chainOf(pack);
  const frame = dag.nodes.find((n) => n.id === frameId)!;
  const search = dag.nodes.find((n) => n.typeId.startsWith('core.web.search@'))!;

  it('the research-frame is the 1.1.0 node (the one that emits searchQuery) and receives the transformation', () => {
    expect(frame.typeId).toBe('feature.kicktodo.nodes.research-frame@1.1.0');
    expect(frame.inputs).toMatchObject({ transformation: '{{params.transformation}}' });
  });

  it('the search declares no query of its own and takes it on the searchQuery port', () => {
    expect(search.inputs ?? {}).not.toHaveProperty('query');
    expect(dag.edges).toContainEqual(expect.objectContaining({ from: `${frameId}.searchQuery`, to: `${search.id}.query` }));
    expect(dag.edges.filter((e) => e.from === frameId && e.to === search.id)).toEqual([]);
  });

  it('maxResults is in config, where core.web.search reads it', () => {
    expect(search.config).toMatchObject({ maxResults: 8 });
    expect(search.inputs ?? {}).not.toHaveProperty('maxResults');
  });
});
