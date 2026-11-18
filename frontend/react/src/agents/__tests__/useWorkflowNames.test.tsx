/**
 * Issue 5911 — surfaces show a workflow's name, not its raw id.
 *
 * `workflowName` knew only the built-in template ids, so a person's own workflow
 * (`wf.blank.…`) rendered as its id in the inbox, the agent drawer and the agent
 * workspace. Pins: the tenant's name wins, then the built-in name, then the id;
 * the read happens only when a non-built-in id is rendered; one read is shared;
 * a failed read falls back and is not cached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const list = vi.fn();
vi.mock('../../workflows/workflowsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listWorkflowSummaries: (opts: unknown) => list(opts) }));
const { useWorkflowNames, __resetWorkflowNames } = await import('../useWorkflowNames.js');
const { ALL_WORKFLOW_OPTIONS } = await import('../roleTemplates.js');

beforeEach(() => { __resetWorkflowNames(); list.mockReset(); });
afterEach(cleanup);

describe('issue 5911 — useWorkflowNames', () => {
  it('the tenant name, else the built-in name, else the id', async () => {
    list.mockResolvedValue([{ workflowId: 'wf.blank.ce300bdb9b3f4eda', name: 'Weekly client email' }]);
    const builtin = ALL_WORKFLOW_OPTIONS[0]!;
    const { result } = renderHook(() => { const name = useWorkflowNames(); return { name, own: name('wf.blank.ce300bdb9b3f4eda') }; });
    await waitFor(() => expect(result.current.own).toBe('Weekly client email'));
    expect(result.current.name(builtin.workflowId)).toBe(builtin.name);
    expect(result.current.name('wf.unknown.1'), 'absent from the caller\'s client-scoped list: unnamed, not the raw id').toBe('Unnamed workflow');
    expect(list, 'archived workflows are named too').toHaveBeenCalledWith({ includeArchived: true });
  });

  it('shares one read across surfaces mounted together', async () => {
    list.mockResolvedValue([{ workflowId: 'wf.a', name: 'A' }]);
    const a = renderHook(() => useWorkflowNames()('wf.a'));
    const b = renderHook(() => useWorkflowNames()('wf.a'));
    await waitFor(() => expect(a.result.current).toBe('A'));
    await waitFor(() => expect(b.result.current).toBe('A'));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('reads nothing while a surface shows only built-in ids', async () => {
    const builtin = ALL_WORKFLOW_OPTIONS[0]!;
    const { result } = renderHook(() => useWorkflowNames()(builtin.workflowId));
    expect(result.current).toBe(builtin.name);
    await new Promise((r) => setTimeout(r, 20));
    expect(list).not.toHaveBeenCalled();
  });

  it('a failed read falls back to the id and is retried on the next mount', async () => {
    list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([{ workflowId: 'wf.a', name: 'A' }]);
    const first = renderHook(() => useWorkflowNames()('wf.a'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(first.result.current).toBe('wf.a');
    const second = renderHook(() => useWorkflowNames()('wf.a'));
    await waitFor(() => expect(second.result.current).toBe('A'));
    expect(list).toHaveBeenCalledTimes(2);
  });
});
