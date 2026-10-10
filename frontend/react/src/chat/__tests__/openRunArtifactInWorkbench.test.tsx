/**
 * ADR 0768 follow-up P2 — a completed run's output opens in the Workbench.
 *
 * The feed's preview used to receive only a node's transient output, so the
 * "open in workbench" affordance `ArtifactPreviewModal` already had never
 * appeared. Now the feed looks up the run's DURABLE artifacts (the Library
 * filtered by run) and offers the Workbench only when one is confirmed for the
 * clicked node — never a button to nowhere, and never on a surface without a
 * Workbench.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }), Trans: () => null }));
vi.mock('../WorkflowCompletionCard.js', () => ({
  WorkflowCompletionCard: ({ onPreviewArtifact }: { onPreviewArtifact?: (n: string, o: unknown, l: string) => void }) => (
    <button type="button" onClick={() => onPreviewArtifact?.('draft', { text: 'plan' }, 'Plan')}>view-output</button>
  ),
}));
vi.mock('../ArtifactPreviewModal.js', () => ({
  ArtifactPreviewModal: ({ artifactId, onOpenWorkbench }: { artifactId?: string; onOpenWorkbench?: (id: string) => void }) => (
    <div role="dialog">
      {artifactId && onOpenWorkbench ? <button type="button" onClick={() => onOpenWorkbench(artifactId)}>open-in-workbench</button> : <span>preview-only</span>}
    </div>
  ),
}));
const lookup = vi.hoisted(() => ({ items: [] as Array<{ artifactId: string; runNodeId: string }>, calls: [] as string[] }));
vi.mock('../artifacts/artifactClient.js', () => ({
  listRunArtifacts: async (runId: string) => { lookup.calls.push(runId); return lookup.items; },
}));

import { MessageFeed } from '../MessageFeed.js';
import type { ChatMessage } from '../types.js';

const run: ChatMessage = {
  id: 'm-run', role: 'workflow_run', content: '',
  workflowRun: { slug: 'plan', workflowName: 'Plan', workflowId: 'wf', runId: 'run-7', status: 'completed', totalNodes: 1, completedNodeIds: ['draft'], nodeOutputs: {}, failedNodeIds: [], currentNodeName: null, nodeNames: {}, startedAt: '2026-09-29T00:00:00Z' },
} as unknown as ChatMessage;

const base = { messages: [run], tenantId: 't', onResolveInterrupt: vi.fn(async () => undefined), onOpenWorkflowProgress: vi.fn(), focusedWorkflowMessageId: null };

beforeEach(() => {
  lookup.items = []; lookup.calls = [];
  // jsdom ships no scrollIntoView; the feed scrolls its end marker on mount.
  Element.prototype.scrollIntoView = vi.fn();
});

describe('open a run artifact in the Workbench (ADR 0768 follow-up P2)', () => {
  it('offers the Workbench for the durable artifact of the clicked node, and opens it', async () => {
    lookup.items = [{ artifactId: 'run-event:run-7:other', runNodeId: 'other' }, { artifactId: 'run-event:run-7:draft', runNodeId: 'draft' }];
    const onOpenArtifact = vi.fn();
    render(<MemoryRouter><MessageFeed {...base} onOpenArtifact={onOpenArtifact} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'view-output' }));
    fireEvent.click(await screen.findByRole('button', { name: 'open-in-workbench' }));
    expect(lookup.calls).toEqual(['run-7']);
    expect(onOpenArtifact).toHaveBeenCalledWith({ artifactId: 'run-event:run-7:draft' });
  });

  it('stays a plain preview when the run has no durable artifact for that node', async () => {
    lookup.items = [{ artifactId: 'run-event:run-7:other', runNodeId: 'other' }];
    render(<MemoryRouter><MessageFeed {...base} onOpenArtifact={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'view-output' }));
    await screen.findByText('preview-only');
    await waitFor(() => expect(lookup.calls).toEqual(['run-7']));
    expect(screen.queryByRole('button', { name: 'open-in-workbench' })).toBeNull();
  });

  it('does not look anything up on a surface without a Workbench (embeds)', async () => {
    render(<MemoryRouter><MessageFeed {...base} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'view-output' }));
    await screen.findByText('preview-only');
    expect(lookup.calls).toEqual([]);
  });
});
