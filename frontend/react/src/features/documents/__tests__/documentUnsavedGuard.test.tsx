/**
 * DOCTPL-1 (the FORM-UX-2/ADR 0584 class) — the markdown editor's IN-APP
 * unsaved guard. `beforeunload` never fires for a react-router navigation, and
 * the page renders its own exits, so before this fix ONE CLICK on "Back to
 * documents" silently discarded unsaved edits — while the page's own `dirty`
 * flag knew. Both polarities asserted:
 *   - dirty + cancel  → stays, edits intact;
 *   - dirty + confirm → leaves;
 *   - clean           → no dialog at all (the guard must not nag).
 * Plus the promote divergence: promote used to convert the SAVED version while
 * the screen showed a diverged draft — it now saves the draft first, so what is
 * promoted is what the user sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({
  getDocument: vi.fn(), listVersions: vi.fn(), addVersion: vi.fn(),
  promoteToHtml: vi.fn(), patchDocument: vi.fn(), deleteDocument: vi.fn(),
}));
vi.mock('../documentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../documentsClient.js')>();
  return {
    ...orig,
    getDocument: api.getDocument, listVersions: api.listVersions, addVersion: api.addVersion,
    promoteToHtml: api.promoteToHtml, patchDocument: api.patchDocument, deleteDocument: api.deleteDocument,
  };
});

const confirmMock = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock.confirm }));

const canvas = vi.hoisted(() => ({ createCanvas: vi.fn(), saveCanvas: vi.fn() }));
vi.mock('../../../canvas/canvasClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../canvas/canvasClient.js')>();
  return { ...orig, createCanvasClient: () => ({ createCanvas: canvas.createCanvas, saveCanvas: canvas.saveCanvas }) };
});
vi.mock('../../document-editor/documentSchema.js', () => ({
  htmlToDocumentJson: () => ({ type: 'doc', content: [] }),
  documentExtensions: () => [],
}));

import { DocumentDetailPage } from '../DocumentDetailPage.js';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}
function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/documents/:documentId" element={<DocumentDetailPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const baseDoc = {
  documentId: 'doc_1', orgId: 'org_1', kind: 'prd', format: 'markdown', title: 'My PRD',
  status: 'draft', currentVersionId: 'v1', createdAt: '2026-07-11T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z',
  currentVersion: { versionId: 'v1', documentId: 'doc_1', version: 1, content: '# Hi', createdAt: '2026-07-11T00:00:00Z' },
};

async function loadDirty(): Promise<void> {
  renderAt('/documents/doc_1?org=org_1');
  const box = await screen.findByRole('textbox', { name: 'Document content (Markdown)' });
  fireEvent.change(box, { target: { value: '# Hi — edited, unsaved' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.getDocument.mockResolvedValue(baseDoc);
  api.listVersions.mockResolvedValue([]);
  api.addVersion.mockResolvedValue({ versionId: 'v2', documentId: 'doc_1', version: 2, content: 'x', createdAt: '2026-07-11T01:00:00Z' });
  api.promoteToHtml.mockResolvedValue({ html: '<h1>Hi</h1>', title: 'My PRD', promotedCanvasId: null });
  api.patchDocument.mockResolvedValue({ ...baseDoc, promotedCanvasId: 'cv_new' });
  canvas.createCanvas.mockResolvedValue({ canvasId: 'cv_new', canvasTypeId: 'canvas.document', version: 1, state: {} });
  canvas.saveCanvas.mockResolvedValue({ canvasId: 'cv_new', newVersion: 2 });
});
afterEach(cleanup);

describe('DOCTPL-1 — the in-app unsaved guard on the markdown editor', () => {
  it('dirty + cancel: the back link asks, the user stays, the edit survives', async () => {
    confirmMock.confirm.mockResolvedValueOnce(false);
    await loadDirty();
    fireEvent.click(screen.getByRole('link', { name: /Back to documents/ }));
    await waitFor(() => expect(confirmMock.confirm).toHaveBeenCalledTimes(1));
    // Still on the editor: no location probe rendered, the edited draft intact.
    expect(screen.queryByTestId('loc')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Document content (Markdown)' }) as HTMLTextAreaElement).value).toBe('# Hi — edited, unsaved');
  });

  it('dirty + confirm: the back link navigates after the user chooses to discard', async () => {
    confirmMock.confirm.mockResolvedValueOnce(true);
    await loadDirty();
    fireEvent.click(screen.getByRole('link', { name: /Back to documents/ }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/documents'));
    expect(confirmMock.confirm).toHaveBeenCalledTimes(1);
  });

  it('clean: the back link navigates with NO dialog (the guard must not nag)', async () => {
    renderAt('/documents/doc_1?org=org_1');
    await screen.findByRole('textbox', { name: 'Document content (Markdown)' });
    fireEvent.click(screen.getByRole('link', { name: /Back to documents/ }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/documents'));
    expect(confirmMock.confirm).not.toHaveBeenCalled();
  });

  it('promote while dirty SAVES the on-screen draft first — what is promoted is what the user sees', async () => {
    await loadDirty();
    fireEvent.click(screen.getByRole('button', { name: 'Promote to rich document' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/document-editor/cv_new'));
    expect(api.addVersion).toHaveBeenCalledWith('org_1', 'doc_1', '# Hi — edited, unsaved');
    // Order: the save lands BEFORE the render-to-HTML read.
    const saveOrder = api.addVersion.mock.invocationCallOrder[0]!;
    const promoteOrder = api.promoteToHtml.mock.invocationCallOrder[0]!;
    expect(saveOrder).toBeLessThan(promoteOrder);
  });

  it('promote while clean does NOT mint a version', async () => {
    renderAt('/documents/doc_1?org=org_1');
    await screen.findByRole('textbox', { name: 'Document content (Markdown)' });
    fireEvent.click(screen.getByRole('button', { name: 'Promote to rich document' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/document-editor/cv_new'));
    expect(api.addVersion).not.toHaveBeenCalled();
  });

  it('already promoted + dirty: the "Open the rich document" exit asks before leaving', async () => {
    confirmMock.confirm.mockResolvedValueOnce(false);
    api.getDocument.mockResolvedValue({ ...baseDoc, promotedCanvasId: 'cv_existing' });
    await loadDirty();
    fireEvent.click(screen.getByRole('link', { name: /Open the rich document/ }));
    await waitFor(() => expect(confirmMock.confirm).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('loc')).toBeNull();
  });
});
