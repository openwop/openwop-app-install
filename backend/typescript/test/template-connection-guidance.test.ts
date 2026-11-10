/** ADR 1065: only recognized booleans guide host template UX. Uses actual
 * node catalog and host listing HTTP; memory storage only, no external account.
 * Breaks if: the catalog projects a non-boolean `x-usesConnections` (or an opaque
 * vendor field); the listing stops passing installed-node metadata into
 * `chainRequirements`; aggregation lets a literal ref, a `true`, an empty graph, an
 * uninstalled node or a mixed unknown read as `none`. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { buildNodeCatalog } from '../src/host/nodeCatalogBuilder.js';
import { chainRequirements, reloadWorkflowChainPacks, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const envKeys = ['OPENWOP_PACK_DIR', 'OPENWOP_WORKFLOW_CHAIN_PACKS_DIR', 'OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES'] as const;
const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
let root = ''; let server: Server; let base = '';
interface ListedChain { chainId: string; requirements: { connectionUsage?: string; connections: unknown[] } }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Narrow the listing body to the fields the assertions read; throw (a named red) otherwise. */
function listedChains(body: unknown): ListedChain[] {
  const rows: unknown = isObject(body) ? body.chains : undefined;
  if (!Array.isArray(rows)) throw new Error('workflow-chains listing has no chains array');
  const list: unknown[] = rows;
  return list.map((c): ListedChain => {
    const req: unknown = isObject(c) ? c.requirements : undefined;
    const chainId: unknown = isObject(c) ? c.chainId : undefined;
    const connections: unknown = isObject(req) ? req.connections : undefined;
    if (typeof chainId !== 'string' || !isObject(req) || !Array.isArray(connections)) {
      throw new Error('workflow-chains listing row is missing chainId/requirements.connections');
    }
    const usage: unknown = req.connectionUsage;
    if (usage !== undefined && typeof usage !== 'string') throw new Error(`${chainId}: connectionUsage is not a string`);
    const rowConnections: unknown[] = connections;
    return { chainId, requirements: { connections: rowConnections, ...(usage === undefined ? {} : { connectionUsage: usage }) } };
  });
}
function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObject(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}
const types = ['uses', 'none', 'string', 'object', 'absent'] as const;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'wftpl2-'));
  const nodeRoot = join(root, 'nodes'); const chainRoot = join(root, 'chains');
  for (const name of ['feature.campaign-connectors.nodes','feature.campaign-intel.nodes']) {
    mkdirSync(join(nodeRoot, name), { recursive: true });
    writeFileSync(join(nodeRoot, name, 'pack.json'), readFileSync(join(repo,'packs',name,'pack.json')));
  }
  mkdirSync(join(nodeRoot, 'vendor.test.guidance'), { recursive: true });
  writeFileSync(join(nodeRoot,'vendor.test.guidance','pack.json'),JSON.stringify({name:'vendor.test.guidance',version:'1.0.0',nodes:types.map(kind=>({typeId:`vendor.test.guidance.${kind}`,version:'1.0.0',label:kind,category:'integration',role:'pure',...(kind==='absent'?{}:{'x-usesConnections':kind==='uses'?true:kind==='none'?false:kind==='string'?'false':{none:true}}),'x-unknown-guidance':{untrusted:'never project'}}))}));
  mkdirSync(join(chainRoot,'campaign-sync'),{recursive:true});
  writeFileSync(join(chainRoot,'campaign-sync','pack.json'),readFileSync(join(repo,'examples/workflow-chain-packs/campaign-sync/pack.json')));
  mkdirSync(join(chainRoot,'controls'),{recursive:true});
  writeFileSync(join(chainRoot,'controls','pack.json'),JSON.stringify({name:'vendor.test.guidance.chains',version:'1.0.0',kind:'workflow-chain',engines:{openwop:'>=1.0.0 <3.0.0'},chains:types.map(kind=>({chainId:`vendor.test.guidance.${kind}`,version:'1.0.0',label:kind,description:'Controlled metadata',parameters:{type:'object',properties:{}},dag:{nodes:[{id:'n',typeId:`vendor.test.guidance.${kind}@1.0.0`}]}}))}));
  process.env.OPENWOP_PACK_DIR=nodeRoot;process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR=chainRoot;process.env.OPENWOP_STORAGE_DSN='memory://';process.env.OPENWOP_AUTH_DISABLE_COOKIES='true';
  const app=await createApp({port:0,storageDsn:'memory://',serviceName:'test',serviceVersion:'0.0.1',enableConsoleTracer:false});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/host/openwop-app`;
  reloadWorkflowChainPacks();
},120_000);
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));for(const k of envKeys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}reloadWorkflowChainPacks();if(root)rmSync(root,{recursive:true,force:true});});
it('projects exact booleans only from actual manifests, retaining false and ignoring opaque fields',()=>{
  const schema = readJsonObject(join(repo, 'schemas/node-pack-manifest.schema.json'));
  if (!isObject(schema.$defs)) throw new Error('node-pack manifest schema has no $defs');
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile({ $ref: '#/$defs/PackNode', $defs: schema.$defs });
  const manifest = readJsonObject(join(root, 'nodes/vendor.test.guidance/pack.json'));
  const rawNodes: unknown = manifest.nodes;
  const nodes: unknown[] = Array.isArray(rawNodes) ? rawNodes : [];
  const first = nodes[0];
  if (nodes.length !== types.length || !isObject(first)) throw new Error('guidance manifest has no node objects');
  for (const node of nodes) expect(validate(node), JSON.stringify(validate.errors)).toBe(true);
  // The accepted extension hatch stays constrained: arbitrary unprefixed fields fail.
  expect(validate({ ...first, unsafeUnknownGuidance: true })).toBe(false);
  const catalog=buildNodeCatalog();
  expect(catalog.find(n=>n.typeId==='vendor.test.guidance.uses')?.usesConnections).toBe(true);
  expect(catalog.find(n=>n.typeId==='vendor.test.guidance.none')?.usesConnections).toBe(false);
  for(const kind of ['string','object','absent']){const n=catalog.find(n=>n.typeId===`vendor.test.guidance.${kind}`);expect(n).toBeDefined();expect(n).not.toHaveProperty('usesConnections');expect(n).not.toHaveProperty('x-unknown-guidance');}
});
it('real host listing keeps current unannotated campaign chains unknown and honors declared controls',async()=>{
  const response=await fetch(`${base}/workflow-chains`,{headers:{authorization:'Bearer dev-token'}});expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const chains = listedChains(body);
  for(const id of ['campaign-sync.daily-metrics','campaign-intel.reallocate']){const c=chains.find(c=>c.chainId===id);expect(c).toBeDefined();expect(c?.requirements.connections).toEqual([]);expect(c?.requirements.connectionUsage).toBe('unknown');}
  expect(chains.find(c=>c.chainId==='vendor.test.guidance.uses')?.requirements.connectionUsage).toBe('uses');
  expect(chains.find(c=>c.chainId==='vendor.test.guidance.none')?.requirements.connectionUsage).toBe('none');
  for(const kind of ['string','object','absent'])expect(chains.find(c=>c.chainId===`vendor.test.guidance.${kind}`)?.requirements.connectionUsage).toBe('unknown');
});
it('pure aggregation stays conservative for unknown/empty graphs and literal references override false',()=>{
  const c=(nodes:WorkflowChain['dag']['nodes']):WorkflowChain=>({chainId:'local',version:'1.0.0',label:'local',description:'local',parameters:{},dag:{nodes}});
  const noRef=c([{id:'n',typeId:'local.none'}]);
  expect(chainRequirements(noRef,new Set(['local.none']),()=>false,()=>null,()=>({usesConnections:false})).connectionUsage).toBe('none');
  expect(chainRequirements(noRef,new Set(['local.none']),()=>false).connectionUsage).toBe('unknown');
  expect(chainRequirements(c([]),new Set(),()=>false).connectionUsage).toBe('unknown');
  const mixed = c([{ id: 'known', typeId: 'local.none' }, { id: 'old', typeId: 'local.old' }]);
  const installed = new Set(['local.none', 'local.old']);
  expect(chainRequirements(mixed, installed, () => false, () => null,
    (id) => id === 'local.none' ? { usesConnections: false } : {}).connectionUsage).toBe('unknown');
  expect(chainRequirements(mixed, installed, () => false, () => null,
    (id) => id === 'local.none' ? { usesConnections: true } : {}).connectionUsage).toBe('uses');
  expect(chainRequirements(noRef, new Set(), () => false, () => null,
    () => ({ usesConnections: false })).connectionUsage).toBe('unknown');
  const explicit=c([{id:'n',typeId:'local.none',config:{connectionRef:'known-account'}}]);
  const req=chainRequirements(explicit,new Set(['local.none']),()=>true,()=>null,()=>({usesConnections:false}));expect(req.connectionUsage).toBe('uses');expect(req.connections).toEqual([{ref:'known-account',providerId:'known-account',providerInstalled:true}]);
});
