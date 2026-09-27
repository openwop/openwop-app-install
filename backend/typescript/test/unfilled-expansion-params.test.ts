/**
 * ADR 0504 — a workflow instantiated without values for its template's required
 * params refuses AT RUN START, naming the parameter.
 *
 * The live reproduction (prod rev 00581-2nl, 2026-07-29): POSTing
 * `…/workflows/from-chain` for the Challenge Factory with no `params` returned
 * 201 and persisted an owned, gallery-visible workflow whose search node had no
 * `query` at all. Every run of it failed with
 *
 *     core.web.search requires a non-empty `query` input
 *
 * — an error naming an internal node, never the missing parameter. Two such
 * dead workflows were minted before the cause was found.
 *
 * Why the key VANISHES rather than staying visibly empty: `resolveTokenString`
 * returns `bag[NAME]` for a whole-value token, so an absent param freezes to
 * `undefined` and JSON drops the key. Inspecting the minted node cannot tell
 * that from a key the author never wrote — which is exactly why the ADR 0498
 * check (which reads the minted `config`) logged nothing for this.
 *
 * Minting still SUCCEEDS on purpose: "Use template = just copy" is a documented
 * contract and the ADR 0498 enforcement revert established that refusing at mint
 * time breaks it. The block lands at run start and lifts as soon as the value is
 * filled in.
 */

import { describe, expect, it } from 'vitest';
import { expandChain, findUnfilledExpansionParams } from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const chain = {
  chainId: 'test.unfilled',
  version: '1.0.0',
  label: 'Unfilled',
  description: 'A chain whose search node takes its query from a required param.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { topic: { type: 'string' }, note: { type: 'string' } },
    required: ['topic'],
  },
  dag: {
    nodes: [
      { id: 'search', typeId: 'core.web.search', inputs: { query: '{{params.topic}}', maxResults: 8 } },
      { id: 'sink', typeId: 'core.noop', config: { label: 'plain' } },
    ],
    edges: [{ from: 'search', to: 'sink' }],
  },
} as unknown as Parameters<typeof expandChain>[0];

const expand = (params: Record<string, unknown>) =>
  expandChain(chain, { params }) as unknown as WorkflowDefinition;

describe('an unfrozen param is recorded at expansion', () => {
  it('records the param when it is absent — the minted value is undefined, and persistence then drops the key', () => {
    const def = expand({});
    const search = def.nodes.find((n) => n.typeId === 'core.web.search')!;
    // The defect's fingerprint. In memory the key survives holding `undefined`;
    // JSON.stringify then removes it, so what actually reaches storage — and
    // what the ADR 0498 check later inspects — has no `query` at all. Both
    // states read as "missing", which is why inspecting the minted node cannot
    // distinguish this from a key the author simply never wrote.
    expect(search.inputs!.query).toBeUndefined();
    expect(JSON.parse(JSON.stringify(search)).inputs).not.toHaveProperty('query');
    expect((def.metadata as { unresolvedParams?: unknown }).unresolvedParams).toEqual([
      { nodeId: search.nodeId, key: 'query', param: 'topic' },
    ]);
  });

  it('records NOTHING when every param is supplied', () => {
    const def = expand({ topic: 'walking 20 minutes a day' });
    expect((def.metadata as { unresolvedParams?: unknown }).unresolvedParams).toBeUndefined();
    const search = def.nodes.find((n) => n.typeId === 'core.web.search')!;
    expect(search.inputs!.query).toBe('walking 20 minutes a day');
  });

  it('does not record a literal that merely looks unset', () => {
    // `config.label` is an authored literal, not a param token — never a finding.
    const def = expand({ topic: 't' });
    const recorded = (def.metadata as { unresolvedParams?: unknown[] }).unresolvedParams ?? [];
    expect(recorded).toHaveLength(0);
  });
});

describe('run start re-checks the LIVE node, not the record', () => {
  it('blocks while the value is still missing, naming the PARAM not the node', () => {
    const def = expand({});
    const unfilled = findUnfilledExpansionParams(def);
    expect(unfilled).toHaveLength(1);
    expect(unfilled[0]!.param).toBe('topic');
  });

  it('CLEARS once the value is filled in the builder — a stale record must not block', () => {
    const def = expand({});
    const filled: WorkflowDefinition = {
      ...def,
      nodes: def.nodes.map((n) =>
        n.typeId === 'core.web.search' ? { ...n, inputs: { ...n.inputs, query: 'filled in by hand' } } : n,
      ),
    };
    // metadata.unresolvedParams is UNCHANGED — the record is history, not state.
    expect((filled.metadata as { unresolvedParams?: unknown[] }).unresolvedParams).toHaveLength(1);
    expect(findUnfilledExpansionParams(filled)).toHaveLength(0);
  });

  it('treats an empty string as still unfilled', () => {
    const def = expand({});
    const blanked: WorkflowDefinition = {
      ...def,
      nodes: def.nodes.map((n) =>
        n.typeId === 'core.web.search' ? { ...n, inputs: { ...n.inputs, query: '' } } : n,
      ),
    };
    expect(findUnfilledExpansionParams(blanked)).toHaveLength(1);
  });

  it('drops a finding whose node was deleted — it cannot block anything', () => {
    const def = expand({});
    const pruned: WorkflowDefinition = { ...def, nodes: def.nodes.filter((n) => n.typeId !== 'core.web.search') };
    expect(findUnfilledExpansionParams(pruned)).toHaveLength(0);
  });

  it('is inert for a workflow that carries no record at all', () => {
    const def = expand({ topic: 't' });
    expect(findUnfilledExpansionParams(def)).toHaveLength(0);
  });
});
