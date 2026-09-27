/**
 * RFC 0013 — the `/v1/host/sample/workflow-chain:expand` host-expansion witness seam
 * (drives `workflow-chain-host-expansion.test.ts` non-vacuously against the published
 * `vendor.openwop.workflow-chain-sample` fixture). Pins the wire shape + negatives so
 * the published legs can't regress silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { loadChainSamplePack } from '../src/host/workflowChainPackLoader.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const PATH = '/v1/host/sample/workflow-chain:expand';
const PACK = 'vendor.openwop.workflow-chain-sample';

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let b: Record<string, unknown> = {};
  try { b = (await res.json()) as Record<string, unknown>; } catch { /* no body */ }
  return { status: res.status, body: b };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('RFC 0013 workflow-chain:expand witness seam', () => {
  it('1-node chain expands to the RFC-0013 wire shape (id dots→underscores, capabilities propagated)', async () => {
    const { status, body } = await post({
      packName: PACK,
      chainId: `${PACK}.summarize-text`,
      parameters: { sourceText: 'hi', targetLength: 'one-sentence', tone: 'casual' },
    });
    expect(status).toBe(200);
    expect(typeof body.expansionId).toBe('string');
    // `packVersion` is whatever the INSTALLED conformance fixture says — the
    // seam reads `fixtures/pack-manifests/workflow-chain-sample.pack.json`
    // from the pinned suite (`loadChainSamplePack`), and the fixture moved
    // 1.0.0 → 1.1.0 at suite 1.133.0 (RFC 0157 host-path witness: two
    // compensating chains). Pinning the literal made this test red on every
    // pin bump for a reason that is not a host defect; asserting equality
    // with the fixture keeps it non-vacuous (the seam MUST echo the fixture's
    // version, and it MUST be a real semver) without hard-coding the corpus.
    const fixture = loadChainSamplePack();
    expect(fixture, 'the pinned suite ships the sample chain pack fixture').not.toBeNull();
    expect(body.packVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.packVersion).toBe(fixture!.version);
    const nodes = body.nodes as Array<{ id: string; typeId: string; capabilities?: string[] }>;
    expect(nodes).toHaveLength(1);
    // node-id rewrite: chainId dots → underscores, hyphens preserved, expansionId prefix.
    expect(nodes[0]!.id).toMatch(/^vendor_openwop_workflow-chain-sample_summarize-text_[a-f0-9]+_/);
    expect(nodes[0]!.typeId).toBe('core.ai.callPrompt');
    expect(nodes[0]!.capabilities).toEqual(['cacheable']);
  });

  it('2-node chain rewrites edge endpoints (port suffix preserved) + propagates side-effectful', async () => {
    const { status, body } = await post({
      packName: PACK,
      chainId: `${PACK}.fetch-and-summarize`,
      parameters: { url: 'https://e.com/a', targetLength: 'executive-summary' },
    });
    expect(status).toBe(200);
    const edges = body.edges as Array<{ from: string; to: string }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toMatch(/_fetch\.body$/);
    expect(edges[0]!.to).toMatch(/_summarize\.sourceText$/);
    for (const n of body.nodes as Array<{ capabilities?: string[] }>) {
      expect(n.capabilities).toEqual(['side-effectful']);
    }
  });

  it('negatives: unknown pack → 404 pack_not_found; unknown chain → 404 chain_not_found; missing chainId → 422', async () => {
    expect((await post({ packName: 'vendor.acme.nope', chainId: 'x' })).body.error).toBe('pack_not_found');
    expect((await post({ packName: PACK, chainId: `${PACK}.nope` })).body.error).toBe('chain_not_found');
    const missing = await post({ packName: PACK });
    expect(missing.status).toBe(422);
    expect(missing.body.error).toBe('invalid_request');
  });
});
