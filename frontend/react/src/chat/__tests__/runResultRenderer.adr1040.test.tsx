/**
 * ADR 1040 D7 F2 (Book AI P47) — a feature's inline result card for a finished run.
 *
 *  - A renderer registered for an artifact type renders under the completed run
 *    when the AUTHORIZED artifact list (`listRunArtifacts`) holds that type,
 *    and receives exactly that list.
 *  - No match (wrong type, wrong workflow, a failed or unfinished run) keeps
 *    today's completion line and renders no feature card.
 *  - A renderer that throws is contained: the completion line still renders.
 *  - Registration refuses a duplicate id or a renderer that matches nothing.
 *
 * Red when: WorkflowCompletionCard stops consulting `findRunResultRenderer`,
 * matches on anything but the authorized list, renders for a non-completed run,
 * or drops the error boundary (chat/lib/runResultRenderers.ts).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WorkflowRunState } from '../types.js';
import type { RunArtifact } from '../RunArtifactCards.js';

let impl: (id: string) => Promise<RunArtifact[]> = async () => [];
const calls: string[] = [];
vi.mock('../artifacts/artifactClient.js', () => ({ listRunArtifacts: (id: string) => { calls.push(id); return impl(id); } }));

import { WorkflowCompletionCard } from '../WorkflowCompletionCard.js';
import { __unregisterRunResultRenderer, registerRunResultRenderer, type RunResultRendererProps } from '../lib/runResultRenderers.js';

const run = (over: Partial<WorkflowRunState> = {}): WorkflowRunState => ({
  slug: 'wf', workflowName: 'Draft chapter', workflowId: 'wf-draft',
  runId: 'run-9', status: 'completed', totalNodes: 1,
  completedNodeIds: ['draft'], nodeOutputs: {}, failedNodeIds: [],
  currentNodeName: null, nodeNames: {}, startedAt: '2026-11-03T00:00:00.000Z', ...over,
});
const art = (id: string, type: string): RunArtifact => ({
  artifactId: `run-event:run-9:${id}`, runNodeId: id, title: `T ${id}`, kind: 'document', format: 'markdown',
  tenantId: 't', orgId: 'o', source: 'run-event', sourceId: id, status: 'final', artifactTypeId: type,
  createdBy: { kind: 'run', id: 'run-9' }, createdAt: '2026-11-03T00:00:00Z', provenance: { runId: 'run-9', nodeId: id },
});
async function drain(): Promise<void> {
  await act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); });
}
const view = (r: WorkflowRunState) => render(<MemoryRouter><WorkflowCompletionCard run={r} /></MemoryRouter>);

const seen: Array<readonly RunArtifact[]> = [];
function DraftResult({ artifacts }: RunResultRendererProps): JSX.Element {
  seen.push(artifacts);
  return <p>Chapter draft ready ({artifacts.length})</p>;
}
let boomRan = 0;
function Boom(): JSX.Element { boomRan += 1; throw new Error('renderer bug'); }

beforeEach(() => {
  calls.length = 0; seen.length = 0; impl = async () => [];
  registerRunResultRenderer({ id: 'bookai.draft', match: { artifactTypes: ['bookai.chapter-draft'] }, Component: DraftResult });
});
afterEach(() => {
  cleanup();
  __unregisterRunResultRenderer('bookai.draft');
  __unregisterRunResultRenderer('bookai.boom');
  __unregisterRunResultRenderer('bookai.scoped');
});

describe('run result renderers', () => {
  it('renders under a completed run that produced the type, with the authorized list', async () => {
    impl = async () => [art('draft', 'bookai.chapter-draft'), art('notes', 'doc')];
    view(run());
    expect(await screen.findByText('Chapter draft ready (2)')).toBeTruthy();
    expect(calls).toEqual(['run-9']);
    expect(seen.at(-1)?.map((a) => a.artifactId)).toEqual(['run-event:run-9:draft', 'run-event:run-9:notes']);
    expect(screen.getByText(/completed/i)).toBeTruthy(); // the completion line stays
  });

  it('no matching type, or a failed run: no feature card, completion line unchanged', async () => {
    impl = async () => [art('notes', 'doc')];
    view(run());
    await drain();
    expect(screen.queryByText(/Chapter draft ready/)).toBeNull();
    cleanup();
    impl = async () => [art('draft', 'bookai.chapter-draft')];
    view(run({ status: 'failed', error: { code: 'x', message: 'y' } }));
    await drain();
    expect(screen.queryByText(/Chapter draft ready/)).toBeNull();
  });

  it('asks for no artifacts when every renderer is scoped to other workflows', async () => {
    __unregisterRunResultRenderer('bookai.draft');
    registerRunResultRenderer({ id: 'bookai.scoped', match: { artifactTypes: ['bookai.chapter-draft'], workflowIds: ['wf-other'] }, Component: DraftResult });
    view(run());
    await drain();
    expect(calls).toEqual([]);
  });

  it('a workflow-scoped renderer matches only its workflow', async () => {
    // The unscoped renderer (another type) makes the card read the artifacts, so
    // only the scope check can keep the scoped one from rendering.
    __unregisterRunResultRenderer('bookai.draft');
    registerRunResultRenderer({ id: 'bookai.draft', match: { artifactTypes: ['other.type'] }, Component: DraftResult });
    registerRunResultRenderer({ id: 'bookai.scoped', match: { artifactTypes: ['bookai.chapter-draft'], workflowIds: ['wf-other'] }, Component: DraftResult });
    impl = async () => [art('draft', 'bookai.chapter-draft')];
    view(run());
    await drain();
    expect(calls).toEqual(['run-9']);
    expect(screen.queryByText(/Chapter draft ready/)).toBeNull();
  });

  it('a renderer that throws is contained; the completion line still renders', async () => {
    __unregisterRunResultRenderer('bookai.draft');
    registerRunResultRenderer({ id: 'bookai.boom', match: { artifactTypes: ['bookai.chapter-draft'] }, Component: Boom });
    impl = async () => [art('draft', 'bookai.chapter-draft')];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      view(run());
      await drain();
      expect(boomRan).toBeGreaterThan(0); // it DID match and throw
      expect(screen.getByText(/completed/i)).toBeTruthy();
    } finally {
      err.mockRestore();
    }
  });

  it('refuses a duplicate id or a renderer that matches nothing', () => {
    expect(() => registerRunResultRenderer({ id: 'bookai.draft', match: { artifactTypes: ['x'] }, Component: DraftResult })).toThrow(/already registered/);
    expect(() => registerRunResultRenderer({ id: 'bookai.none', match: { artifactTypes: [] }, Component: DraftResult })).toThrow(/at least one/);
  });
});
