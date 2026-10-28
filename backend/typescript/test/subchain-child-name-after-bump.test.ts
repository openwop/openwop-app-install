/**
 * grade-data D-7 — RFC 0133 §1.3 keys a co-registered child on (tenant,
 * childChainId, version), so after a chain-version bump a new instantiation
 * rightly mints a NEW child beside the old one. It must not ALSO mint a second
 * workflow with the same name in the tenant's list; and repeating an
 * instantiation at one version (the convergent case) must keep the child's name.
 * The bumped child's name is pinned to the literal `uniqueOwnedName` mints
 * (`<base>-<n>`, host/workflowOwnership.ts), so a renamer that keeps names
 * distinct but wrong (or a second plain 'D7 child') reds.
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
let root = '';
const priorDisableCookies = process.env.OPENWOP_AUTH_DISABLE_COOKIES;
let pins: { sub: string; noop: string };
const PARENT = 'vendor.test.d7.parent';
const CHILD = 'vendor.test.d7.child';

function writePack(version: string): void {
  mkdirSync(join(root, 'p'), { recursive: true });
  writeFileSync(join(root, 'p', 'pack.json'), JSON.stringify({
    name: 'vendor.test.d7', version, kind: 'workflow-chain', engines: { openwop: '>=1.0.0 <3.0.0' },
    chains: [
      { chainId: CHILD, version, label: 'D7 child', description: 'child', parameters: { type: 'object', properties: {} },
        dag: { nodes: [{ id: 'c1', typeId: `core.flow.noop@${pins.noop}` }] } },
      { chainId: PARENT, version, label: 'D7 parent', description: 'parent', parameters: { type: 'object', properties: {} },
        subChains: [{ ref: CHILD }],
        dag: { nodes: [{ id: 'p1', typeId: `core.subWorkflow@${pins.sub}`, config: { subChainRef: CHILD } }] } },
    ],
  }));
  process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR = root;
  const out = reloadWorkflowChainPacks();
  if (!out.installed.some((p) => p.packName === 'vendor.test.d7')) {
    throw new Error(`fixture did not register: ${JSON.stringify(out.errors.filter((e) => e.pack.includes('d7')))}`);
  }
}

beforeAll(async () => {
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
  const v = (t: string) => {
    const n = buildNodeCatalog().find((c) => c.typeId === t);
    if (!n?.version) throw new Error(`${t} has no catalog version`);
    return n.version;
  };
  pins = { sub: v('core.subWorkflow'), noop: v('core.flow.noop') };
  root = mkdtempSync(join(tmpdir(), 'owp-d7-'));
}, 120_000);
afterAll(async () => {
  delete process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR;
  if (priorDisableCookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  else process.env.OPENWOP_AUTH_DISABLE_COOKIES = priorDisableCookies;
  reloadWorkflowChainPacks();
  await new Promise<void>((res) => server.close(() => res()));
});

const url = (p: string) => `http://127.0.0.1:${PORT}/host/openwop-app${p}`;

describe('sub-chain child names across a chain-version bump (grade-data D-7)', () => {
  it('a new child gets a unique name; a repeat at one version keeps its name', async () => {
    const r0 = await fetch(url('/workflows'));
    const cookie = (r0.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const instantiate = async () => {
      const r = await fetch(url('/workflows/from-chain'), {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ chainId: PARENT, params: {} }),
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { subChainWorkflowIds?: string[] }).subChainWorkflowIds ?? [];
    };
    const childNames = async () => {
      const r = await fetch(url('/workflows'), { headers: { cookie } });
      const body = (await r.json()) as { workflows?: Array<{ workflowId: string; name: string }> } | Array<{ workflowId: string; name: string }>;
      const rows = Array.isArray(body) ? body : (body.workflows ?? []);
      return rows.filter((w) => w.workflowId.startsWith('wf.sub.vendor-test-d7-child.')).map((w) => w.name).sort();
    };

    writePack('1.0.0');
    const [a] = await instantiate();
    const [a2] = await instantiate();
    expect(a2).toBe(a); // convergent child id
    expect(await childNames()).toEqual(['D7 child']);

    writePack('1.0.1');
    const [b] = await instantiate();
    expect(b).not.toBe(a); // RFC 0133: a new version is a new child
    const names = await childNames();
    expect(names, `child names after the bump: ${names.join(', ')}`).toEqual(['D7 child', 'D7 child-2']);
  });
});
