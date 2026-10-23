/**
 * XCH-GATE-1 / XCH-LB-3 — what a Challenge Factory lesson checkpoint shows its
 * approver: each lesson beside the plan day it was built from, its citations,
 * and its generated image through the shared `mediaSrc` allowlist. Before this
 * renderer the gate showed `{childRunId, childStatus}` and the batch was
 * approved blind.
 *
 * Sabotage that turns it red: unregistering the renderer drops to the markdown
 * path (the plan row text disappears); showing the plan title instead of its
 * instruction; skipping `mediaSrc` lets the `javascript:` URL through; a failed
 * image read rendering nothing reds the failure case; reading an unparseable
 * batch, or valid JSON with no `lessons` array, as an EMPTY batch reds the
 * unreadable case.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ArtifactProjection, ArtifactRevision } from '../../artifacts/artifactClient.js';

const getArtifact = vi.fn<typeof import('../../artifacts/artifactClient.js')['getArtifact']>();
const getArtifactRevision = vi.fn<typeof import('../../artifacts/artifactClient.js')['getArtifactRevision']>();
vi.mock('../../artifacts/artifactClient.js', () => ({
  getArtifact: (id: string) => getArtifact(id),
  getArtifactRevision: (id: string, revisionId: string) => getArtifactRevision(id, revisionId),
}));

const { AssetPreview } = await import('../AssetPreview.js');

afterEach(() => { cleanup(); getArtifact.mockReset(); getArtifactRevision.mockReset(); });

interface FixtureLesson { day: number; title: string; body: string; steps: string[]; claimRefs: string[]; mediaAssetId?: string; plan: { title: string; actionInstruction: string; userFacingWhy: string } }
const batch = (lessons: FixtureLesson[]) => JSON.stringify({ lessons, count: lessons.length, mediaCount: lessons.filter((l) => l.mediaAssetId).length });
const lesson: FixtureLesson = {
  day: 2, title: 'Wake steady', body: 'Wake at the same time every day to anchor your rhythm.',
  steps: ['Set one alarm', 'Get daylight'], claimRefs: ['c-1'],
  plan: { title: 'Consistent wake', actionInstruction: 'Wake at 7 every day.', userFacingWhy: 'A steady rhythm helps sleep onset.' },
};

/** The media artifact projection the host serves for a lesson image (`media:<assetId>`). */
const mediaArtifact = (assetId: string): ArtifactProjection => ({
  artifactId: `media:${assetId}`, tenantId: 't1', orgId: 'o1', source: 'media', sourceId: assetId,
  title: 'Day 2 image', kind: 'image', format: 'image/png', status: 'ready', latestRevisionId: `${assetId}:1`,
  createdBy: { kind: 'run', id: 'run-1' }, createdAt: '2026-01-01T00:00:00Z', provenance: { runId: 'run-1' },
});
const mediaRevision = (assetId: string, content: string): ArtifactRevision => ({
  revisionId: `${assetId}:1`, artifactId: `media:${assetId}`, version: 1, content,
  createdBy: { kind: 'run', id: 'run-1' }, createdAt: '2026-01-01T00:00:00Z',
});

describe('kicktodo.challenge-lesson-batch review renderer', () => {
  it('shows each lesson beside its plan row and citations — never raw JSON', () => {
    render(<AssetPreview asset={{ content: batch([lesson]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    expect(screen.getByRole('heading', { name: 'Day 2: Wake steady' })).toBeTruthy();
    expect(screen.getByText('Plan: Wake at 7 every day.')).toBeTruthy();
    expect(screen.getByText('Why: A steady rhythm helps sleep onset.')).toBeTruthy();
    expect(screen.getByText('Wake at the same time every day to anchor your rhythm.')).toBeTruthy();
    expect(screen.getByText('Set one alarm')).toBeTruthy();
    expect(screen.getByText('Get daylight')).toBeTruthy();
    expect(screen.getByText('Cites evidence: c-1')).toBeTruthy();
    expect(screen.queryByText(/"lessons"/)).toBeNull();
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it('a lesson citing nothing says so', () => {
    render(<AssetPreview asset={{ content: batch([{ ...lesson, claimRefs: [] }]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    expect(screen.getByText('Cites no evidence (stays within the plan day).')).toBeTruthy();
  });

  it('renders the lesson image through the media artifact and the mediaSrc allowlist', async () => {
    getArtifact.mockResolvedValue(mediaArtifact('a1'));
    getArtifactRevision.mockResolvedValue(mediaRevision('a1', 'https://cdn.example/day2.png'));
    const { container } = render(<AssetPreview asset={{ content: batch([{ ...lesson, mediaAssetId: 'a1' }]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    expect(getArtifact).toHaveBeenCalledWith('media:a1');
    expect(getArtifactRevision).toHaveBeenCalledWith('media:a1', 'a1:1');
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://cdn.example/day2.png');
    expect(img.getAttribute('alt')).toBe('Generated image for day 2');
  });

  it('a disallowed image URL or a failed read says the image could not load — never silently nothing', async () => {
    getArtifact.mockResolvedValue(mediaArtifact('a1'));
    getArtifactRevision.mockResolvedValue(mediaRevision('a1', 'javascript:alert(1)'));
    const first = render(<AssetPreview asset={{ content: batch([{ ...lesson, mediaAssetId: 'a1' }]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not be loaded/));
    expect(first.container.querySelector('img')).toBeNull();
    cleanup();
    // The artifact client's real failure shape: `${error}: ${message}`.
    getArtifact.mockRejectedValue(new Error('forbidden: HTTP 403'));
    const second = render(<AssetPreview asset={{ content: batch([{ ...lesson, mediaAssetId: 'a2' }]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not be loaded/));
    expect(second.container.querySelector('img')).toBeNull();
  });

  it('an unreadable batch is an alert telling the approver not to approve — never "empty"', () => {
    // Not JSON at all, and valid JSON that carries no `lessons` array.
    for (const content of ['{not json', '{"count":0}']) {
      render(<AssetPreview asset={{ content, artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
      expect(screen.getByRole('alert').textContent).toMatch(/could not be read\. Do not approve it/);
      expect(screen.queryByText('This checkpoint has no lessons to show.')).toBeNull();
      cleanup();
    }
  });

  it('a readable batch with no lessons says there is nothing to show', () => {
    render(<AssetPreview asset={{ content: batch([]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    expect(screen.getByText('This checkpoint has no lessons to show.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
