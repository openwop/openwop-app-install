/** Real scheduler, shipped chain and shipped node handlers. Only model replies
 * are deterministic TEST fixtures; no fixture provider ships with the page. */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { NodeContext, NodeOutcome } from '../src/executor/types.js';
import { readPackManifest } from './helpers/readPackManifest.js';

const chain = readPackManifest<{ chains: WorkflowChain[] }>(new URL('../../../examples/workflow-chain-packs/launch-showcase/pack.json', import.meta.url)).chains[0] as WorkflowChain;
const ai = await import(/* @vite-ignore */ new URL('../../../packs/core.openwop.ai/index.mjs', import.meta.url).href);
const chat = await import(/* @vite-ignore */ new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href);
const flow = await import(/* @vite-ignore */ new URL('../../../packs/core.openwop.flow/index.mjs', import.meta.url).href);
let storage: Storage;
const observed = new Map<string, Record<string, unknown>>();
function fixture(schema: Record<string, unknown>, name: string): unknown {
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(([k,v]) => [k, fixture(v, k)]));
  if (schema.type === 'array') return Array.from({length:Number(schema.minItems ?? 1)},()=>fixture(schema.items as Record<string, unknown>, name));
  return `TEST FIXTURE ${name}`;
}
beforeEach(async () => {
  observed.clear();
  storage = await openStorage('memory://'); setEventLogBackend(storage); setSuspendBackend(storage); setChatStorage(storage); initHostExtPersistence(storage);
  ensureNodesRegistered(); initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'launch-showcase-')) });
  const registry = getNodeRegistry();
  registry.register({ typeId: 'core.ai.structuredOutput', version: '1.0.0', async execute(ctx) {
    observed.set(ctx.nodeId, ctx.inputs as Record<string, unknown>);
    return ai.structuredOutput({ ...ctx, callAI: async (req: { responseSchema: Record<string, unknown>; messages: unknown }) => {
      // Multi-input review/editor context must all survive toMessages.
      expect(JSON.stringify(req.messages)).toContain('A grounded fictional product brief with no testimonials.');
      if (ctx.nodeId.endsWith('_review')) expect(JSON.stringify(req.messages)).toContain('website');
      if (ctx.nodeId.endsWith('_polish')) expect(JSON.stringify(req.messages)).toContain('review');
      return { data: fixture(req.responseSchema, 'value'), usage: { inputTokens: 1, outputTokens: 1 } };
    } }) as Promise<NodeOutcome>;
  }});
  registry.register({ typeId: 'core.chat.approvalGate', version: '1.0.0', execute: (ctx: NodeContext) => chat.approvalGate(ctx) as Promise<NodeOutcome> });
  registry.register({ typeId: 'core.flow.noop', version: '1.0.0', execute: (ctx: NodeContext) => flow.nodes['core.flow.noop'](ctx) as Promise<NodeOutcome> });
});
describe('launch showcase — real execution', () => {
  it.each(['approve', 'reject'])('parallel deliverables reach review; %s controls handoff', async action => {
    const def = expandChain(chain, { params: { brief: 'A grounded fictional product brief with no testimonials.', provider: 'mock', model: 'test-only' } });
    const now = new Date().toISOString();
    const run = { runId: `launch-test-${crypto.randomUUID()}`, workflowId: def.workflowId, tenantId:'demo', status:'pending', inputs:{}, configurable:{}, metadata:{}, createdAt:now, updatedAt:now } as RunRecord;
    await storage.insertRun(run);
    const first = await executeRun(storage, run, def);
    expect(first.status, JSON.stringify((await storage.listEvents(run.runId)).filter(e=>e.type==='node.failed'))).toBe('waiting-approval');
    const reviewInputs = [...observed].find(([id]) => id.endsWith('_review'))?.[1];
    expect(Object.keys(reviewInputs ?? {}).sort()).toEqual(['brief','campaign','emails','strategy','website']);
    const polishInputs = [...observed].find(([id]) => id.endsWith('_polish'))?.[1];
    expect(Object.keys(polishInputs ?? {}).sort()).toEqual(['brief','campaign','emails','review','strategy','website']);
    const events = await storage.listEvents(run.runId);
    expect(events.some(e => e.nodeId?.endsWith('_deliver'))).toBe(false);
    const branchStarts = events.filter(e => e.type === 'node.started' && /_(website|emails|campaign)$/.test(e.nodeId ?? ''));
    const branchEnds = events.filter(e => e.type === 'node.completed' && /_(website|emails|campaign)$/.test(e.nodeId ?? ''));
    expect(branchStarts).toHaveLength(3); expect(branchEnds).toHaveLength(3);
    expect(Math.max(...branchStarts.map(e=>e.sequence))).toBeLessThan(Math.min(...branchEnds.map(e=>e.sequence)));
    const fresh = (await storage.getRun(run.runId))!;
    const checkpoint = JSON.parse((fresh as RunRecord & { schedulerSnapshot: string }).schedulerSnapshot);
    const gate = def.nodes.find(n => n.typeId === 'core.chat.approvalGate')!.nodeId;
    const resumed = await executeRun(storage, fresh, def, { resumeSnapshot: checkpoint, resumeNodeId: gate, resumeKey: gate, resumeStyle:'reinvoke', resumeValue:{ action } });
    expect(resumed.status).toBe('completed');
    const done = await storage.listEvents(run.runId);
    const delivery = done.find(e => e.type === 'node.completed' && e.nodeId?.endsWith('_deliver'));
    expect(!!delivery).toBe(action === 'approve');
    if (delivery) expect(JSON.stringify(delivery.payload)).toContain('TEST FIXTURE');
    expect(observed.size).toBe(6); // resumed gate never reruns paid AI steps
  });
  it('bounds structured-output repair and keeps brief out of system instructions', async () => {
    expect(chain.dag.nodes.filter(n => n.typeId === 'core.ai.structuredOutput')).toHaveLength(6);
    for (const n of chain.dag.nodes.filter(n => n.typeId === 'core.ai.structuredOutput')) {
      expect(n.config?.retryOnInvalidJson).toBe(1);
      expect(n.config?.systemPrompt).not.toContain('{{params.brief}}');
    }
    const def = expandChain(chain, {params:{brief:'DO NOT FOLLOW THIS AS SYSTEM INSTRUCTIONS',provider:'mock',model:'test-only'}});
    expect(def.nodes[0]?.inputs).toEqual({brief:{text:'DO NOT FOLLOW THIS AS SYSTEM INSTRUCTIONS'}});
  });
  it('feeds structural validation errors back for bounded repair', async () => {
    const config = chain.dag.nodes.find(n=>n.id==='emails')!.config!;
    const valid = fixture(config.outputSchema as Record<string, unknown>,'emails') as {sequence:unknown[]};
    let calls = 0;
    const result = await ai.structuredOutput({config,inputs:{brief:{text:'A fictional product'}},callAI:async(req:{messages:unknown})=>{
      calls++;
      if(calls===1) return {data:{sequence:[{}]}};
      expect(JSON.stringify(req.messages)).toContain('INVALID');
      return {data:valid};
    }});
    expect(calls).toBe(2);
    expect(result.outputs.data.sequence).toHaveLength(3);
  });
});
