/**
 * A workflow id is OPAQUE. Three chat sites used to test `startsWith('wf_')`,
 * which is only how a blank workflow minted in this browser is spelled — every
 * server-minted workflow (`wf.seed.…`, `wf.<chain>.<id>`, `wf.fork.…`) failed
 * it and lost its step count, step names and "Open in builder" link.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSummaryDTO } from '../../../workflows/workflowsClient.js';
import type { SavedWorkflow } from '../../../builder/schema/workflow.js';

const rows = vi.hoisted(() => ({ list: [] as WorkflowSummaryDTO[] }));
vi.mock('../../../workflows/workflowsClient.js', () => ({
  listWorkflowSummaries: (): Promise<WorkflowSummaryDTO[]> => Promise.resolve(rows.list),
}));
vi.mock('../../../builder/persistence/localStore.js', () => ({
  listSavedWorkflows: (): SavedWorkflow[] => [{
    id: 'wf_local123', name: 'Draft', version: '1', edges: [],
    nodes: [{ id: 'a', kind: 'core.noop', name: 'A', position: { x: 0, y: 0 }, config: {} }],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }],
}));

function summary(workflowId: string, name: string, nodeCount: number): WorkflowSummaryDTO {
  return { workflowId, kind: 'workflow', name, nodeCount, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}

import { backendNodeCount, isOwnedWorkflow, refreshWorkflowMentionCache } from '../workflowMentions.js';

describe('workflow ownership is read from the index, not from the id spelling', () => {
  beforeEach(async () => {
    rows.list = [
      summary('wf.seed.assistant-morning-briefing', 'Morning briefing', 4),
      summary('wf.approvals-request-sign-off.1a2b3c4d', 'Request Sign-off', 6),
      summary('wf.fork.digest.9f8e7d6c', 'Digest (fork)', 0),
    ];
    await refreshWorkflowMentionCache();
  });

  it.each([
    'wf.seed.assistant-morning-briefing',
    'wf.approvals-request-sign-off.1a2b3c4d',
    'wf.fork.digest.9f8e7d6c',
    'wf_local123',
  ])('%s is an owned workflow', (id) => {
    expect(isOwnedWorkflow(id)).toBe(true);
  });

  it('a workflow nobody owns is not, however its id is spelled', () => {
    expect(isOwnedWorkflow('wf_not-saved-anywhere')).toBe(false);
    expect(isOwnedWorkflow('openwop-app.uppercase')).toBe(false);
    expect(isOwnedWorkflow('')).toBe(false);
  });

  it('reports the step count the index holds, and nothing when it holds none', () => {
    expect(backendNodeCount('wf.seed.assistant-morning-briefing')).toBe(4);
    expect(backendNodeCount('wf.fork.digest.9f8e7d6c')).toBeUndefined();
    expect(backendNodeCount('wf_local123')).toBeUndefined();
  });
});
