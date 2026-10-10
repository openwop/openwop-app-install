/**
 * ADR 0773 G-10a — the defects the DEPLOYED-build check found on
 * app.openwop.dev (2026-10-01), each pinned where it lives:
 *   - a suggested connection was listed in the review and not drawn;
 *   - its review row named its ends by generated id (`sg_…`);
 *   - the status bar read "1 steps · 1 connections";
 *   - a kept step landed 30px under its source.
 */
import { describe, expect, it } from 'vitest';
import { ghostEdgeHandles, projectGhosts } from '../pair/suggestionModel.js';
import type { SuggestedOp, WorkflowEditSuggestion } from '../pair/suggestionModel.js';
import { opSummary } from '../pair/opSummary.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const add = (nodeId: string, name: string): SuggestedOp => ({
  op: { kind: 'addNode', nodeId, typeId: 'core.noop', name }, dependsOn: [], preimages: [], gateSensitive: false, summary: `Add ${name}`,
});
const connect: SuggestedOp = {
  op: { kind: 'addEdge', edgeId: 'sge_1', sourceNodeId: 'sg_x_1', targetNodeId: 'sg_x_2' },
  dependsOn: [0, 1], preimages: [], gateSensitive: false, summary: 'Connect sg_x_1 → sg_x_2',
};
const suggestion: WorkflowEditSuggestion = {
  id: 's', workflowId: 'wf', conversationId: 'c', requestedBy: 'u', baseRevision: 'r', summary: '',
  visibility: 'private', createdAt: '', updatedAt: '', opState: ['pending', 'pending', 'pending'],
  ops: [add('sg_x_1', 'Webhook Trigger'), add('sg_x_2', 'Notify: In-App'), connect],
};

describe('a suggested connection is drawn', () => {
  it('names no handle on an end that is a ghost step, and keeps the port on a real one', () => {
    const g = { source: 'sg_x_1', target: 'real', sourcePort: 'method', targetPort: 'title' };
    expect(ghostEdgeHandles(g, new Set(['sg_x_1']))).toEqual({ targetHandle: 'title' });
    expect(ghostEdgeHandles(g, new Set())).toEqual({ sourceHandle: 'method', targetHandle: 'title' });
    expect(ghostEdgeHandles({ ...g, target: 'sg_x_2' }, new Set(['sg_x_1', 'sg_x_2']))).toEqual({});
  });

  it('projects the edge between the two ghost steps it connects', () => {
    const proj = projectGhosts(suggestion, { nodes: [], edges: [] }, ['pending', 'pending', 'pending']);
    expect(proj.ghostEdges.map((e) => [e.source, e.target])).toEqual([['sg_x_1', 'sg_x_2']]);
    const ids = new Set(proj.ghostNodes.map((n) => n.id));
    expect(ghostEdgeHandles(proj.ghostEdges[0]!, ids)).toEqual({});
  });
});

describe('a connection row names steps, not generated ids', () => {
  it('uses the suggested step names', () => {
    expect(opSummary(connect, { ops: suggestion.ops, nodes: [] })).toBe('Connect Webhook Trigger → Notify: In-App');
  });
  it('uses the name of a step already on the sheet', () => {
    const toReal: SuggestedOp = { ...connect, op: { kind: 'addEdge', edgeId: 'sge_2', sourceNodeId: 'sg_x_1', targetNodeId: 'crm' }, summary: 'Connect sg_x_1 → crm' };
    expect(opSummary(toReal, { ops: suggestion.ops, nodes: [{ id: 'crm', name: 'Write to CRM' }] })).toBe('Connect Webhook Trigger → Write to CRM');
  });
  it('leaves the server text alone when it has no name for an end', () => {
    expect(opSummary(connect, { ops: [], nodes: [] })).toBe('Connect sg_x_1 → sg_x_2');
    expect(opSummary(connect)).toBe('Connect sg_x_1 → sg_x_2');
  });
});

describe('a new step leaves room for a real card above it', () => {
  it('places a connected step 180px below its source', () => {
    const proj = projectGhosts(suggestion, { nodes: [], edges: [] }, ['pending', 'pending', 'pending']);
    const [a, b] = proj.ghostNodes;
    expect(b!.position.y - a!.position.y).toBe(180);
  });
});

describe('the status bar counts are plural-aware in every locale', () => {
  it.each([['en', en], ['es', es], ['fr', fr], ['pt-BR', ptBR]] as const)('%s has one/other forms for steps and connections', (_name, m) => {
    const table: Record<string, unknown> = m;
    for (const key of ['pairStatusSteps_one', 'pairStatusSteps_other', 'pairStatusConnections_one', 'pairStatusConnections_other']) {
      expect(typeof table[key], key).toBe('string');
    }
    expect(table.pairStatusSteps_one).not.toBe(table.pairStatusSteps_other);
    expect(table.pairStatusConnections_one).not.toBe(table.pairStatusConnections_other);
    expect(table.pairStatusCounts).toBeUndefined();
  });
});
