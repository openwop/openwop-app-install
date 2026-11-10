/** Builder cross-stack test boundary: real backend code in its own type program.
 * One bounded IPC request, no app boot, node execution, storage or providers. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expandChain, type WorkflowChain } from '../../src/host/workflowChainPackLoader.js';
import { buildGraph, topologicalOrder, buildNodeInputs, freshSnapshot } from '../../src/executor/scheduler.js';
import { validateWorkflowDefinition } from '../../src/host/workflowDefinitionValidation.js';

const MAX_BYTES = 1_048_576;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function answer(payload: unknown, exitCode: number): void {
  if (!process.send) process.exit(2);
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) {
    process.send({ ok: false, error: 'Builder contract response exceeds limit' }, () => process.exit(1));
    return;
  }
  process.send(payload, () => process.exit(exitCode));
}
if (!process.send) throw new Error('Builder contract helper requires IPC');
process.once('disconnect', () => process.exit(1));
process.once('message', (request: unknown) => {
  try {
    if (!isRecord(request) || Buffer.byteLength(JSON.stringify(request)) > MAX_BYTES) throw new Error('Invalid builder contract request');
    if (request.command === 'expand-kernel') {
      const packPath = fileURLToPath(new URL('../../../../examples/workflow-chain-packs/campaign-brief/pack.json', import.meta.url));
      const pack: { chains: WorkflowChain[] } = JSON.parse(readFileSync(packPath, 'utf8'));
      const chain = pack.chains.find(c => c.chainId === 'campaign-studio.messaging-kernel');
      if (!chain) throw new Error('Messaging kernel chain fixture missing');
      const definition = expandChain(chain, { params: { briefId: 'local-brief', provider: 'google', model: 'gemini-3.8-flash' } });
      answer({ ok: true, definition, order: topologicalOrder(definition, buildGraph(definition)) }, 0);
    } else if (request.command === 'build-inputs') {
      const definition = validateWorkflowDefinition(request.definition);
      if (typeof request.target !== 'string' || !definition.nodes.some(n => n.nodeId === request.target) || !isRecord(request.outputs)) throw new Error('Invalid input projection request');
      const snapshot = freshSnapshot(definition);
      for (const [nodeId, output] of Object.entries(request.outputs)) {
        if (!definition.nodes.some(n => n.nodeId === nodeId) || !isRecord(output)) throw new Error('Invalid source output fixture');
        snapshot.nodeState.set(nodeId, 'completed');
        snapshot.nodeOutputs.set(nodeId, output);
      }
      answer({ ok: true, inputs: buildNodeInputs(request.target, buildGraph(definition), snapshot, {}) }, 0);
    } else if (request.command === 'validate') {
      const definition = validateWorkflowDefinition(request.definition);
      answer({ ok: true, metadata: definition.metadata, edges: definition.edges }, 0);
    } else throw new Error('Unknown builder contract command');
  } catch (error) {
    answer({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
  }
});
