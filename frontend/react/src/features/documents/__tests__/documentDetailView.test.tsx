/**
 * ADR 0350 Phase 2 — the per-document page's Write / Split / Preview toggle. The
 * preview reuses `ui/Markdown` (a live projection of the textarea buffer, not a
 * second store); the toggle shows/hides the source textarea + the preview pane.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const access = vi.hoisted(() => ({ enabled: true }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: access.enabled, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({
  getDocument: vi.fn(),
  listVersions: vi.fn(),
  listOrgs: vi.fn(),
}));
vi.mock('../documentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../documentsClient.js')>();
  return { ...orig, getDocument: api.getDocument, listVersions: api.listVersions, listOrgs: api.listOrgs };
});

import { DocumentDetailPage } from '../DocumentDetailPage.js';

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/documents/:documentId" element={<DocumentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear(); // default view = 'split'
  api.getDocument.mockResolvedValue({
    documentId: 'doc_1', orgId: 'org_1', kind: 'sow', format: 'markdown', title: 'My SOW',
    status: 'draft', currentVersionId: 'v1', createdAt: '2026-07-11T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z',
    currentVersion: { versionId: 'v1', documentId: 'doc_1', version: 1, content: '# Big Heading', createdAt: '2026-07-11T00:00:00Z' },
  });
  api.listVersions.mockResolvedValue([]);
  api.listOrgs.mockResolvedValue([{ orgId: 'org_1', name: 'Org One' }]);
});
afterEach(cleanup);

describe('ADR 0350 Phase 2 — Write/Split/Preview', () => {
  it('split (default) shows BOTH the source textarea and the rendered preview', async () => {
    renderAt('/documents/doc_1?org=org_1');
    // Source textarea carries the raw markdown; preview renders it to a heading.
    const textarea = await screen.findByRole('textbox');
    expect((textarea as HTMLTextAreaElement).value).toBe('# Big Heading');
    // react-markdown turns "# Big Heading" into an <h1> inside the preview region.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Big Heading' })).toBeTruthy());
  });

  it('Preview hides the source textarea; Write hides the preview', async () => {
    renderAt('/documents/doc_1?org=org_1');
    await screen.findByRole('textbox');

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Big Heading' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Write' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Big Heading' })).toBeNull();
  });
});

describe('DOCTPL-2 — provenance rendered on the detail surface', () => {
  it('an agent-drafted document shows the chip on the header AND on its version row', async () => {
    api.getDocument.mockResolvedValue({
      documentId: 'doc_1', orgId: 'org_1', kind: 'sow', format: 'markdown', title: 'Agent SOW',
      status: 'draft', currentVersionId: 'v1', createdAt: '2026-07-11T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z',
      provenance: { producedBy: { kind: 'agent', id: 'agent:writer' } },
      currentVersion: { versionId: 'v1', documentId: 'doc_1', version: 1, content: '# Draft', createdAt: '2026-07-11T00:00:00Z' },
    });
    api.listVersions.mockResolvedValue([
      { versionId: 'v1', documentId: 'doc_1', version: 1, content: '# Draft', producedBy: { kind: 'agent', id: 'agent:writer' }, createdAt: '2026-07-11T00:00:00Z' },
    ]);
    renderAt('/documents/doc_1?org=org_1');
    await screen.findByRole('heading', { name: 'Agent SOW' });
    // Header chip + version-row chip = 2 occurrences.
    await waitFor(() => expect(screen.getAllByText('Drafted by agent').length).toBe(2));
  });

  it('a human-drafted document carries NO model-provenance chip (polarity)', async () => {
    api.getDocument.mockResolvedValue({
      documentId: 'doc_1', orgId: 'org_1', kind: 'sow', format: 'markdown', title: 'Human SOW',
      status: 'draft', currentVersionId: 'v1', createdAt: '2026-07-11T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z',
      provenance: { producedBy: { kind: 'user', id: 'u-1' } },
      currentVersion: { versionId: 'v1', documentId: 'doc_1', version: 1, content: '# Draft', createdAt: '2026-07-11T00:00:00Z' },
    });
    api.listVersions.mockResolvedValue([
      { versionId: 'v1', documentId: 'doc_1', version: 1, content: '# Draft', producedBy: { kind: 'user', id: 'u-1' }, createdAt: '2026-07-11T00:00:00Z' },
    ]);
    renderAt('/documents/doc_1?org=org_1');
    await screen.findByRole('heading', { name: 'Human SOW' });
    expect(screen.queryByText('Drafted by agent')).toBeNull();
    expect(screen.queryByText('Generated by a workflow')).toBeNull();
  });
});
