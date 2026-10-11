/**
 * ADR 0838 D2/D5/D6 on the detail page: the version history can view, compare
 * and (non-destructively) restore; a save is CHECKED against the loaded version;
 * approving names the version on screen; and the page says when the share link
 * serves an older approved version.
 *
 * Sabotage witnesses (grade-tests w14): swapped diff ids, no view panel, an
 * unchecked save, restore not shown on screen, restore enabled while dirty, a
 * generic stale_base message, approve while dirty, no version pin, the
 * published-behind notice / chip hidden, approve-latest ignored, draft→final
 * offered, no save announcement, write controls for a viewer, Approved offered
 * without host:members:manage, final re-pinning the draft — each turns its case
 * red. The lazy history panel is imported statically below, so no case depends
 * on another having paid its cold load (shuffle-safe).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null, loading: false }),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../ui/announce.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../ui/announce.js')>()), announce: vi.fn() }));
const accessMock = vi.hoisted(() => ({ scopes: ['workspace:read', 'workspace:write', 'host:members:manage'] as string[] }));
vi.mock('../../../client/accessClient.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../client/accessClient.js')>()), getEffectiveAccess: vi.fn(async () => ({ roles: [], scopes: accessMock.scopes, basis: 'member' })) }));

const api = vi.hoisted(() => ({
  getDocument: vi.fn(), listVersions: vi.fn(), addVersion: vi.fn(), patchDocument: vi.fn(), diffArtifact: vi.fn(),
}));
vi.mock('../documentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../documentsClient.js')>();
  return { ...orig, getDocument: api.getDocument, listVersions: api.listVersions, addVersion: api.addVersion, patchDocument: api.patchDocument };
});
vi.mock('../../../chat/artifacts/artifactClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../chat/artifacts/artifactClient.js')>();
  return { ...orig, diffArtifact: api.diffArtifact };
});

import { DocumentDetailPage } from '../DocumentDetailPage.js';
// Warm the React.lazy chunk at file load: the panel's cold import otherwise lands
// on whichever case runs first, and the sync panel reads below depend on it.
import '../DocumentVersionHistory.js';
import { DocumentsApiError } from '../documentsClient.js';
import { announce } from '../../../ui/announce.js';

const AT = '2026-10-06T00:00:00Z';
const v = (n: number, content: string) => ({ versionId: `d:${n}`, documentId: 'd', version: n, content, createdAt: AT });

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/documents/d?org=o']}>
      <Routes><Route path="/documents/:documentId" element={<DocumentDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.getDocument.mockResolvedValue({
    documentId: 'd', orgId: 'o', kind: 'sow', format: 'markdown', title: 'SOW', status: 'draft',
    currentVersionId: 'd:2', createdAt: AT, updatedAt: AT, currentVersion: v(2, 'second text'),
  });
  api.listVersions.mockResolvedValue([v(2, 'second text'), v(1, 'first text')]);
  api.addVersion.mockImplementation(async (_o: string, _d: string, content: string) => v(3, content));
  api.diffArtifact.mockResolvedValue({ artifactId: 'document:d', from: 'd:1', to: 'd:2', diff: { format: 'text', added: 1, removed: 1, lines: [{ op: 'remove', text: 'first text' }, { op: 'add', text: 'second text' }] } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ADR 0838 D6 — version history', () => {
  it('views an old version, compares it with the current one through the shared diff', async () => {
    renderPage();
    // The first render in this file is the slow one (cold lazy panel + page):
    // ~0.4 s alone, and past findByRole's 1 s default on contended gates, where
    // it went red twice. Give that first find room; the rest stay at 1 s.
    fireEvent.click(await screen.findByRole('button', { name: 'View version 1' }, { timeout: 5000 }));
    expect(await screen.findByRole('region', { name: 'View version 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Compare version 1 with the current version' }));
    await waitFor(() => expect(api.diffArtifact).toHaveBeenCalledWith('document:d', 'd:1', 'd:2'));
    const region = await screen.findByRole('region', { name: 'Compare version 1 with the current version' });
    await waitFor(() => expect(within(region).getByText('+1')).toBeTruthy());
  });

  it('restore saves the old text as a NEW version, checked against the current one', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(api.addVersion).toHaveBeenCalledWith('o', 'd', 'first text', 'd:2'));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('first text'));
  });

  it('restore is disabled while the editor holds unsaved text', async () => {
    renderPage();
    const box = await screen.findByRole('textbox');
    const restore = await screen.findByRole('button', { name: 'Restore version 1' });
    fireEvent.change(box, { target: { value: 'unsaved' } });
    expect((restore as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ADR 0838 D5 — a checked save', () => {
  it('sends the loaded version as the base, and a stale_base refusal says what happened', async () => {
    api.addVersion.mockRejectedValueOnce(new DocumentsApiError('newer', 409, 'stale_base'));
    renderPage();
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'my edit' } });
    fireEvent.click(screen.getByRole('button', { name: /Save version/ }));
    await waitFor(() => expect(api.addVersion).toHaveBeenCalledWith('o', 'd', 'my edit', 'd:2'));
    expect(await screen.findByText(/Someone saved a newer version/)).toBeTruthy();
    // The user's text is kept.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('my edit');
  });
});

describe('ADR 0838 D2 — approve what you see; say what the link shows', () => {
  it('approving names the version on screen, and refuses while there are unsaved changes', async () => {
    api.patchDocument.mockResolvedValue({ status: 'approved', approvedVersionId: 'd:2' });
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Status' });
    expect(within(select).getByRole('option', { name: 'In review' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });
    fireEvent.change(select, { target: { value: 'approved' } });
    expect(await screen.findByText(/Save your changes first/)).toBeTruthy();
    expect(api.patchDocument).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'second text' } });
    fireEvent.change(select, { target: { value: 'approved' } });
    await waitFor(() => expect(api.patchDocument).toHaveBeenCalledWith('o', 'd', { status: 'approved', approvedVersionId: 'd:2' }));
  });

  it('an approved document whose latest version is not the published one says so, with an approve-latest action', async () => {
    api.getDocument.mockResolvedValue({
      documentId: 'd', orgId: 'o', kind: 'sow', format: 'markdown', title: 'SOW', status: 'approved',
      currentVersionId: 'd:2', approvedVersionId: 'd:1', createdAt: AT, updatedAt: AT, currentVersion: v(2, 'second text'),
    });
    api.patchDocument.mockResolvedValue({ status: 'approved', approvedVersionId: 'd:2' });
    renderPage();
    expect(await screen.findByText(/The share link shows version 1/)).toBeTruthy();
    expect(await screen.findByText('Published')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve latest version' }));
    await waitFor(() => expect(api.patchDocument).toHaveBeenCalledWith('o', 'd', { status: 'approved', approvedVersionId: 'd:2' }));
    await waitFor(() => expect(screen.queryByText(/The share link shows version 1/)).toBeNull());
  });
});

describe('grade-ux row 24 — offer only what the server allows, and say what happened', () => {
  it('the status select offers only legal moves (draft cannot jump to final)', async () => {
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Status' });
    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['draft', 'in-review', 'approved']);
  });

  it('a saved version is announced to assistive tech', async () => {
    renderPage();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'new text' } });
    fireEvent.click(screen.getByRole('button', { name: /Save version/ }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Saved as version 3.'));
  });
});

describe('grade-ux row 24 — a read-only member is not offered writes', () => {
  afterEach(() => { accessMock.scopes = ['workspace:read', 'workspace:write', 'host:members:manage']; });
  it('a viewer sees no save/delete/restore and a read-only editor', async () => {
    accessMock.scopes = ['workspace:read'];
    renderPage();
    expect(await screen.findByText(/You can read this document/)).toBeTruthy();
    // The history panel is mounted (so Restore's absence is a real answer).
    await screen.findByRole('button', { name: 'View version 1' });
    expect(screen.queryByRole('button', { name: /Save version/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore version 1' })).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('a writer who cannot approve is not offered Approved', async () => {
    accessMock.scopes = ['workspace:read', 'workspace:write'];
    renderPage();
    await screen.findByRole('button', { name: /Save version/ });
    await waitFor(() => {
      const values = within(screen.getByRole('combobox', { name: 'Status' })).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
      expect(values).toEqual(['draft', 'in-review']);
    });
  });
});

describe('grade-code row 24 — finalising keeps the published version', () => {
  it('approved → final sends the already-published version, not the newer draft', async () => {
    api.getDocument.mockResolvedValue({
      documentId: 'd', orgId: 'o', kind: 'sow', format: 'markdown', title: 'SOW', status: 'approved',
      currentVersionId: 'd:2', approvedVersionId: 'd:1', createdAt: AT, updatedAt: AT, currentVersion: v(2, 'second text'),
    });
    api.patchDocument.mockResolvedValue({ status: 'final', approvedVersionId: 'd:1' });
    renderPage();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Status' }), { target: { value: 'final' } });
    await waitFor(() => expect(api.patchDocument).toHaveBeenCalledWith('o', 'd', { status: 'final', approvedVersionId: 'd:1' }));
  });
});
