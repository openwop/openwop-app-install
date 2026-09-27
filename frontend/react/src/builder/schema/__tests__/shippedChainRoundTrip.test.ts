/**
 * The builder round-trip must not eat a REAL shipped chain's authored values.
 *
 * Every other round-trip fixture in this suite is inline and synthetic
 * (`core.noop`, `uppercase`), and no frontend test reads a single file from
 * `examples/workflow-chain-packs/`. That is exactly how the strip survived: the
 * fixtures only ever carried the fields the builder already modelled, so a
 * pipeline that deleted `inputs` looked like a perfect fixed point.
 *
 * 114 of 169 shipped chains author node `inputs` (187 nodes). This file loads one
 * of them off disk — `commerce.post-purchase-thankyou`, whose `send` node keeps
 * `config.from` but authors `inputs.to`/`inputs.subject`, so the loss is legible
 * in a single assertion: the email keeps its SENDER and loses its RECIPIENT.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The catalog normally loads over `fetch` from the host, which a unit test has
// no access to; without it every typeId is "not installed" and deserialize
// throws before any assertion runs (an incomplete fixture making the real
// assertions unreachable). Only the LOOKUP is stubbed — the chain under test is
// still read from disk, which is the whole point of this file.
const stubEntry = (typeId: string) => ({
  kind: typeId, typeId, label: typeId, description: '', category: 'action',
  badge: 'X', accent: '', inputs: [], outputs: [],
});
vi.mock('../../palette/catalogRegistry.js', () => ({
  catalogEntryByTypeId: (typeId: string) => stubEntry(typeId),
  catalogEntry: (kind: string) => stubEntry(kind),
  defaultConfigFor: () => ({}),
  mergedCatalog: () => [],
  resolvableTypeIds: () => [],
}));

import { serializeWorkflow } from '../serialize.js';
import { fromCanonicalDefinition } from '../deserialize.js';

const REPO = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const PACK = join(REPO, 'examples', 'workflow-chain-packs', 'commerce', 'pack.json');
const CHAIN_ID = 'commerce.post-purchase-thankyou';

interface PackNode { id: string; typeId: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> }

function loadChainNodes(): PackNode[] {
  const pack = JSON.parse(readFileSync(PACK, 'utf8')) as {
    chains: { chainId: string; dag: { nodes: PackNode[]; edges: { from: string; to: string }[] } }[];
  };
  const chain = pack.chains.find((c) => c.chainId === CHAIN_ID);
  if (!chain) throw new Error(`${CHAIN_ID} not found in ${PACK}`);
  return chain.dag.nodes;
}

/** The chain as the host would persist it after `expandChain` — node ids are
 *  prefixed there, but the field SHAPE is what this test is about. */
function storedDefinition() {
  const pack = JSON.parse(readFileSync(PACK, 'utf8')) as {
    chains: { chainId: string; dag: { nodes: PackNode[]; edges: { from: string; to: string }[] } }[];
  };
  const chain = pack.chains.find((c) => c.chainId === CHAIN_ID)!;
  return {
    workflowId: 'wf.seed.commerce-post-purchase-thankyou',
    metadata: { name: 'Post-purchase thank-you' },
    nodes: chain.dag.nodes.map((n) => ({
      nodeId: n.id,
      typeId: n.typeId,
      ...(n.config && Object.keys(n.config).length > 0 ? { config: n.config } : {}),
      ...(n.inputs && Object.keys(n.inputs).length > 0 ? { inputs: n.inputs } : {}),
    })),
    // Chain edges are PORT-level (`compose.content → send.text`) and several
    // pairs repeat across ports; the builder models edges node-to-node, so they
    // collapse. Dedupe to the node-level shape the builder actually holds.
    edges: [...new Map(
      chain.dag.edges.map((e) => {
        const s = e.from.split('.')[0]!;
        const tgt = e.to.split('.')[0]!;
        return [`${s}->${tgt}`, { edgeId: `e_${s}_${tgt}`, sourceNodeId: s, targetNodeId: tgt }] as const;
      }),
    ).values()],
  };
}

/** open → save through the REAL deserialize/serialize pair. */
function roundTrip(stored: ReturnType<typeof storedDefinition>) {
  const d = fromCanonicalDefinition(stored);
  return serializeWorkflow({
    id: stored.workflowId,
    name: d.name,
    version: '1.0.0',
    nodes: d.nodes,
    edges: d.edges,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(d.variables !== undefined ? { variables: d.variables } : {}),
  });
}

