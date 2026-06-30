/**
 * feature.notebooks.nodes — the Research Notebooks feature node pack over
 * `ctx.features.notebooks` (ADR 0084 Phase 3). READ-only nodes: `ask` (grounded
 * retrieve → augmentedPrompt + de-duplicated citations, with multi-query
 * fan-out + merge) and `search` (raw hits), plus the capability-missing backstop.
 *
 * Pure node-fn unit test: the node functions are driven directly against a MOCK
 * ctx whose `ctx.features.notebooks` returns canned data — fencing + context-level
 * filtering are the HOST surface's job (covered by notebooks-surface.test.ts), so
 * this test asserts only the pack's own contract (merge/dedupe/shape/backstop).
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
import * as pack from '../../../packs/feature.notebooks.nodes/index.mjs';

/** A mock `ctx.features.notebooks` whose `ask` returns canned data keyed by the
 *  query, and `searchNotebook` returns canned hits. Records the calls so the test
 *  can assert the multi-query fan-out. */
function mockNotebooks(map: Record<string, { augmentedPrompt: string; citations: Array<{ documentId: string; title: string }>; contexts: Array<{ documentId: string }> }>) {
  const calls: Array<{ method: string; query: string }> = [];
  return {
    calls,
    surface: {
      ask: async (args: { query: string }) => {
        calls.push({ method: 'ask', query: args.query });
        return map[args.query] ?? { augmentedPrompt: '', citations: [], contexts: [] };
      },
      searchNotebook: async (args: { query: string }) => {
        calls.push({ method: 'searchNotebook', query: args.query });
        return { hits: [{ documentId: 'd1', title: 'Doc 1' }], citations: [{ documentId: 'd1', title: 'Doc 1' }] };
      },
    },
  };
}

const ctxFor = (notebooks: unknown, inputs: Record<string, unknown>) => ({ inputs, features: { notebooks } });

