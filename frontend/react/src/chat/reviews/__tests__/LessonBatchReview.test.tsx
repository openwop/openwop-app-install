/**
 * XCH-GATE-1 / XCH-LB-3 — what a Challenge Factory lesson checkpoint shows its
 * approver: each lesson beside the plan day it was built from, its citations,
 * and its generated image through the shared `mediaSrc` allowlist. Before this
 * renderer the gate showed `{childRunId, childStatus}` and the batch was
 * approved blind.
 *
 * Sabotage: unregistering the renderer drops to the markdown path (the plan row
 * text disappears); skipping `mediaSrc` lets the `javascript:` URL through; a
 * failed image read rendering nothing reds the failure case.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const getArtifact = vi.fn();
const getArtifactRevision = vi.fn();
vi.mock('../../artifacts/artifactClient.js', () => ({
  getArtifact: (...a: unknown[]) => getArtifact(...a),
  getArtifactRevision: (...a: unknown[]) => getArtifactRevision(...a),
}));

const { AssetPreview } = await import('../AssetPreview.js');

afterEach(() => { cleanup(); getArtifact.mockReset(); getArtifactRevision.mockReset(); });

const batch = (lessons: unknown[]) => JSON.stringify({ lessons, count: lessons.length, mediaCount: 0 });
const lesson = {
  day: 2, title: 'Wake steady', body: 'Wake at the same time every day to anchor your rhythm.',
  steps: ['Set one alarm', 'Get daylight'], claimRefs: ['c-1'],
  plan: { title: 'Consistent wake', actionInstruction: 'Wake at 7 every day.', userFacingWhy: 'A steady rhythm helps sleep onset.' },
};

describe('kicktodo.challenge-lesson-batch review renderer', () => {
  it('shows each lesson beside its plan row and citations — never raw JSON', () => {
    render(<AssetPreview asset={{ content: batch([lesson]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    expect(screen.getByRole('heading', { name: 'Day 2: Wake steady' })).toBeTruthy();
    expect(screen.getByText('Plan: Wake at 7 every day.')).toBeTruthy();
    expect(screen.getByText('Why: A steady rhythm helps sleep onset.')).toBeTruthy();
    expect(screen.getByText(lesson.body)).toBeTruthy();
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
    getArtifact.mockResolvedValue({ format: 'image/png', latestRevisionId: 'a1:1' });
    getArtifactRevision.mockResolvedValue({ content: 'https://cdn.example/day2.png' });
    const { container } = render(<AssetPreview asset={{ content: batch([{ ...lesson, mediaAssetId: 'a1' }]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    expect(getArtifact).toHaveBeenCalledWith('media:a1');
    expect(getArtifactRevision).toHaveBeenCalledWith('media:a1', 'a1:1');
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://cdn.example/day2.png');
    expect(img.getAttribute('alt')).toBe('Generated image for day 2');
  });

  it('a disallowed image URL or a failed read says the image could not load — never silently nothing', async () => {
    getArtifact.mockResolvedValue({ format: 'image/png', latestRevisionId: 'a1:1' });
    getArtifactRevision.mockResolvedValue({ content: 'javascript:alert(1)' });
    const first = render(<AssetPreview asset={{ content: batch([{ ...lesson, mediaAssetId: 'a1' }]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not be loaded/));
    expect(first.container.querySelector('img')).toBeNull();
    cleanup();
    getArtifact.mockRejectedValue(new Error('403'));
    render(<AssetPreview asset={{ content: batch([{ ...lesson, mediaAssetId: 'a2' }]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not be loaded/));
  });

  it('an unreadable batch is an alert telling the approver not to approve — never "empty"', () => {
    render(<AssetPreview asset={{ content: '{not json', artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    expect(screen.getByRole('alert').textContent).toMatch(/could not be read\. Do not approve it/);
    expect(screen.queryByText('This checkpoint has no lessons to show.')).toBeNull();
  });

  it('a readable batch with no lessons says there is nothing to show', () => {
    render(<AssetPreview asset={{ content: batch([]), artifactTypeId: 'kicktodo.challenge-lesson-batch' }} hideLabel />);
    expect(screen.getByText('This checkpoint has no lessons to show.')).toBeTruthy();
  });
});
