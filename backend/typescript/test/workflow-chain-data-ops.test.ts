/**
 * Data Ops workflow-chain pack (ADR 0200 + 0201) — the Make/Workato-canon gap:
 * the aggregator "collapse many records into one" shapes, one-way read→write,
 * and (ADR 0201) content routing via edge conditions.
 *
 * Still does NOT use core.flow.iterator (annotate-only, no per-item fan-out) or
 * core.flow.split-in-batches (single-slice, needs a loop) — those misrepresent
 * the nodes in a linear chain (ADR 0200 §scope). It DOES now use core.flow.router
 * with conditional edges: ADR 0201 made expandChain propagate + map the wire
 * EdgeCondition → the host executor's {path,op,value}, so a router's matched
 * `branches` labels gate the downstream edges (content-router chain).
 *
 * Wave 64: the typeId check reads the packs' own manifests (was a hand-copied set).
 * Cut as covered (each covering case confirmed red by probe): the isolated
 * `evaluateCondition` case (by "ONLY the matched branch is released", 8fw5g1-do-router-low)
 * and the aggregate-numeric / aggregate-text node cases (by
 * workflow-chain-data-ops-execution "sums + formats the REAL items array",
 * 8fw5g1-do-agg-sum-cover / -text-cover). Sabotage-witnessed: router conditions, the
 * approval-gated upsert edge, the upsert operationId param, aggregate-table.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowChainPacks,
  getChain,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
// The flow-pack node implementations (the executable contract these chains ride).
// aggregate-numeric / aggregate-text run for real in workflow-chain-data-ops-execution
// ("sums + formats the REAL items array"); only aggregate-table (to-table is not
// executed there) is exercised here.
import { aggregateTableNode } from '../../../packs/core.openwop.flow/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_TREE_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [IN_TREE_ROOT] });
  expect(errors).toEqual([]);
});

const PACK = 'core.openwop.workflows.data-ops';
const CHAINS = ['data-ops.rollup', 'data-ops.to-table', 'data-ops.records-to-system', 'data-ops.content-router'];

/**
 * The SSoT for "registered": every node typeId a node pack in the repo's `packs/`
 * declares (`pack.json` → `nodes[].typeId`). Read, never hand-copied — a copied list
 * stayed green when a pack dropped a node.
 */
const PACKS_ROOT = join(__dirname, '..', '..', '..', 'packs');
const KNOWN_TYPEIDS = new Set(
  readdirSync(PACKS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PACKS_ROOT, d.name, 'pack.json')))
    .flatMap((d) => {
      const manifest = JSON.parse(readFileSync(join(PACKS_ROOT, d.name, 'pack.json'), 'utf8')) as { nodes?: Array<{ typeId?: unknown }> };
      return (manifest.nodes ?? []).map((n) => n.typeId).filter((t): t is string => typeof t === 'string');
    }),
);

