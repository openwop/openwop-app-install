import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppBuilderHubPage } from '../AppBuilderHubPage.js';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  createCanvas: vi.fn(),
}));

vi.mock('../canvasEditorClient.js', () => api);

function view(): void {
  render(
    <MemoryRouter initialEntries={['/app-builder']}>
      <Routes>
        <Route path="/app-builder" element={<AppBuilderHubPage />} />
        <Route path="/app-builder/:canvasId" element={<p>Editor opened</p>} />
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
    api.createCanvas.mockResolvedValue({ canvasId: 'app-1' });
    view();
    const create = await screen.findByRole('button', { name: 'Start blank app' });
    fireEvent.click(create);
    await waitFor(() => expect(api.createCanvas).toHaveBeenCalledWith('org-1', { name: 'Untitled app' }));
    expect(await screen.findByText('Editor opened')).toBeTruthy();
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
  });
});
