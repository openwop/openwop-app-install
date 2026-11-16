/**
 * CC-SEO-2 — seo.keyword-brief's "Save brief" step saves the brief as a draft
 * Document, not an email draft.
 *
 * Found in the Campaign Studio acceptance campaign (U60, prod): the step was
 * `core.email.draft` with `config: {}`, so a run needed a connected Outlook/Gmail
 * mailbox, and a step named "Save brief" never saved anything a marketer could
 * open. The user approved the recommendation (2026-11-14) to save it as a Document.
 * The same chain's `search` step was also never given a query (the `topic` param
 * was declared but unbound; chain-required-config-census quarantined both).
 *
 * Pins: the new `feature.documents.nodes.save-document` node writes through
 * `createDraftDocument` with a run/node-derived idempotency base, accepts the
 * upstream `{ content }` object a chat-completion edge delivers, fails typed with
 * no orgId or no documents surface, and passes the surface's own refusal through;
 * the chain's save step uses it with `orgId`/`title` bound and its search step
 * receives `query` from `params.topic`.
 *
 * Red on main: the node does not exist (nodes map has no entry) and the chain's
 * save step is still `core.email.draft`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string; message?: string } };
type NodeFn = (ctx: unknown) => Promise<NodeResult>;
const packUrl = new URL('../../../packs/feature.documents.nodes/index.mjs', import.meta.url);
const { nodes } = (await import(path.resolve(fileURLToPath(packUrl)))) as { nodes: Record<string, NodeFn | undefined> };
const saveDocument = nodes['feature.documents.nodes.save-document'];

interface DraftArgs { orgId: string; kind: string; title: string; content: string; idemBase: string }
function ctxWith(inputs: Record<string, unknown>, reply: Record<string, unknown> = { document: { documentId: 'doc:r1:save' }, version: { versionId: 'v1', version: 1 } }) {
  const calls: DraftArgs[] = [];
  const ctx = {
    runId: 'r1', nodeId: 'save', inputs,
    features: { documents: { createDraftDocument: async (a: DraftArgs) => { calls.push(a); return reply; } } },
  };
  return { ctx, calls };
}

describe('CC-SEO-2 — save-document node', () => {
  it('exists in the pack', () => {
    expect(typeof saveDocument).toBe('function');
  });

  it('saves upstream { content } as a draft document with a run/node idempotency base', async () => {
    const { ctx, calls } = ctxWith({ content: { content: '# Brief\nAngle…', usage: {} }, orgId: 'org-1', title: 'SEO brief: habits', kind: 'seo-brief' });
    const out = await saveDocument!(ctx);
    expect(out).toEqual({ status: 'success', outputs: { document: { documentId: 'doc:r1:save' }, version: { versionId: 'v1', version: 1 } } });
    expect(calls).toEqual([{ orgId: 'org-1', kind: 'seo-brief', title: 'SEO brief: habits', content: '# Brief\nAngle…', idemBase: 'r1:save' }]);
  });

  it('accepts a plain string content and defaults title and kind', async () => {
    const { ctx, calls } = ctxWith({ content: 'plain text', orgId: 'org-1' });
    await saveDocument!(ctx);
    expect(calls[0]).toMatchObject({ content: 'plain text', title: 'Brief', kind: 'brief' });
  });

  it('fails typed without an orgId and writes nothing', async () => {
    const { ctx, calls } = ctxWith({ content: 'x' });
    expect(await saveDocument!(ctx)).toMatchObject({ status: 'failed', error: { code: 'org_required' } });
    expect(calls).toHaveLength(0);
  });

  it('passes the surface refusal through (empty content is never success)', async () => {
    const { ctx } = ctxWith({ content: '', orgId: 'org-1' }, { error: { code: 'empty_content', message: 'Refusing to create a document with empty content.' } });
    expect(await saveDocument!(ctx)).toMatchObject({ status: 'failed', error: { code: 'empty_content' } });
  });

  it('fails typed when the host has no documents surface', async () => {
    expect(await saveDocument!({ runId: 'r1', nodeId: 'save', inputs: { content: 'x', orgId: 'org-1' }, features: {} }))
      .toMatchObject({ status: 'failed', error: { code: 'host_capability_missing' } });
  });
});

describe('CC-SEO-2 — seo.keyword-brief wiring', () => {
  interface ChainNode { id: string; typeId: string; inputs?: Record<string, unknown> }
  interface Chain { chainId: string; parameters?: { required?: string[] }; dag: { nodes: ChainNode[] } }
  const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../../examples/workflow-chain-packs/seo-content-ops/pack.json', import.meta.url)), 'utf8')) as { chains: Chain[] };
  const chain = pack.chains.find((c) => c.chainId === 'seo.keyword-brief')!;
  const node = (id: string) => chain.dag.nodes.find((n) => n.id === id)!;

  it('saves through save-document with orgId and title bound, and requires orgId', () => {
    expect(node('save').typeId).toBe('feature.documents.nodes.save-document@1.0.0');
    expect(node('save').inputs).toMatchObject({ orgId: '{{params.orgId}}', title: 'SEO brief: {{params.topic}}' });
    expect(chain.parameters?.required).toContain('orgId');
  });

  it('gives the search step its query from params.topic', () => {
    expect(node('search').inputs).toMatchObject({ query: '{{params.topic}}' });
  });
});
