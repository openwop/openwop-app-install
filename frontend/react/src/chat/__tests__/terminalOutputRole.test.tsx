/**
 * ADR 0600 §4 (`ISU-23`) — the completion card's "View output" affordance.
 *
 * Two defects, both measured on `insights-suite` and both shared-surface:
 *
 *  1. `useTerminalNodes` treated "no outgoing edges" as the definition of a
 *     deliverable, so every node explicitly tagged `outputRole:'primary'` that
 *     had a downstream node was filtered out. In practice that is most of them:
 *     a deliverable is normally followed by an approval gate and a notify. On
 *     two of three insights chains the host's role map moved `primary` onto the
 *     real deliverable (`emailDraft`, `score`) AND cleared the auto-terminal
 *     stamp off `notify` — so the annotation made the card STRICTLY WORSE than
 *     no annotation, which is the opposite of what its author intended.
 *
 *  2. A localStorage cache MISS and "this run produced no readable outputs"
 *     both returned `[]` and rendered the identical bare "Open run". For a
 *     feature with no page — driven from chat, a schedule or a trigger — the
 *     miss is the COMMON case, and the user was told nothing about which of the
 *     two had happened.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkflowCompletionCard } from '../WorkflowCompletionCard.js';
import { upsertSavedWorkflow, deleteSavedWorkflow } from '../../builder/persistence/localStore.js';
import type { SavedWorkflow } from '../../builder/schema/workflow.js';
import type { WorkflowRunState } from '../types.js';

const WF = 'openwop-app.insights.talent-prep';

/** The talent-prep shape: pull → score → notify, `score` tagged primary. */
function saveGraph(scoreRole: 'primary' | 'secondary' | undefined): void {
  const wf: SavedWorkflow = {
    id: WF, name: 'Talent readiness prep', version: '1.0.0',
    nodes: [
      { id: 'pull', kind: 'core.workday.query', name: 'Pull', position: { x: 0, y: 0 }, config: { name: 'Pull' } },
      { id: 'score', kind: 'talent-score', name: 'Nine-box score', position: { x: 1, y: 0 },
        config: { name: 'Nine-box score' }, outputRole: scoreRole },
      { id: 'notify', kind: 'notify', name: 'Notify', position: { x: 2, y: 0 }, config: { name: 'Notify' } },
    ],
    edges: [
      { id: 'e1', source: 'pull', sourcePort: 'output', target: 'score', targetPort: 'input' },
      { id: 'e2', source: 'score', sourcePort: 'output', target: 'notify', targetPort: 'input' },
    ],
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  };
  upsertSavedWorkflow(wf);
}

function run(): WorkflowRunState {
  return {
    slug: 'talent', workflowName: 'Talent readiness prep', workflowId: WF,
    runId: 'r-1', status: 'completed', totalNodes: 3,
    completedNodeIds: ['pull', 'score', 'notify'],
    nodeNames: { pull: 'pull', score: 'score', notify: 'notify' },
    nodeOutputs: { pull: { rows: [] }, score: { box: 5 }, notify: { emitted: true } },
    failedNodeIds: [], startedAt: Date.now(),
  } as unknown as WorkflowRunState;
}

function view(): void {
  render(<MemoryRouter><WorkflowCompletionCard run={run()} onPreviewArtifact={() => {}} /></MemoryRouter>);
}

beforeEach(() => deleteSavedWorkflow(WF));
afterEach(() => { cleanup(); deleteSavedWorkflow(WF); });

describe('useTerminalNodes — an explicit outputRole outranks graph position', () => {
  it('surfaces a node tagged `primary` even though it has an outgoing edge', () => {
    saveGraph('primary');
    view();
    expect(screen.getByRole('button', { name: /Nine-box score/ })).toBeTruthy();
    // …and the notify tail is NOT offered as "the output" alongside it.
    expect(screen.queryByRole('button', { name: /Notify/ })).toBeNull();
  });

  it('WITHOUT the tag the graph terminal still wins (the polarity)', () => {
    // The guard must not become "surface everything": an untagged mid-graph node
    // is not a deliverable, and `notify` legitimately is when nothing else claims it.
    saveGraph(undefined);
    view();
    expect(screen.getByRole('button', { name: /Notify|View output/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Nine-box score/ })).toBeNull();
  });

  it('`secondary` is RETIRED — a mid-graph node tagged secondary is not surfaced', () => {
    // ADR 0600 §Correction 4. §4 retired `secondary` on the stated ground that
    // "nothing in the SPA reads it — the only consumer tests === 'primary'", and
    // explicitly CONSIDERED AND REJECTED inventing a consumer ("quiet secondary
    // links on every completion card app-wide… a visible behaviour change for
    // every workflow in the app, requested by nobody"). The shipped code then
    // read `outputRole === 'primary' || outputRole === 'secondary'`, which is
    // that rejected consumer: with no primary anywhere, a mid-graph `secondary`
    // node entered `terminals` and rendered as a "View output" button. Three
    // shipped statements were false on merge — this asserts the one that makes
    // them true again.
    saveGraph('secondary');
    view();
    expect(screen.queryByRole('button', { name: /Nine-box score/ })).toBeNull();
    // …and the graph terminal still wins, exactly as with no tag at all.
    expect(screen.getByRole('button', { name: /Notify|View output/ })).toBeTruthy();
  });

  it('the graph is NOT cached on this device — the card says so instead of implying nothing was produced', () => {
    // No `saveGraph()` call: the localStorage miss.
    view();
    expect(screen.getByTestId('wfcomplete-graph-unavailable').textContent)
      .toMatch(/isn’t cached on this device/i);
    expect(screen.getByRole('link', { name: /open run/i })).toBeTruthy();
  });

  it('a cached graph does NOT show the cache-miss line (the polarity)', () => {
    saveGraph('primary');
    view();
    expect(screen.queryByTestId('wfcomplete-graph-unavailable')).toBeNull();
  });
});
