import type { RunEventDoc } from '@openwop/openwop';
import type { GraphNodeView, GraphEdgeView } from '../../canvas/types.js';
import pack from '../../../../../examples/workflow-chain-packs/launch-showcase/pack.json';

// Presentation is derived from the shipped chain, never a second workflow definition.
export const template = pack.chains[0]!;
export const CHAIN_ID = template.chainId;
export type StepStatus = 'queued' | 'running' | 'completed' | 'failed' | 'waiting' | 'skipped' | 'cancelled';
export interface Step { status: StepStatus; output?: unknown; at?: string }
export const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const text = (v: unknown): string => typeof v === 'string' ? v : '';
export const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
export const records = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(record) : [];
export const terminal = (s: string) => ['completed', 'failed', 'cancelled'].includes(s);
export function mergeEvents(previous: readonly RunEventDoc[], incoming: readonly RunEventDoc[], runId: string): RunEventDoc[] {
  const bySequence = new Map(previous.filter(e => e.runId === runId).map(e => [e.sequence, e]));
  for (const e of incoming) if (e.runId === runId) bySequence.set(e.sequence, e);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}
export function projectSteps(events: readonly RunEventDoc[]): Record<string, Step> {
  const steps: Record<string, Step> = {};
  const states: Record<string, StepStatus> = { 'node.started': 'running', 'node.completed': 'completed', 'node.failed': 'failed', 'node.suspended': 'waiting', 'node.skipped': 'skipped', 'node.cancelled': 'cancelled' };
  for (const e of [...events].sort((a,b) => a.sequence-b.sequence)) {
    if (e.type === 'run.failed' || e.type === 'run.cancelled' || e.type === 'run.completed') {
      for (const [id, step] of Object.entries(steps)) {
        if (step.status === 'running' || step.status === 'waiting') steps[id] = { status: e.type === 'run.failed' ? 'failed' : 'cancelled', at: e.timestamp };
      }
    }
    const status = states[e.type];
    if (!status || !e.nodeId) continue;
    steps[e.nodeId] = { status, at: e.timestamp, ...(status === 'completed' ? { output: record(e.payload).outputs } : {}) };
  }
  return steps;
}
export function stageOf(nodeId: string): string {
  return template.dag.nodes.find(n => n.id === nodeId || nodeId.endsWith(`_${n.id}`))?.id ?? nodeId;
}
export function graphOf(definition: Record<string, unknown> | null, steps: Record<string, Step>, finished = false): { nodes: GraphNodeView[]; edges: GraphEdgeView[] } {
  const source = definition ? records(definition.nodes).map(n => ({ id: text(n.nodeId) })) : template.dag.nodes;
  const nodes = source.map(n => {
    const stage = template.dag.nodes.find(s => s.id === stageOf(n.id));
    const status = steps[n.id]?.status ?? (finished ? 'skipped' : 'queued');
    return { id: n.id, label: `${stage?.name ?? n.id} · ${status}`, x: stage?.position.x ?? 0, y: stage?.position.y ?? 0, data: { stage: stage?.id, name: stage?.name, status } };
  });
  const edges: GraphEdgeView[] = definition
    ? records(definition.edges).map((e,i) => ({ id: text(e.edgeId) || String(i), from: text(e.sourceNodeId), to: text(e.targetNodeId), sourceEdge: 'bottom', targetEdge: 'top' }))
    : template.dag.edges.map((e,i) => ({ id: String(i), from: e.from.split('.')[0]!, to: e.to.split('.')[0]!, sourceEdge: 'bottom', targetEdge: 'top' }));
  return { nodes, edges: edges.map(e => ({ ...e, animated: !finished && steps[e.to]?.status === 'running' && steps[e.from]?.status === 'completed' })) };
}
export function stageOutput(steps: Record<string, Step>, stage: string): Record<string, unknown> {
  const entry = Object.entries(steps).find(([id]) => stageOf(id) === stage)?.[1];
  return entry?.status === 'completed' ? record(record(entry.output).data) : {};
}
export function isShowcaseDefinition(def: Record<string, unknown>): boolean {
  return record(def.metadata).chainId === CHAIN_ID;
}
