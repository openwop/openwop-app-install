/**
 * ART-2 / ADR 0069 — ArtifactWorkbench component coverage. Loads an artifact + its revisions
 * by stable id, renders the preview of the latest revision (`latestRevisionId`, never the head
 * of the list), exposes the five tabs, opens the ADR 0128 P5 ephemeral edit canvas, and
 * surfaces a load error as friendly copy (ART-7). P9: the preview dispatch — untyped JSON and a
 * typed review artifact with no workbench renderer read through the review layout; plain text
 * keeps the workbench's own Markdown. `artifactClient` is mocked so this is a pure component test.
 *
 * Sabotage (w118g4-aw-*): picking `revs[0]`, rendering docked, dropping a TAB, hiding the
 * editable bar, seeding the draft empty, a no-op Reset or Done, showing the raw exception,
 * dropping the `{`/`[` JSON branch, dropping the typed id, or sending plain text through the
 * review preview each turns its case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// ADR 1031 P2 — a fixture typed renderer (it was a product's outline type).
import { TEST_OUTLINE_TYPE } from '../../reviews/__tests__/testOutlineRenderer.js';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

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

/** The preview container once its (possibly lazy) content has settled: the same element
 *  exists on the Markdown and the review-preview branch, so a wrong dispatch reds on a
 *  VALUE below, not on a lookup that times out. */
async function settledPreview(): Promise<HTMLElement> {
  const preview = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.artifact-workbench__preview');
    expect(el).not.toBeNull();
    return el!;
  });
  await waitFor(() => expect(within(preview).queryByText('Loading artifact…')).toBeNull());
  return preview;
}

describe('ArtifactWorkbench (ART-2)', () => {
  it('loads the artifact + latest revision and renders the preview inside a dialog with the five tabs', async () => {
    mockGet.mockResolvedValueOnce(ART);
    mockRevs.mockResolvedValueOnce([REV0, REV]);
    mockRev.mockResolvedValueOnce(REV);

    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);

    expect(await screen.findByText('Q3 variance was within plan.')).toBeTruthy(); // preview content
    expect(screen.getByRole('dialog', { name: 'Quarterly Report' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Quarterly Report' })).toBeTruthy(); // title
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Preview', 'Raw', 'Revisions', 'Diff', 'Provenance']);
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

    // Settle on the canvas (rendered with or without the editable bar), then read the bar.
    await waitFor(() => expect(document.querySelector('.artifact-workbench__canvas')).not.toBeNull());
    const editBtn = screen.getByRole('button', { name: 'Edit' });
    expect(screen.queryByLabelText('Artifact source')).toBeNull(); // no editor until toggled
    fireEvent.click(editBtn);
    const src = await screen.findByLabelText('Artifact source');
    expect((src as HTMLTextAreaElement).value).toBe('graph TD; A-->B'); // seeded from the persisted source
    // Reset restores the persisted source over a scratch edit; Done closes the editor.
    fireEvent.change(src, { target: { value: 'graph TD; X-->Y' } });
    expect((src as HTMLTextAreaElement).value).toBe('graph TD; X-->Y');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect((screen.getByLabelText('Artifact source') as HTMLTextAreaElement).value).toBe('graph TD; A-->B');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Artifact source')).toBeNull();
  });

  it('surfaces a load error instead of a blank workbench', async () => {
    mockGet.mockRejectedValueOnce(new Error('artifact_unreachable'));
    mockRevs.mockResolvedValueOnce([]);

    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);
    // ART-7 — a load failure now surfaces friendly localized copy (not the raw
    // exception message); the point is an error renders, not a blank workbench.
    // The error Notice (role=alert) renders on either message, so a raw exception reds on its TEXT.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent?.trim()).toBe('Could not load this artifact. Please try again.');
    expect(screen.queryByText(/artifact_unreachable/)).toBeNull(); // never the raw exception
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Artifact'); // the fallback title, nothing loaded
  });
  // P9 — an untyped JSON run output, and a typed review artifact the workbench
  // has no renderer for, both used to preview as Markdown of the raw JSON.
  it('an untyped JSON output previews as fields; the Raw tab still has the exact bytes', async () => {
    const raw = JSON.stringify({ approvalId: 'appr:1', state: 'submitted' }, null, 2);
    mockGet.mockResolvedValueOnce({ ...ART, title: 'Approval request (submitted)', kind: 'data', format: 'application/json' });
    mockRevs.mockResolvedValueOnce([REV]);
    mockRev.mockResolvedValueOnce({ ...REV, content: raw });
    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);
    const preview = await settledPreview();
    expect(preview.querySelector('.readable-json__status')?.textContent).toBe('Submitted and awaiting review. Not published yet.');
    expect(within(preview).getByText('Approval id').tagName).toBe('DT');
    expect(preview.textContent).not.toContain('"approvalId"'); // not a Markdown dump of the JSON
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    expect(document.querySelector('.artifact-workbench__raw')?.textContent).toBe(raw);
  });

  it('a typed review artifact with no workbench renderer uses its review layout', async () => {
    const plan = { title: 'Twenty-One Days of Focus', promise: 'p', audience: 'a', outcomes: [], achievements: [],
      days: [{ day: 1, stableActivityId: 'd1', title: 'First block', actionInstruction: 'Focus.', userFacingWhy: '', achievementIds: [], evidencePolicy: 'note', claimRefs: [] }] };
    mockGet.mockResolvedValueOnce({ ...ART, artifactTypeId: TEST_OUTLINE_TYPE, kind: 'data', format: 'application/json' });
    mockRevs.mockResolvedValueOnce([REV]);
    mockRev.mockResolvedValueOnce({ ...REV, content: JSON.stringify(plan) });
    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);
    const preview = await settledPreview();
    expect(within(preview).queryAllByRole('listitem').map((li) => li.textContent)).toEqual(['Day 1: First block']);
  });

  it('plain text still previews through Markdown, unchanged', async () => {
    mockGet.mockResolvedValueOnce(ART);
    mockRevs.mockResolvedValueOnce([REV]);
    mockRev.mockResolvedValueOnce(REV);
    render(<ArtifactWorkbench artifactId="run-event:r:n" onClose={() => {}} />);
    const preview = await settledPreview();
    expect(preview.textContent?.trim()).toBe('Q3 variance was within plan.');
    // The workbench's OWN Markdown, not the review preview wrapped around it.
    expect(preview.querySelector('.assetpreview-asset')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
