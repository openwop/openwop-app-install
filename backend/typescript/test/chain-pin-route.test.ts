/**
 * ADR 0766 D3, at the HTTP boundary — a pin this host cannot honour is reported
 * on both routes that report install gaps, as a STRUCTURED mismatch (grade-ux
 * U-1/U-2: the first cut folded it into the "not installed" lists as a
 * `typeId@pinned` string, so an installed node read as missing):
 *
 *   GET  /workflow-chains        → `requirements.pinMismatches` (the pre-flight)
 *   POST /workflows/from-chain   → `pinMismatches` (R6: instantiation still SUCCEEDS)
 *
 * "Use template = just copy" is a product contract (see
 * workflow-from-chain-route.test.ts), so a version mismatch is an install gap to
 * report, never a refusal. The unit test cannot see either route's wiring — a
 * `chainRequirements` that supports pins is inert if the route never passes it
 * the installed versions — so this drives the real app.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { buildNodeCatalog } from '../src/host/nodeCatalogBuilder.js';
import { reloadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';

let server: http.Server;
let PORT: number;
let pinnedRef = '';
let expected: { typeId: string; label: string; pinned: string; installed: string };
const CHAIN_ID = 'vendor.test.pin-route.chain';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;

  // Pin a node type this host HAS, at a version it does not.
  const installed = buildNodeCatalog().find((n) => typeof n.version === 'string' && n.version.length > 0);
  if (!installed) throw new Error('the node catalog is empty — nothing to pin against');
  pinnedRef = `${installed.typeId}@999.0.0`;
  expected = { typeId: installed.typeId, label: installed.label, pinned: '999.0.0', installed: installed.version as string };
  const root = mkdtempSync(join(tmpdir(), 'owp-chain-pin-route-'));
  mkdirSync(join(root, 'p'), { recursive: true });
  writeFileSync(join(root, 'p', 'pack.json'), JSON.stringify({
    name: 'vendor.test.pin-route', version: '1.0.0', kind: 'workflow-chain', engines: { openwop: '>=1.0.0 <3.0.0' },
    chains: [{
      chainId: CHAIN_ID, version: '1.0.0', label: 'Pin route fixture', description: 'Pins an installed type at a missing version.',
      parameters: { type: 'object', properties: {} },
      dag: { nodes: [{ id: 'n1', typeId: pinnedRef }] },
    }],
  }));
  process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR = root;
  const outcome = reloadWorkflowChainPacks();
  if (!outcome.installed.some((p) => p.packName === 'vendor.test.pin-route')) {
    throw new Error(`fixture chain did not register: ${JSON.stringify(outcome.errors.filter((e) => e.pack.includes('pin-route')))}`);
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR;
  reloadWorkflowChainPacks();
  await new Promise<void>((res) => server.close(() => res()));
});

const url = (p: string) => `http://127.0.0.1:${PORT}/host/openwop-app${p}`;
async function cookie(): Promise<string> {
  const r = await fetch(url('/workflows'));
  const set = r.headers.get('set-cookie');
  if (!set) throw new Error('no session cookie');
  return set.split(';')[0] ?? '';
}

describe('ADR 0766 D3 — an unhonourable pin at the HTTP boundary', () => {
  it('GET /workflow-chains reports it in requirements.pinMismatches — never as a missing type', async () => {
    const r = await fetch(url('/workflow-chains'), { headers: { cookie: await cookie() } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { chains: Array<{ chainId: string; requirements: { missingNodeTypeIds: string[]; pinMismatches: unknown[] } }> };
    const fixture = body.chains.find((c) => c.chainId === CHAIN_ID);
    expect(fixture?.requirements.pinMismatches).toEqual([expected]);
    expect(fixture?.requirements.missingNodeTypeIds).toEqual([]);
  });

  it('POST /workflows/from-chain still instantiates (201) and names it in pinMismatches, not warnings', async () => {
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie() },
      body: JSON.stringify({ chainId: CHAIN_ID, params: {} }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { warnings?: string[]; pinMismatches?: unknown[] };
    expect(body.pinMismatches).toEqual([expected]);
    expect(body.warnings).toBeUndefined();
  });
});
