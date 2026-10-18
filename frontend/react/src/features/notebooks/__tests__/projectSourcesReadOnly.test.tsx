/**
 * grade-ux row 25 B2 — a project VIEWER opening the Sources tab must not POST.
 *
 * `ProjectSourcesPanel` called `ensureNotebook` (a POST that provisions a corpus) on open.
 * For a read-only member that 403'd and rendered the raw "Missing required scope" text as
 * a load failure. `readOnly` reads instead, and "no notebook yet" is a designed empty
 * state — while a genuine read failure still says it failed.
 *
 * Sabotage witnesses (w20g5-ro-*): readOnly calling `ensureNotebook` ⇒ case 1; any status (not just
 * 404) mapped to "none" ⇒ case 2; a 404 not mapped to "none" ⇒ case 1. Case 1 asserts the READ-ONLY
 * body copy, because the title "No sources yet" is shared with the ordinary empty workspace.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const ensureNotebook = vi.fn();
const getNotebook = vi.fn();
vi.mock('../notebooksClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureNotebook: (id: string) => ensureNotebook(id),
  getNotebook: (id: string) => getNotebook(id),
}));

const { ProjectSourcesPanel } = await import('../NotebooksPage.js');

afterEach(() => { cleanup(); ensureNotebook.mockReset(); getNotebook.mockReset(); });

describe('ProjectSourcesPanel readOnly', () => {
  it('reads, never ensures; a project with no sources is an empty state, not an error', async () => {
    getNotebook.mockRejectedValue(Object.assign(new Error('Notebook not found.'), { status: 404 }));
    render(<MemoryRouter><ProjectSourcesPanel projectId="p1" readOnly /></MemoryRouter>);
    await screen.findByText('No sources yet');
    expect(screen.getByText('Someone with edit access to this project can add sources here.')).toBeTruthy();
    expect(getNotebook).toHaveBeenCalledWith('p1');
    expect(ensureNotebook).not.toHaveBeenCalled();
  });

  it('a FAILED read is still a failure, not "no sources"', async () => {
    getNotebook.mockRejectedValue(Object.assign(new Error('upstream 503'), { status: 503 }));
    render(<MemoryRouter><ProjectSourcesPanel projectId="p1" readOnly /></MemoryRouter>);
    await screen.findByText('Failed to load.');
    expect(screen.getByText('upstream 503')).toBeTruthy();
    expect(screen.queryByText('No sources yet')).toBeNull();
  });
});
