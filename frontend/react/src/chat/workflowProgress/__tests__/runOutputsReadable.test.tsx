/**
 * Issue 5849 — a finished run's outputs read as fields, not printed JSON.
 *
 * The Run tab rendered `run.outputs` as `JSON.stringify(…, null, 2)` in a `<pre>`, so
 * a person had to read braces and quoted keys to find the sentence that mattered.
 * Red when the outputs go back through JSON.stringify into the DOM.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChatMessage } from '../../types.js';
import { WorkflowProgressPanel } from '../WorkflowProgressPanel.js';

afterEach(cleanup);

const SENTENCE = 'Rejected: nothing was saved, and the call notes were deleted. Enter the record by hand if you want to keep it.';
const run: ChatMessage = {
  id: 'm-run', role: 'workflow_run', content: '', createdAt: '2026-11-16T00:00:00Z',
  workflowRun: {
    slug: 'notes', workflowName: 'Call notes', workflowId: 'wf', runId: 'run-1', status: 'completed', totalNodes: 1,
    completedNodeIds: ['n'], nodeOutputs: {}, failedNodeIds: [], currentNodeName: null, nodeNames: {}, startedAt: '2026-11-16T00:00:00Z',
    outputs: { value: SENTENCE, discarded: true },
  },
};

describe('issue 5849 — run outputs in the Run tab', () => {
  it('shows the message as text, with no braces or quoted keys', () => {
    const { container } = render(
      <MemoryRouter>
        <WorkflowProgressPanel workflowRunMessages={[run]} focusedMessageId="m-run" onFocus={vi.fn()} onClose={vi.fn()} onCancel={vi.fn(async () => undefined)} />
      </MemoryRouter>,
    );
    expect(screen.getByText(SENTENCE)).toBeTruthy();
    const outputs = container.querySelector('.wfprog-outputs')!;
    expect(outputs.textContent).not.toMatch(/[{}]|"value"|"discarded"/);
    expect(container.querySelector('pre.wfprog-outputs')).toBeNull();
  });
});
