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
 *
 * Sabotage witnesses (grade-tests w14, re-probed w109): a failed projects read set
 * to `[]`, a dead projects retry, an Add enabled with no list, the failure Notice
 * shown always, a stray picker option, a 500 folded to "not found", a 403 or a 404
 * not folded, a detail retry that never reloads, or a disabled Download menu —
 * each turns its case red. `listPackCanvasTypes` is mocked (the blanket access mock
 * turns `canvas-packs` on; it was this file's only live fetch, ADR 0661). Mocks and
 * fixtures are typed against the clients' own exports.
 *
 * Was BLOCKED-ON-PRODUCT (w14, TST-DOC-36) as `it.fails`; FIXED. A REAL 404 did not
 * reach "not found": the client throws `DocumentsApiError('Document not found.', 404)`
 * (the server envelope carries a message), and `DocumentDetailPage` classified by
 * the MESSAGE suffix `returned 40[34]`, so it rendered the retryable failure card.
 * The page now classifies on `e.status` (403/404), as `FormsRouting` does. Every
 * failure fixture here is the client's own `DocumentsApiError` (`asJson` throws
 * nothing else for a non-2xx), so the 403 case rides the status, not the suffix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null, loading: false }),
}));

type DocsClient = typeof import('../documentsClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<DocsClient['listOrgs']>(),
  listDocuments: vi.fn<DocsClient['listDocuments']>(),
  listCanvasSources: vi.fn<DocsClient['listCanvasSources']>(),
  listTemplates: vi.fn<DocsClient['listTemplates']>(),
  getDocument: vi.fn<DocsClient['getDocument']>(),
  listVersions: vi.fn<DocsClient['listVersions']>(),
}));
vi.mock('../documentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../documentsClient.js')>();
  return { ...orig, ...api };
});
const projectsApi = vi.hoisted(() => ({ listProjects: vi.fn<typeof import('../../projects/projectsClient.js')['listProjects']>() }));
vi.mock('../../projects/projectsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../projects/projectsClient.js')>();
  return { ...orig, listProjects: projectsApi.listProjects };
});
const acc = vi.hoisted(() => ({ getEffectiveAccess: vi.fn<typeof import('../../../client/accessClient.js')['getEffectiveAccess']>() }));
vi.mock('../../../client/accessClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../client/accessClient.js')>();
  return { ...orig, getEffectiveAccess: acc.getEffectiveAccess };
});

vi.mock('../../../canvas/canvasClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../canvas/canvasClient.js')>()),
  listPackCanvasTypes: vi.fn(async () => []),
}));

import { DocumentsPage } from '../DocumentsPage.js';
import { DocumentsApiError, type DocumentRecord, type DocumentVersion, type Org } from '../documentsClient.js';
import type { Project } from '../../projects/projectsClient.js';
import { DocumentDetailPage } from '../DocumentDetailPage.js';

const ORG: Org = { orgId: 'org_1', name: 'Org One' };
// DOCT-11 — the fixture is PRODUCTION-SHAPED: it used to omit orgId/status/
// currentVersionId, which force-disabled the Download menu (`!doc.currentVersionId`)
// and made the whole export surface UNREACHABLE in this file while every test
// stayed green (the incomplete-fixtures-make-assertions-unreachable class).
const DOC: DocumentRecord = {
  documentId: 'd1', orgId: 'org_1', title: 'Spec', kind: 'note', format: 'markdown',
  status: 'draft', currentVersionId: 'v1',
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};
const V1: DocumentVersion = { versionId: 'v1', documentId: 'd1', version: 1, content: 'hello', createdAt: DOC.createdAt };
const APOLLO: Project = { id: 'p1', tenantId: 't1', orgId: 'org_1', name: 'Apollo', workflows: [], boardId: 'b1' };

beforeEach(() => {
  vi.clearAllMocks();
  api.listOrgs.mockResolvedValue([ORG]);
  api.listDocuments.mockResolvedValue([DOC]);
  api.listCanvasSources.mockResolvedValue({ canvases: [], total: 0 });
  api.listTemplates.mockResolvedValue([]);
  api.getDocument.mockResolvedValue({ ...DOC, currentVersion: V1 });
  api.listVersions.mockResolvedValue([]);
  acc.getEffectiveAccess.mockResolvedValue({ roles: [], scopes: ['workspace:write'], basis: 'member' });
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
    // The projects client's own shape for a non-2xx (`asJson`).
    projectsApi.listProjects.mockRejectedValue(Object.assign(new Error('listProjects failed (503)'), { status: 503 }));
    await openAssignModal();
    await screen.findByText(/couldn’t load your projects/i);
    // A failed read offers no picker to choose from, and nothing to Add.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    // Heal the read; retry renders the real picker.
    projectsApi.listProjects.mockResolvedValue([APOLLO]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Apollo');
  });

  it('a genuinely empty projects list still renders the picker with only "No project"', async () => {
    await openAssignModal();
    await waitFor(() => expect(screen.getByText(/no project$/i)).toBeTruthy());
    expect(screen.queryByText(/couldn’t load your projects/i)).toBeNull();
    const options = within(screen.getByRole('dialog')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['No project']);
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
    // What the client throws for a 500 whose body carries a message.
    api.getDocument.mockRejectedValue(new DocumentsApiError('Internal server error.', 500));
    viewDetail();
    await screen.findByText(/couldn’t load this document/i);
    expect(screen.queryByText(/document not found/i)).toBeNull();
    api.getDocument.mockResolvedValue({ ...DOC, currentVersion: V1 });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Spec');
  });

  it('a 403 also folds to "not found" (no existence leak)', async () => {
    // The client's real shape for a refusal that carries the server's message:
    // only the STATUS can classify it (the message has no `returned 403` suffix).
    // This case was a plain `Error('getDocument returned 404')`, a shape `asJson`
    // never throws, so it only ever witnessed the dead suffix branch.
    api.getDocument.mockRejectedValue(new DocumentsApiError('You do not have access to this document.', 403));
    viewDetail();
    expect(await screen.findByText('Document not found')).toBeTruthy();
    expect(screen.queryByText(/couldn’t load this document/i)).toBeNull();
  });

  // The REAL client error for a 404 (TST-DOC-36). It rendered the retryable
  // failure card until `DocumentDetailPage` classified on `e.status`.
  it('a REAL 404 (DocumentsApiError with the server message) folds to "not found"', async () => {
    api.getDocument.mockRejectedValue(new DocumentsApiError('Document not found.', 404));
    viewDetail();
    // Exact title text: the failure card's BODY also ends "Document not found."
    expect(await screen.findByText('Document not found')).toBeTruthy();
    expect(screen.queryByText(/couldn’t load this document/i)).toBeNull();
  });

  it('DOCT-11 — the export surface is REACHABLE on the completed fixture (Download menu enabled)', async () => {
    viewDetail();
    await screen.findByText('Spec');
    const download = await screen.findByRole('button', { name: /download/i });
    expect((download as HTMLButtonElement).disabled, 'the Download menu must not be force-disabled — the old fixture omitted currentVersionId and no test could reach the export surface').toBe(false);
  });
});
