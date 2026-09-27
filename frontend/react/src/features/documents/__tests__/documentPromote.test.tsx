/**
 * ADR 0350 Phase 3 — promote a markdown document to a rich `canvas.document`.
 * Pins the one-way, idempotent orchestration: a not-yet-promoted doc renders
 * markdown→HTML (server), converts via the lazy-imported document-editor schema,
 * creates + seeds a canvas, links it back, and navigates to the rich editor; an
 * already-promoted doc offers a link straight to the existing canvas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({
  getDocument: vi.fn(), listVersions: vi.fn(), listOrgs: vi.fn(),
  promoteToHtml: vi.fn(), patchDocument: vi.fn(),
}));
vi.mock('../documentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../documentsClient.js')>();
  return { ...orig, getDocument: api.getDocument, listVersions: api.listVersions, listOrgs: api.listOrgs, promoteToHtml: api.promoteToHtml, patchDocument: api.patchDocument };
});

const canvas = vi.hoisted(() => ({ createCanvas: vi.fn(), saveCanvas: vi.fn() }));
vi.mock('../../../canvas/canvasClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../canvas/canvasClient.js')>();
  return { ...orig, createCanvasClient: () => ({ createCanvas: canvas.createCanvas, saveCanvas: canvas.saveCanvas }) };
});

// The heavy TipTap schema is lazy-imported by the promote flow — mock the helper.
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.listVersions.mockResolvedValue([]);
  api.listOrgs.mockResolvedValue([{ orgId: 'org_1', name: 'Org One' }]);
  api.promoteToHtml.mockResolvedValue({ html: '<h1>Hi</h1>', title: 'My PRD', promotedCanvasId: null });
  api.patchDocument.mockResolvedValue({ ...baseDoc, promotedCanvasId: 'cv_new' });
  canvas.createCanvas.mockResolvedValue({ canvasId: 'cv_new', canvasTypeId: 'canvas.document', version: 1, state: {} });
  canvas.saveCanvas.mockResolvedValue({ canvasId: 'cv_new', newVersion: 2 });
});
afterEach(cleanup);

describe('ADR 0350 Phase 3 — promote to rich document', () => {
  it('promotes: render→convert→create→link→seed→navigate to the rich editor', async () => {
    api.getDocument.mockResolvedValue(baseDoc);
    renderAt('/documents/doc_1?org=org_1');
    fireEvent.click(await screen.findByRole('button', { name: 'Promote to rich document' }));

    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/document-editor/cv_new'));
    expect(api.promoteToHtml).toHaveBeenCalledWith('org_1', 'doc_1');
    expect(canvas.createCanvas).toHaveBeenCalledWith('org_1', { name: 'My PRD' });
    // Linked FIRST (idempotency), then the canvas is seeded with the converted doc.
    expect(api.patchDocument).toHaveBeenCalledWith('org_1', 'doc_1', { promotedCanvasId: 'cv_new' });
    expect(canvas.saveCanvas).toHaveBeenCalledWith('org_1', 'cv_new', { title: 'My PRD', content: { type: 'doc', content: [] } }, 1);
  });

  it('already promoted: offers a link straight to the existing canvas (no re-create)', async () => {
    api.getDocument.mockResolvedValue({ ...baseDoc, promotedCanvasId: 'cv_existing' });
    renderAt('/documents/doc_1?org=org_1');

    // No promote button — instead a link to the existing rich document.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Promote to rich document' })).toBeNull());
    const link = await screen.findByRole('link', { name: /Open the rich document/i });
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/document-editor/cv_existing'));
    expect(canvas.createCanvas).not.toHaveBeenCalled();
  });
});