describe('data-ops pack — discovery + typeIds', () => {
  it('loads all chains with the Data Ops category', () => {
    for (const id of CHAINS) {
      const entry = getChain(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.packName).toBe(PACK);
      expect(entry!.category).toBe('Data Ops');
    }
    expect(listChains().filter((c) => c.packName === PACK)).toHaveLength(4);
  });

  it.each(CHAINS)('%s references only registered typeIds', (id) => {
    const chain = getChain(id)!.chain;
    for (const n of chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('data-ops.content-router — edge conditions map wire→host + gate (ADR 0201)', () => {
  it('expands the router branches with conditions mapped to the host EdgeDef shape', () => {
    const chain = getChain('data-ops.content-router')!.chain;
    const def = expandChain(chain, { params: { record: { priority: 'high' } } });
    // Every router→branch edge carries a host-shaped condition {path,op,value}.
    const conds = (def.edges ?? []).filter((e) => e.condition).map((e) => e.condition);
    expect(conds).toHaveLength(3);
    expect(conds).toContainEqual({ path: 'branches', op: 'contains', value: 'high' });
    expect(conds).toContainEqual({ path: 'branches', op: 'contains', value: 'low' });
    expect(conds).toContainEqual({ path: 'branches', op: 'contains', value: 'normal' });
  });

  it('ONLY the matched branch is released when the router runs (ADR 0208 control-flow — ECR-5)', async () => {
    // The isolated evaluateCondition check above proves the predicate; this
    // proves the EXPANDED graph actually routes exclusively through the real
    // scheduler — the router firing branches:['high'] must leave the high
    // branch `ready` and the normal/low branches `skipped`, not all three run
    // (the pre-ADR-0208 bug where content-router fired every branch).
    const { buildGraph, freshSnapshot, markCompleted, releaseDownstream } = await import('../src/executor/scheduler.js');
    const def = expandChain(getChain('data-ops.content-router')!.chain, { params: { record: { priority: 'high' } } });
    const g = buildGraph(def);
    const s = freshSnapshot(def);
    // Resolve the expanded node ids by their edge conditions (expansion rewrites ids).
    const idFor = (label: string) => (def.edges ?? []).find((e) => e.condition?.value === label)!.targetNodeId;
    const routeId = (def.edges ?? []).find((e) => e.condition?.value === 'high')!.sourceNodeId;
    markCompleted(routeId, { branches: ['high'], value: { priority: 'high' } }, s);
    releaseDownstream(routeId, g, s);
    expect(s.nodeState.get(idFor('high'))).toBe('ready');
    expect(s.nodeState.get(idFor('normal'))).toBe('skipped');
    expect(s.nodeState.get(idFor('low'))).toBe('skipped');
  });

  it('rejects an unsupported condition type at EXPAND time (honest — the host cannot evaluate it)', () => {
    const chain = getChain('data-ops.content-router')!.chain;
    // Forge an expression-typed condition the host does not evaluate.
    const forged = {
      ...chain,
      dag: {
        ...chain.dag,
        edges: [{ from: 'route', to: 'high', condition: { type: 'expression', expression: 'x > 1' } }],
      },
    };
    expect(() => expandChain(forged as typeof chain, { params: { record: {} } }))
      .toThrow(/chain_edge_condition_unsupported/);
  });

  it('chains WITHOUT conditions expand with no condition field (backward-compat)', () => {
    const def = expandChain(getChain('data-ops.rollup')!.chain, { params: { items: [] } });
    expect((def.edges ?? []).every((e) => e.condition === undefined)).toBe(true);
  });
});

describe('data-ops pack — the aggregator node CONTRACT the chains depend on', () => {
  // These chains are only honest if the aggregate nodes actually reduce an
  // items array as the templates assume. Exercise the real implementations.
  const items = [{ name: 'Widget', amount: 9.5 }, { name: 'Gadget', amount: 20 }];

  it('aggregate-table extracts the named columns (to-table depends on this)', async () => {
    const out = await aggregateTableNode({ inputs: { items }, config: { columns: [{ path: 'name' }, { path: 'amount' }] } });
    expect(out.outputs.rows).toEqual([['Widget', 9.5], ['Gadget', 20]]);
  });
});

describe('data-ops pack — honesty invariants', () => {
  it('the data-shaping chains are zero-connection, ungated; only records-to-system writes', () => {
    for (const id of ['data-ops.rollup', 'data-ops.to-table']) {
      const chain = getChain(id)!.chain;
      expect(chain.dag.nodes.some((n) => n.typeId === 'core.openwop.http.openapi-call')).toBe(false);
      expect(chain.dag.nodes.some((n) => n.typeId === 'core.chat.approvalGate')).toBe(false);
      expect(chain.capabilities ?? []).not.toContain('side-effectful');
    }
  });

  it('records-to-system gates the UPSERT behind an approval (the write is downstream of the gate)', () => {
    const chain = getChain('data-ops.records-to-system')!.chain;
    const nodes = chain.dag.nodes;
    const upsert = nodes.find((n) => n.id === 'upsert')!;
    expect(upsert.typeId).toBe('core.openwop.http.openapi-call');
    // The write's only inbound edge is the approval gate.
    const intoUpsert = (chain.dag.edges ?? []).filter((e) => e.to === 'upsert');
    expect(intoUpsert).toHaveLength(1);
    expect(intoUpsert[0]!.from).toBe('approve');
    expect(nodes.find((n) => n.id === 'approve')!.typeId).toBe('core.chat.approvalGate');
    expect(chain.capabilities ?? []).toContain('side-effectful');
  });

  it('the upsert operationId is a PARAM (never a hardcoded blind create) + copy names the guardrails', () => {
    const chain = getChain('data-ops.records-to-system')!.chain;
    const upsert = chain.dag.nodes.find((n) => n.id === 'upsert')!;
    expect((upsert.config as { operationId?: string }).operationId).toBe('{{params.upsertOperationId}}');
    const desc = chain.description.toLowerCase();
    expect(desc).toContain('one-way');
    expect(desc).toContain('upsert');
    expect(desc).toContain('write scope');
    // The reshape prompt must carry the 'unknown for undeterminable fields' guardrail.
    const reshape = chain.dag.nodes.find((n) => n.id === 'reshape')!;
    expect(JSON.stringify(reshape.config)).toMatch(/unknown/i);
  });

  it('NO chain promises bidirectional sync — the disavowal "not a sync" is allowed (framing ban, ADR 0200)', () => {
    for (const id of CHAINS) {
      const chain = getChain(id)!.chain;
      const text = `${chain.label} ${chain.description}`.toLowerCase();
      // Promissory reconciliation terms are always banned.
      expect(text, `${id} must not promise bidirectional/two-way`).not.toMatch(/bidirectional|two-way/);
      // "sync" is allowed ONLY as an explicit disavowal ("not a sync"); a
      // promissory "syncs"/"keep in sync"/"will sync" is banned.
      expect(text, `${id} must not promise a sync`).not.toMatch(/\bsyncs\b|keep[a-z ]*in sync|will sync|sync your|two ?way sync/);
      for (const m of text.matchAll(/[a-z]*\s+(?:a\s+)?sync/g)) {
        expect(m[0], `${id}: every "sync" mention must be a disavowal, got "${m[0]}"`).toMatch(/not\s+(?:a\s+)?sync/);
      }
    }
  });
});

describe('data-ops pack — expansion', () => {
  const sampleParams: Record<string, Record<string, unknown>> = {
    'data-ops.rollup': { items: [{ name: 'A', amount: 1 }] },
    'data-ops.to-table': { records: [{ name: 'A', value: 1 }] },
    'data-ops.records-to-system': {
      sourceConnectionRef: 'core.openwop.connections.salesforce', readOperationId: 'listContacts',
      destConnectionRef: 'core.openwop.connections.hubspot', upsertOperationId: 'upsertContact', keyField: 'externalId',
    },
    'data-ops.content-router': { record: { priority: 'high' } },
  };

  it.each(CHAINS)('%s expands to a validated, deterministic definition', (id) => {
    const chain = getChain(id)!.chain;
    const def = expandChain(chain, { params: sampleParams[id]! });
    expect(def.workflowId.startsWith(`${id}:`)).toBe(true);
    expect(def.nodes).toHaveLength(chain.dag.nodes.length);
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
    expect(expandChain(chain, { params: sampleParams[id]! })).toEqual(def);
  });
});
