import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { AppBuilderHubPage } from '../AppBuilderHubPage.js';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  createCanvas: vi.fn(),
}));

vi.mock('../canvasEditorClient.js', () => api);

/** Echoes the decoded route param, so the case can see WHICH canvas opened. */
function EditorAt(): JSX.Element {
  const { canvasId } = useParams();
  return <p>Editor {canvasId}</p>;
}

function view(): void {
  render(
    <MemoryRouter initialEntries={['/app-builder']}>
      <Routes>
        <Route path="/app-builder" element={<AppBuilderHubPage />} />
        <Route path="/app-builder/:canvasId" element={<EditorAt />} />
        <Route path="/documents" element={<p>Documents opened</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppBuilderHubPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  });

  it('creates through the existing typed canvas client and opens the resulting editor', async () => {
    // An id that needs encoding: the route must round-trip it, not truncate it.
    api.createCanvas.mockResolvedValue({ canvasId: 'app 1/x' });
    view();
    // Two buttons share this name (the header action + the card). Wait for the
    // LOADED choices and click inside them — a page-wide findByRole only passed
    // while the orgs read was still pending (one disabled button in the DOM).
    const choices = await screen.findByRole('region', { name: 'App Builder choices' });
    fireEvent.click(within(choices).getByRole('button', { name: 'Start blank app' }));
    await waitFor(() => expect(api.createCanvas).toHaveBeenCalledWith('org-1', { name: 'Untitled app' }));
    expect(await screen.findByText('Editor app 1/x')).toBeTruthy();
  });

  it('uses the unified Documents inventory rather than a second app list', async () => {
    view();
    const open = await screen.findByRole('link', { name: 'Open Documents' });
    fireEvent.click(open);
    expect(await screen.findByText('Documents opened')).toBeTruthy();
  });

  it('sends PRD-to-review authoring through the editable App design workflow template', async () => {
    view();
    const open = await screen.findByRole('link', { name: 'Open App design template' });
    expect(open.getAttribute('href')).toBe('/builder?template=app-builder.design');
  });

  it('does not claim an empty workspace when organization lookup failed', async () => {
    api.listOrgs.mockRejectedValue(new Error('offline'));
    view();
    expect(await screen.findByText('Couldn’t load your workspace')).toBeTruthy();
    expect(screen.queryByText('Choose or join an organization first')).toBeNull();
    // The failure offers its recovery and no creation surface.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'App Builder choices' })).toBeNull();
  });
});