describe('feature.notebooks.nodes', () => {
  it('ask returns augmentedPrompt + deduped citations for a single query', async () => {
    const mock = mockNotebooks({
      'what do whales eat': {
        augmentedPrompt: 'Knowledge: whales eat krill.\n\nQuestion: what do whales eat',
        citations: [{ documentId: 'd1', title: 'Whales' }, { documentId: 'd1', title: 'Whales' }],
        contexts: [{ documentId: 'd1' }],
      },
    });
    const out = await pack.ask(ctxFor(mock.surface, { notebookId: 'nb-1', query: 'what do whales eat' }));
    expect(out.status).toBe('success');
    expect(out.outputs.augmentedPrompt).toContain('whales eat krill');
    // citations deduped by documentId even within one surface call's payload
    expect(out.outputs.citations).toHaveLength(1);
    expect(out.outputs.citations[0].documentId).toBe('d1');
    expect(out.outputs.contexts).toHaveLength(1);
  });

  it('ask fans out per query and MERGES (concat prompts, dedupe citations, concat contexts)', async () => {
    const mock = mockNotebooks({
      q1: { augmentedPrompt: 'block-1', citations: [{ documentId: 'd1', title: 'A' }], contexts: [{ documentId: 'd1' }] },
      q2: { augmentedPrompt: 'block-2', citations: [{ documentId: 'd1', title: 'A' }, { documentId: 'd2', title: 'B' }], contexts: [{ documentId: 'd2' }] },
    });
    const out = await pack.ask(ctxFor(mock.surface, { notebookId: 'nb-1', queries: ['q1', 'q2'] }));
    expect(out.status).toBe('success');
    // both prompt blocks concatenated
    expect(out.outputs.augmentedPrompt).toContain('block-1');
    expect(out.outputs.augmentedPrompt).toContain('block-2');
    // d1 (seen in both queries) appears once; d2 once → 2 total
    expect(out.outputs.citations.map((c: { documentId: string }) => c.documentId).sort()).toEqual(['d1', 'd2']);
    // contexts concatenated across queries (no dedup — they are raw hits)
    expect(out.outputs.contexts).toHaveLength(2);
    // one surface ask per query
    expect(mock.calls.filter((c) => c.method === 'ask').map((c) => c.query)).toEqual(['q1', 'q2']);
  });

  it('search returns raw hits via ctx.features.notebooks.searchNotebook', async () => {
    const mock = mockNotebooks({});
    const out = await pack.search(ctxFor(mock.surface, { notebookId: 'nb-1', query: 'whales' }));
    expect(out.status).toBe('success');
    expect(out.outputs.hits).toHaveLength(1);
    expect(out.outputs.hits[0].documentId).toBe('d1');
    expect(mock.calls.some((c) => c.method === 'searchNotebook')).toBe(true);
  });

  it('ask throws host_capability_missing when ctx.features.notebooks is absent', async () => {
    await expect(pack.ask({ inputs: { notebookId: 'x', query: 'y' }, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.sample.notebooks' });
  });

  it('search throws host_capability_missing when ctx.features.notebooks is absent', async () => {
    await expect(pack.search({ inputs: { notebookId: 'x', query: 'y' }, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.sample.notebooks' });
  });
});

// ADR 0084 review fixes — read-source in-run text fetch (transform no longer inlines
// the source text into run.inputs) + write-transformation ownerSubject hardening.
describe('feature.notebooks.nodes — review fixes', () => {
  const notebooksWithText = (text: string) => ({
    getSourceText: async () => ({ text }),
  });

  it('read-source prepends a system message when given a systemPrompt (fetches text in-run)', async () => {
    const out = await pack.readSource(ctxFor(notebooksWithText('the source body'), {
      notebookId: 'nb-1', sourceId: 's-1', systemPrompt: 'Summarize this.',
    }));
    expect(out.status).toBe('success');
    expect(out.outputs.messages).toEqual([
      { role: 'system', content: 'Summarize this.' },
      { role: 'user', content: 'the source body' },
    ]);
  });

  it('read-source omits the system message when no systemPrompt is given (summarize path)', async () => {
    const out = await pack.readSource(ctxFor(notebooksWithText('the source body'), {
      notebookId: 'nb-1', sourceId: 's-1',
    }));
    expect(out.outputs.messages).toEqual([{ role: 'user', content: 'the source body' }]);
  });

  it('write-transformation honors a project ownerSubject', async () => {
    const created: Array<Record<string, unknown>> = [];
    const docs = {
      createDocument: async (args: Record<string, unknown>) => { created.push(args); return { document: { documentId: 'doc-1' } }; },
      addVersion: async () => ({}),
    };
    const out = await pack.writeTransformation(
      { runId: 'r1', nodeId: 'write', inputs: { orgId: 'o1', title: 'Summary: X', kind: 'notebook-summary', content: 'body', ownerSubject: { kind: 'project', id: 'nb-1' } }, features: { documents: docs } },
    );
    expect(out.outputs.written).toBe(true);
    expect(created[0]?.ownerSubject).toEqual({ kind: 'project', id: 'nb-1' });
  });

  it('write-transformation DROPS a non-project ownerSubject (a chat agent cannot own a Document to a user/agent subject)', async () => {
    const created: Array<Record<string, unknown>> = [];
    const docs = {
      createDocument: async (args: Record<string, unknown>) => { created.push(args); return { document: { documentId: 'doc-1' } }; },
      addVersion: async () => ({}),
    };
    const out = await pack.writeTransformation(
      { runId: 'r1', nodeId: 'write', inputs: { orgId: 'o1', title: 'X', kind: 'notebook-summary', content: 'body', ownerSubject: { kind: 'user', id: 'someone-else' } }, features: { documents: docs } },
    );
    // still written (the artifact is created), but UN-owned — never mis-attributed to the user subject.
    expect(out.outputs.written).toBe(true);
    expect(created[0]?.ownerSubject).toBeUndefined();
  });
});
