/**
 * UX_UPGRADE-documents P2 + P3 (closed 2026-08-01).
 *
 * P3 / UX-DOC-4: a failed `listProjects()` fed the assign-to-project modal an
 * empty list — "you have no projects" from a read that never completed. Now
 * the modal shows a failure Notice with retry; the chip path keeps its
 * designed generic-label fallback.
 *
 * P2 / UX-DOC-6: the detail page folded EVERY load failure into "Document not
 * found" — right for 403/404 (no existence leak), wrong for a 500/offline.
 * Non-40x failures now get a retryable failure card.
 *
 * Both arms asserted per the P1 rule: the failure renders the failure, AND the
 * genuine case still renders its real state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listDocuments: vi.fn(),
  listCanvasSources: vi.fn(),
  listTemplates: vi.fn(),
  getDocument: vi.fn(),
  listVersions: vi.fn(),
}));
vi.mock('../documentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../documentsClient.js')>();
  return { ...orig, ...api };
});
const projectsApi = vi.hoisted(() => ({ listProjects: vi.fn() }));
vi.mock('../../projects/projectsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listProjects: projectsApi.listProjects };
});
const acc = vi.hoisted(() => ({ getEffectiveAccess: vi.fn() }));
vi.mock('../../../client/accessClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getEffectiveAccess: acc.getEffectiveAccess };
});

import { DocumentsPage } from '../DocumentsPage.js';
import { DocumentDetailPage } from '../DocumentDetailPage.js';

const ORG = { orgId: 'org_1', name: 'Org One' };
// DOCT-11 — the fixture is PRODUCTION-SHAPED: it used to omit orgId/status/
// currentVersionId, which force-disabled the Download menu (`!doc.currentVersionId`)
// and made the whole export surface UNREACHABLE in this file while every test
// stayed green (the incomplete-fixtures-make-assertions-unreachable class).
const DOC = {
  documentId: 'd1', orgId: 'org_1', title: 'Spec', kind: 'note', format: 'markdown',
  status: 'draft', currentVersionId: 'v1',
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listOrgs.mockResolvedValue([ORG]);
  api.listDocuments.mockResolvedValue([DOC]);
  api.listCanvasSources.mockResolvedValue({ canvases: [], total: 0 });
  api.listTemplates.mockResolvedValue([]);
  api.getDocument.mockResolvedValue({ ...DOC, currentVersion: { version: 1, content: 'hello', createdAt: DOC.createdAt } });
  api.listVersions.mockResolvedValue([]);
  acc.getEffectiveAccess.mockResolvedValue({ scopes: ['workspace:write'] });
  projectsApi.listProjects.mockResolvedValue([]);
});
afterEach(cleanup);

async function openAssignModal(): Promise<void> {
  localStorage.setItem('openwop:view:documents', 'list'); // the assign affordance rides the list rows
  render(<MemoryRouter initialEntries={['/documents']}><DocumentsPage /></MemoryRouter>);
  const row = await screen.findByText('Spec');
  expect(row).toBeTruthy();
  fireEvent.click((await screen.findAllByRole('button', { name: /add to project/i }))[0]!);
}

describe('P3 / UX-DOC-4 — assign modal projects-read honesty', () => {
  it('a failed projects read shows the failure + retry, not an empty picker', async () => {
    projectsApi.listProjects.mockRejectedValue(new Error('503'));
    await openAssignModal();
    await screen.findByText(/couldn’t load your projects/i);
    // Heal the read; retry renders the real picker.
    projectsApi.listProjects.mockResolvedValue([{ id: 'p1', name: 'Apollo' }]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Apollo');
  });

  it('a genuinely empty projects list still renders the picker with only "No project"', async () => {
    await openAssignModal();
    await waitFor(() => expect(screen.getByText(/no project$/i)).toBeTruthy());
    expect(screen.queryByText(/couldn’t load your projects/i)).toBeNull();
  });
});

function viewDetail(): void {
  render(
    <MemoryRouter initialEntries={['/documents/d1?org=org_1']}>
      <Routes><Route path="/documents/:documentId" element={<DocumentDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('P2 / UX-DOC-6 — detail-page load failures', () => {
  it('a 500 renders a retryable failure card, NOT "not found"', async () => {
    api.getDocument.mockRejectedValue(new Error('getDocument returned 500'));
    viewDetail();
    await screen.findByText(/couldn’t load this document/i);
    expect(screen.queryByText(/document not found/i)).toBeNull();
    api.getDocument.mockResolvedValue({ ...DOC, currentVersion: { version: 1, content: 'hello', createdAt: DOC.createdAt } });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Spec');
  });

  it('a 404 still folds to "not found" (no existence leak)', async () => {
    api.getDocument.mockRejectedValue(new Error('getDocument returned 404'));
    viewDetail();
    await screen.findByText(/document not found/i);
    expect(screen.queryByText(/couldn’t load this document/i)).toBeNull();
  });

  it('DOCT-11 — the export surface is REACHABLE on the completed fixture (Download menu enabled)', async () => {
    viewDetail();
    await screen.findByText('Spec');
    const download = await screen.findByRole('button', { name: /download/i });
    expect((download as HTMLButtonElement).disabled, 'the Download menu must not be force-disabled — the old fixture omitted currentVersionId and no test could reach the export surface').toBe(false);
  });
});