describe('a real shipped chain survives open → save', () => {
  const packNodes = loadChainNodes();

  it('FIXTURE GUARD: the chain on disk actually authors node inputs', () => {
    // Without this the preservation assertions below pass trivially the day the
    // pack changes shape — the same vacuity that let the strip ship, one level
    // down. Guard the INPUT, not just the outcome.
    const withInputs = packNodes.filter((n) => n.inputs && Object.keys(n.inputs).length > 0);
    expect(withInputs.length, `${CHAIN_ID} no longer authors node inputs — this file proves nothing`).toBeGreaterThanOrEqual(2);
    const send = packNodes.find((n) => n.typeId === 'core.openwop.integration.email-send');
    expect(send?.inputs, 'the email node must author a recipient for this test to mean anything').toHaveProperty('to');
  });

  it('preserves the email node\'s recipient and subject through the round trip', () => {
    const stored = storedDefinition();
    const out = roundTrip(stored);
    const send = (out.nodes as { nodeId: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> }[])
      .find((n) => n.nodeId === 'send');
    expect(send, 'the email node vanished from the round trip').toBeDefined();
    // The defect in one line: the sender survived and the recipient did not.
    expect(send!.config).toEqual({ from: '{{params.senderEmail}}' });
    expect(send!.inputs, 'the email kept its SENDER and lost its RECIPIENT').toEqual({
      to: '{{params.recipientEmail}}',
      subject: '{{params.emailSubject}}',
    });
  });

  it('preserves every authored input across every node of the chain', () => {
    const stored = storedDefinition();
    const out = roundTrip(stored);
    const byId = new Map(
      (out.nodes as { nodeId: string; inputs?: Record<string, unknown> }[]).map((n) => [n.nodeId, n.inputs]),
    );
    for (const n of packNodes) {
      if (!n.inputs || Object.keys(n.inputs).length === 0) continue;
      expect(byId.get(n.id), `node ${n.id} lost its authored inputs`).toEqual(n.inputs);
    }
  });

  it('leaves `{{params.*}}` tokens untouched — the builder is not an expander', () => {
    // Path A freezes these at expansion; a builder save must never re-interpret
    // or blank them.
    const out = roundTrip(storedDefinition());
    const order = (out.nodes as { nodeId: string; inputs?: Record<string, unknown> }[])
      .find((n) => n.nodeId === 'order');
    expect(order!.inputs).toEqual({ orgId: '{{params.orgId}}', orderId: '{{params.orderId}}' });
  });
});

/**
 * THROUGH THE STORE, not around it.
 *
 * The assertions above hand-build a `SavedWorkflow` and call serialize directly —
 * they replicate the pipeline rather than drive it, which is exactly the critique
 * ADR 0523 levels at the tests that missed the original strip. That blind spot
 * was real: `loadFromSaved` / `snapshot` / `persist` are three more field-by-field
 * allowlists, and they dropped `variables` + `configurableSchema` while every
 * schema-level test stayed green.
 *
 * This drives the real path: loadFromSaved → snapshot → serializeWorkflow.
 */
describe('the builder STORE preserves what the schema layer preserves', () => {
  it('carries node inputs, variables and configurableSchema through load → snapshot → save', async () => {
    const { useBuilderStore } = await import('../../store/builderStore.js');
    const stored = storedDefinition();
    const d = fromCanonicalDefinition(stored);

    useBuilderStore.getState().loadFromSaved({
      id: stored.workflowId,
      name: d.name,
      version: '1.0.0',
      nodes: d.nodes,
      edges: d.edges,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      variables: [{ name: 'recipientEmail', type: 'string' }],
      configurableSchema: { type: 'object', properties: { recipientEmail: {} } },
    });

    const out = serializeWorkflow(useBuilderStore.getState().snapshot());

    const send = (out.nodes as { nodeId: string; inputs?: Record<string, unknown> }[])
      .find((n) => n.nodeId === 'send');
    expect(send?.inputs, 'the store dropped the node inputs').toEqual({
      to: '{{params.recipientEmail}}',
      subject: '{{params.emailSubject}}',
    });
    // The half that was inert: refs without their declarations resolve to
    // `undefined`, and the run-inputs form renders from `variables[]`.
    expect(
      (out as { variables?: unknown }).variables,
      'the store dropped variables[] — preserved refs would resolve against an empty bag',
    ).toEqual([{ name: 'recipientEmail', type: 'string' }]);
    expect((out as { configurableSchema?: unknown }).configurableSchema).toEqual({
      type: 'object', properties: { recipientEmail: {} },
    });
  });
});

/**
 * Export → Import is its own round trip, and it was lossy.
 *
 * `BuilderShell.onImportFile` rebuilds `SavedWorkflow` field-by-field in BOTH
 * branches — the sixth such allowlist found on this path. Node `inputs` rode
 * through it (deserialize reads them) while `variables` did not, producing
 * precisely the asymmetry this ADR forbids: preserved `{type:'variable'}` refs
 * whose declarations were deleted, which resolve to `undefined` and then
 * OVERWRITE the edge value. Reachable in one gesture, and previously untested.
 *
 * This asserts the deserializer surfaces both halves, which is what the import
 * path destructures.
 */
describe('the canonical import path surfaces the def-level fields', () => {
  it('exposes variables and configurableSchema for a caller to carry', () => {
    const d = fromCanonicalDefinition({
      ...storedDefinition(),
      variables: [{ name: 'recipientEmail', type: 'string' }],
      configurableSchema: { type: 'object', properties: { recipientEmail: {} } },
    });
    expect(d.variables, 'import cannot carry what deserialize does not return').toEqual([
      { name: 'recipientEmail', type: 'string' },
    ]);
    expect(d.configurableSchema).toEqual({ type: 'object', properties: { recipientEmail: {} } });
  });
});
