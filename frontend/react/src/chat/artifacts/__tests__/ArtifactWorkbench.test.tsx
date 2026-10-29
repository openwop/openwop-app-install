/**
 * ART-2 — ArtifactWorkbench component coverage. Loads an artifact + its revisions by stable
 * id, renders the preview of the latest revision, exposes the five tabs, and surfaces a load
 * error. `artifactClient` is mocked so this is a pure component test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../artifactClient.js', () => ({
  getArtifact: vi.fn(), listArtifactRevisions: vi.fn(), getArtifactRevision: vi.fn(), diffArtifact: vi.fn(),
}));
import {
  getArtifact, listArtifactRevisions, getArtifactRevision,
  type ArtifactProjection, type ArtifactRevision,
} from '../artifactClient.js';
import { ArtifactWorkbench } from '../ArtifactWorkbench.js';
// The interactive-artifact renderers (interactive.mermaid, …) register the
// `editable` flag the workbench's Edit canvas gates on. Production wires this at
// chat boot (ChatTab); this isolated component test must establish the same
// precondition (idempotent — the registry guards against double-registration).
import { registerDefaultArtifactRenderers } from '../defaultRenderers.js';

const mockGet = vi.mocked(getArtifact);
const mockRevs = vi.mocked(listArtifactRevisions);
const mockRev = vi.mocked(getArtifactRevision);

const ART: ArtifactProjection = {
  artifactId: 'run-event:r:n', tenantId: 't', orgId: 'org', source: 'run-event', sourceId: 'r:n',
  title: 'Quarterly Report', kind: 'markdown', format: 'text/markdown', status: 'final',
  latestRevisionId: 'rev1', createdBy: { kind: 'run', id: 'run1' },
  createdAt: '2026-06-20T00:00:00.000Z', provenance: { runId: 'run1' },
};
const REV: ArtifactRevision = {
  revisionId: 'rev1', artifactId: 'run-event:r:n', version: 1,
  content: 'Q3 variance was within plan.', createdBy: { kind: 'run', id: 'run1' }, createdAt: '2026-06-20T00:00:00.000Z',
};
/** An OLDER revision listed FIRST, so `revs[0]` is not the latest — the workbench
 *  must pick `latestRevisionId` (rev1), not the head of the list. */
const REV0: ArtifactRevision = { ...REV, revisionId: 'rev0', version: 0, content: 'Draft zero.' };

beforeEach(() => { registerDefaultArtifactRenderers(); mockGet.mockReset(); mockRevs.mockReset(); mockRev.mockReset(); });
afterEach(cleanup);

describe('ArtifactWorkbench (ART-2)', () => {
  it('loads the artifact + latest revision and renders the preview inside a dialog with the five tabs', async () => {
    mockGet.mockResolvedValueOnce(ART);
    mockRevs.mockResolvedValueOnce([REV0, REV]);
    mockRev.mockResolvedValueOnce(REV);

    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);

    expect(await screen.findByText('Q3 variance was within plan.')).toBeTruthy(); // preview content
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Quarterly Report')).toBeTruthy();                      // title
    expect(screen.getAllByRole('tab')).toHaveLength(5);                             // preview/raw/revisions/diff/provenance
    expect(mockGet).toHaveBeenCalledWith('run-event:r:n');
    expect(mockRev).toHaveBeenCalledTimes(1);
    expect(mockRev).toHaveBeenCalledWith('run-event:r:n', 'rev1');                  // loaded the latest revision, not revs[0]
  });

  it('ADR 0128 Phase 5 — an interactive artifact exposes the ephemeral edit canvas (Edit → source textarea)', async () => {
    const interactive: ArtifactProjection = { ...ART, artifactTypeId: 'interactive.mermaid', kind: 'interactive', format: 'text/vnd.mermaid', title: 'Flow' };
    const rev: ArtifactRevision = { ...REV, content: 'graph TD; A-->B' };
    mockGet.mockResolvedValueOnce(interactive);
    mockRevs.mockResolvedValueOnce([rev]);
    mockRev.mockResolvedValueOnce(rev);

    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);

    const editBtn = await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByLabelText('Artifact source')).toBeNull(); // no editor until toggled
    fireEvent.click(editBtn);
    const src = await screen.findByLabelText('Artifact source');
    expect((src as HTMLTextAreaElement).value).toBe('graph TD; A-->B'); // seeded from the persisted source
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('surfaces a load error instead of a blank workbench', async () => {
    mockGet.mockRejectedValueOnce(new Error('artifact_unreachable'));
    mockRevs.mockResolvedValueOnce([]);

    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);
    // ART-7 — a load failure now surfaces friendly localized copy (not the raw
    // exception message); the point is an error renders, not a blank workbench.
    expect(await screen.findByText('Could not load this artifact. Please try again.')).toBeTruthy();
    expect(screen.queryByText(/artifact_unreachable/)).toBeNull(); // never the raw exception
    expect(screen.queryByText('Quarterly Report')).toBeNull();
  });
  // P9 — an untyped JSON run output, and a typed review artifact the workbench
  // has no renderer for, both used to preview as Markdown of the raw JSON.
  it('an untyped JSON output previews as fields; the Raw tab still has the exact bytes', async () => {
    const raw = JSON.stringify({ approvalId: 'appr:1', state: 'submitted' }, null, 2);
    mockGet.mockResolvedValueOnce({ ...ART, title: 'Approval request (submitted)', kind: 'data', format: 'application/json' });
    mockRevs.mockResolvedValueOnce([REV]);
    mockRev.mockResolvedValueOnce({ ...REV, content: raw });
    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);
    expect(await screen.findByText('Submitted and awaiting review. Not published yet.')).toBeTruthy();
    expect(screen.getByText('Approval id')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    expect(document.querySelector('.artifact-workbench__raw')?.textContent).toBe(raw);
  });

  it('a typed review artifact with no workbench renderer uses its review layout', async () => {
    const plan = { title: 'Twenty-One Days of Focus', promise: 'p', audience: 'a', outcomes: [], achievements: [],
      days: [{ day: 1, stableActivityId: 'd1', title: 'First block', actionInstruction: 'Focus.', userFacingWhy: '', achievementIds: [], evidencePolicy: 'note', claimRefs: [] }] };
    mockGet.mockResolvedValueOnce({ ...ART, artifactTypeId: 'kicktodo.challenge-plan', kind: 'data', format: 'application/json' });
    mockRevs.mockResolvedValueOnce([REV]);
    mockRev.mockResolvedValueOnce({ ...REV, content: JSON.stringify(plan) });
    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);
    expect(await screen.findByText('Day 1: First block')).toBeTruthy();
  });

  it('plain text still previews through Markdown, unchanged', async () => {
    mockGet.mockResolvedValueOnce(ART);
    mockRevs.mockResolvedValueOnce([REV]);
    mockRev.mockResolvedValueOnce(REV);
    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);
    expect(await screen.findByText('Q3 variance was within plan.')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
