/**
 * ART-2 — LibraryPage component coverage. The cross-source gallery loads a bounded page,
 * filters by tab, appends the next page via "Load more" (ART-1), and surfaces a load error.
 * `artifactClient` is mocked so this is a pure component test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../artifactClient.js', () => ({ listArtifacts: vi.fn() }));
import { listArtifacts, type ArtifactProjection, type ArtifactPage } from '../artifactClient.js';
import { LibraryPage } from '../LibraryPage.js';

const mockList = vi.mocked(listArtifacts);

function art(id: string, title: string, over: Partial<ArtifactProjection> = {}): ArtifactProjection {
  return {
    artifactId: id, tenantId: 't', orgId: 'org', source: 'run-event', sourceId: id, title,
    kind: 'markdown', format: 'text/markdown', status: 'final', createdBy: { kind: 'run', id: 'run1' },
    createdAt: '2026-06-20T00:00:00.000Z', provenance: { runId: 'run1' }, ...over,
  };
}
const page = (artifacts: ArtifactProjection[], nextCursor?: string): ArtifactPage =>
  (nextCursor ? { artifacts, nextCursor } : { artifacts });

beforeEach(() => mockList.mockReset());
afterEach(cleanup);

describe('LibraryPage (ART-2)', () => {
  it('renders the loaded artifacts and filters to images when the Images tab is selected', async () => {
    mockList.mockResolvedValueOnce(page([
      art('run-event:r:a', 'Report A'),
      art('media:img', 'Diagram', { source: 'media', kind: 'image' }),
    ]));
    render(<LibraryPage />);

    expect(await screen.findByText('Report A')).toBeTruthy();
    expect(screen.getByText('Diagram')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Images' }));
    expect(screen.getByText('Diagram')).toBeTruthy();        // image kept
    expect(screen.queryByText('Report A')).toBeNull();        // non-image filtered out
  });

  it('appends the next page via "Load more", then hides the button when the cursor is exhausted', async () => {
    mockList
      .mockResolvedValueOnce(page([art('a', 'First')], 'cursor-1'))
      .mockResolvedValueOnce(page([art('b', 'Second')])); // no nextCursor ⇒ last page
    render(<LibraryPage />);

    expect(await screen.findByText('First')).toBeTruthy();
    const more = screen.getByRole('button', { name: 'Load more' });
    fireEvent.click(more);

    expect(await screen.findByText('Second')).toBeTruthy();        // appended
    expect(screen.getByText('First')).toBeTruthy();                // first page kept
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(mockList).toHaveBeenLastCalledWith({ limit: 100, cursor: 'cursor-1' });
  });

  it('shows a warning when the Library fails to load', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'));
    render(<LibraryPage />);
    expect(await screen.findByText(/couldn|could not|failed|error/i)).toBeTruthy();
  });

  it('does not render a "Load more" button when the first page is already complete', async () => {
    mockList.mockResolvedValueOnce(page([art('a', 'Only')])); // no nextCursor
    render(<LibraryPage />);
    expect(await screen.findByText('Only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
