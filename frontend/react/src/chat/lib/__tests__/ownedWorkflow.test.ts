/**
 * A workflow id is OPAQUE. Three chat sites used to test `startsWith('wf_')`,
 * which is only how a blank workflow minted in this browser is spelled — every
 * server-minted workflow (`wf.seed.…`, `wf.<chain>.<id>`, `wf.fork.…`) failed
 * it and lost its step count, step names and "Open in builder" link.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ list: [] as { workflowId: string; name: string; nodeCount: number }[] }));
vi.mock('../../../workflows/workflowsClient.js', () => ({
  listWorkflowSummaries: () => Promise.resolve(rows.list),
}));
vi.mock('../../../builder/persistence/localStore.js', () => ({
  listSavedWorkflows: () => [{ id: 'wf_local123', name: 'Draft', nodes: [{ id: 'a' }] }],
}));

import { backendNodeCount, isOwnedWorkflow, refreshWorkflowMentionCache } from '../workflowMentions.js';

describe('workflow ownership is read from the index, not from the id spelling', () => {
  beforeEach(async () => {
    rows.list = [
      { workflowId: 'wf.seed.assistant-morning-briefing', name: 'Morning briefing', nodeCount: 4 },
      { workflowId: 'wf.approvals-request-sign-off.1a2b3c4d', name: 'Request Sign-off', nodeCount: 6 },
      { workflowId: 'wf.fork.digest.9f8e7d6c', name: 'Digest (fork)', nodeCount: 0 },
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
