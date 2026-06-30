/**
 * Workflow @-mention convergence onto the backend ownership index (ADR 0163
 * follow-on). The sync picker merges the caller's REAL owned workflows (fetched
 * async into a module cache) with localStorage drafts, deduped by workflowId.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const listWorkflowSummaries = vi.fn();
const listSavedWorkflows = vi.fn();
const demoModeCached = vi.fn();

vi.mock('../../../workflows/workflowsClient.js', () => ({
  listWorkflowSummaries: () => listWorkflowSummaries(),
}));
vi.mock('../../../builder/persistence/localStore.js', () => ({
  listSavedWorkflows: () => listSavedWorkflows(),
}));
vi.mock('../../../client/demoMode.js', () => ({ demoModeCached: () => demoModeCached() }));
// i18n .t echoes the key so assertions don't depend on locale strings.
vi.mock('../../../i18n/index.js', () => ({ default: { t: (k: string) => k } }));

// Import AFTER the mocks are registered.
const { listWorkflowMentions, refreshWorkflowMentionCache } = await import('../workflowMentions.js');

beforeEach(() => {
  listWorkflowSummaries.mockReset();
  listSavedWorkflows.mockReset().mockReturnValue([]);
  demoModeCached.mockReset().mockReturnValue(false);
});

describe('listWorkflowMentions — backend ownership index merge', () => {
  it('starts empty before the cache is warmed (fail-safe: no backend call inline)', () => {
    listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf.a', name: 'Alpha', nodeCount: 3, createdAt: '', updatedAt: '' }]);
    expect(listWorkflowMentions()).toHaveLength(0);
  });

  it('includes the caller’s owned workflows after a refresh', async () => {
    listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf.a', name: 'Alpha', nodeCount: 3, createdAt: '', updatedAt: '' }]);
    await refreshWorkflowMentionCache();
    const out = listWorkflowMentions();
    expect(out.map((e) => e.workflowId)).toEqual(['wf.a']);
    expect(out[0]!.slug).toBe('alpha');
  });

  it('dedupes by workflowId — a backend workflow also in localStorage lists once (backend wins)', async () => {
    listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf.a', name: 'Alpha', nodeCount: 3, createdAt: '', updatedAt: '' }]);
    listSavedWorkflows.mockReturnValue([{ id: 'wf.a', name: 'Alpha (stale local)', nodes: [{ name: 'n1' }], createdAt: '', updatedAt: '' }]);
    await refreshWorkflowMentionCache();
    const out = listWorkflowMentions();
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe('Alpha'); // backend name, not the local copy
  });

  it('keeps localStorage-only drafts not covered by the backend index', async () => {
    listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf.a', name: 'Alpha', nodeCount: 1, createdAt: '', updatedAt: '' }]);
    listSavedWorkflows.mockReturnValue([{ id: 'wf.local', name: 'Local Draft', nodes: [{ name: 'n1' }], createdAt: '', updatedAt: '' }]);
    await refreshWorkflowMentionCache();
    expect(listWorkflowMentions().map((e) => e.workflowId).sort()).toEqual(['wf.a', 'wf.local']);
  });

  it('leaves the cache untouched (fail-safe) when the backend errors', async () => {
    listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf.a', name: 'Alpha', nodeCount: 1, createdAt: '', updatedAt: '' }]);
    await refreshWorkflowMentionCache();
    listWorkflowSummaries.mockRejectedValue(new Error('backend down'));
    await refreshWorkflowMentionCache();
    expect(listWorkflowMentions().map((e) => e.workflowId)).toEqual(['wf.a']); // prior cache survives
  });
});
