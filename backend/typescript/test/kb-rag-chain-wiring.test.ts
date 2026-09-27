/**
 * The three chains the PIN hid.
 *
 * `it-support.incident-triage` had a test that asserted its KB step threw
 * `not_found` and called that "the honest, reproducible current behavior".
 * Three more chains shipped the identical defect — the query wired through
 * `config`, which `feature.kb.nodes.rag` never reads — with NO test at all.
 * A documented failure reads like a handled one, so nobody swept for siblings.
 *
 * These drive the REAL node against a REAL seeded collection, per chain, so a
 * regression surfaces on the chain that broke rather than three chains away.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import {
  loadWorkflowChainPacks, listChains, expandChain, _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const TENANT = 'tenant-kb-rag-wiring';
const ORG = 'org-kb-rag';
let collectionId = '';
let server: http.Server;
type PackNode = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs: Record<string, unknown> }>;
let ragNode: PackNode;

beforeAll(async () => {
  // Boot a REAL app: `ctx.features.kb` is composed at app construction (ADR
  // 0014), so a bare-storage harness fails on composition rather than on the
  // wiring under test — which would look like a red test for the wrong reason.
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  const kb = getToggleDefault('kb');
  if (kb) await saveConfig({ ...kb, status: 'on' }, 'test');

  // @ts-expect-error — feature.kb.nodes ships no declaration file (untyped .mjs)
  ragNode = ((await import('../../../packs/feature.kb.nodes/index.mjs')) as { rag: typeof ragNode }).rag;

  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: [join(import.meta.dirname, '../../../examples/workflow-chain-packs')] });

  const col = await createCollection(TENANT, ORG, 'u1', { name: 'Reference' });
  collectionId = col.collectionId;
  await ingestDocument(TENANT, ORG, 'u1', collectionId, {
    title: 'Pricing and packaging',
    text: 'Our platform is priced per workspace with unlimited seats. Enterprise adds SSO and audit export.',
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** chainId → [rag node id, the chain's own query param] */
const CASES: Array<[string, string, string]> = [
  ['lighthouse.rfp-response', 'retrieve', 'rfpText'],
  ['marketing.content-brief', 'gather', 'topic'],
  ['support.kb-answer', 'retrieve', 'question'],
];

describe.each(CASES)('%s — the KB step resolves', (chainId, nodeId, queryParam) => {
  it('binds orgId/collectionId/query and retrieves against a real collection', async () => {
    const found = listChains().find((c) => c.chain.chainId === chainId);
    expect(found, `${chainId} not loaded — renamed?`).toBeDefined();

    const params: Record<string, unknown> = {
      [queryParam]: 'What is the pricing model?',
      orgId: ORG,
      collectionId,
    };
    // Supply every other required param so expansion is realistic.
    for (const k of ((found!.chain.parameters as { required?: string[] })?.required) ?? []) {
      if (!(k in params)) params[k] = `test-${k}`;
    }
    const def = expandChain(found!.chain, { params });
    const node = def.nodes.find((n) => n.nodeId.endsWith(nodeId) && n.typeId === 'feature.kb.nodes.rag');
    expect(node, `${chainId}: rag node ${nodeId} not in the expanded definition`).toBeDefined();

    const declared = (node!.inputs ?? {}) as Record<string, unknown>;
    expect(declared.orgId, 'orgId must reach ctx.inputs — config is never read by this node').toBe(ORG);
    expect(declared.collectionId).toBe(collectionId);
    expect(declared.query).toBe('What is the pricing model?');

    const features = buildFeatureSurfaces({ tenantId: TENANT, runId: `run:${chainId}` });
    const out = await ragNode({ inputs: declared, config: node!.config, features });

    // The assertion that matters: it used to throw `not_found` here.
    expect(out.status, 'the KB step must complete').toBe('success');
    expect(out.outputs.augmentedPrompt).toContain('pricing');
  });
});
