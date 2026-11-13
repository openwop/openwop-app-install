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
const confirmSpy = vi.fn(async () => false);
vi.mock('../../../ui/confirm.js', () => ({ confirm: (...a: unknown[]) => confirmSpy(...(a as [])) }));
const ensureNotebookChat = vi.fn(async () => ({ conversationId: 'c1' }));
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const ensureNotebook = vi.fn();
const getNotebook = vi.fn();
const NB = { id: 'p1', tenantId: 't', orgId: 'o', name: 'N', collectionId: 'c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
vi.mock('../notebooksClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureNotebook: (id: string) => ensureNotebook(id),
  getNotebook: (id: string) => getNotebook(id),
  ensureNotebookChat: () => ensureNotebookChat(),
  listSources: vi.fn(async () => [{ documentId: 'd1', title: 'Cat facts', source: { kind: 'text' }, chunkCount: 1, createdAt: '2026-01-01T00:00:00.000Z', contextLevel: 'full', hasSummary: true }]),
  listNotes: vi.fn(async () => [{ id: 'n1', content: 'Copied passage', contentTrust: 'untrusted', createdAt: '2026-01-01T00:00:00.000Z' }]),
  listTransformations: vi.fn(async () => []),
  listTransformationTemplates: vi.fn(async () => [{ id: 'summary', label: 'Summary' }]),
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
    // ADR 1103 D9 (`NBK92-12`) — the failure is stated in the user's locale; the
    // server's English never renders.
    expect(screen.getByText('The sources could not be loaded. Try again in a moment.')).toBeTruthy();
    expect(screen.queryByText('upstream 503')).toBeNull();
    expect(screen.queryByText('No sources yet')).toBeNull();
  });
});

describe('ADR 1103 D9 — a viewer is not offered writes the server refuses', () => {
  it('reads sources, notes and the chat, with no write control anywhere', async () => {
    getNotebook.mockResolvedValue(NB);
    render(<MemoryRouter><ProjectSourcesPanel projectId="p1" readOnly /></MemoryRouter>);
    await screen.findByText('Cat facts');
    // Reads + the chat (read-gated since ADR 1103 D9) are there…
    expect(screen.getByRole('button', { name: /open chat/i })).toBeTruthy();
    expect(screen.getByText('Copied passage')).toBeTruthy();
    // The level as text, with its context for a screen reader.
    expect(screen.getByText(/Full$/, { selector: '.chip' }).textContent).toBe('Context level for “Cat facts”: Full');
    // …and no write is offered.
    for (const name of [/^add source$/i, /^summarize\b/i, /^re-summarize\b/i, /^add note$/i, /apply the chosen transformation/i, /^summary$/i, /^excluded$/i]) {
      expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
    }
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByLabelText('New note')).toBeNull();
    expect(ensureNotebook).not.toHaveBeenCalled();
  });

  it('NBK92-16 — a note copied from a source says so', async () => {
    getNotebook.mockResolvedValue(NB);
    render(<MemoryRouter><ProjectSourcesPanel projectId="p1" readOnly /></MemoryRouter>);
    expect(await screen.findByText('From a source')).toBeTruthy();
  });

  it('CONTROL: a writer sees the controls the viewer does not', async () => {
    ensureNotebook.mockResolvedValue(NB);
    render(<MemoryRouter><ProjectSourcesPanel projectId="p1" /></MemoryRouter>);
    await screen.findByText('Cat facts');
    expect(screen.getByRole('button', { name: /^add source$/i })).toBeTruthy();
    expect(screen.getByLabelText('New note')).toBeTruthy();
    expect(screen.getByRole('combobox')).toBeTruthy();
  });
});

describe('ADR 1103 D9 (NBK92-9) — drafts are reported to the page\'s tab guard', () => {
  it('typing a source marks the panel dirty, clearing it marks it clean, unmount clears it', async () => {
    ensureNotebook.mockResolvedValue(NB);
    const onDirtyChange = vi.fn();
    const r = render(<MemoryRouter><ProjectSourcesPanel projectId="p1" onDirtyChange={onDirtyChange} /></MemoryRouter>);
    const text = await screen.findByLabelText('Source text');
    fireEvent.change(text, { target: { value: 'A pasted paper' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(text, { target: { value: '' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: 'half a thought' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    r.unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('ADR 1103 D9 — leaving with a draft asks first', () => {
  it('Open chat with a dirty draft asks BEFORE minting the room; cancelling stays and mints nothing', async () => {
    ensureNotebook.mockResolvedValue(NB);
    confirmSpy.mockClear(); ensureNotebookChat.mockClear();
    render(<MemoryRouter><ProjectSourcesPanel projectId="p1" /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Source text'), { target: { value: 'unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));
    await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(ensureNotebookChat).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Source text') as HTMLTextAreaElement).value).toBe('unsaved');
  });

  it('CONTROL: with no draft, Open chat does not ask', async () => {
    ensureNotebook.mockResolvedValue(NB);
    confirmSpy.mockClear(); ensureNotebookChat.mockClear();
    render(<MemoryRouter><ProjectSourcesPanel projectId="p1" /></MemoryRouter>);
    await screen.findByLabelText('Source text');
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));
    await vi.waitFor(() => expect(ensureNotebookChat).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
