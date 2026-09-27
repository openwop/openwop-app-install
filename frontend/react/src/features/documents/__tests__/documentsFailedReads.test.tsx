/**
 * UX_UPGRADE-documents P1 — a failed read must not be dressed as a server answer.
 *
 * UX-DOC-1 is the worst of the class and the reason this file exists: a rejected
 * `listOrgs()` did `setOrgs([])`, which fed the genuinely-empty branch and
 * rendered "No organizations — create an organization first". So an unreachable
 * orgs endpoint told a user who HAS organizations to go create one, and hid
 * every document they own behind that false premise. Peer session openwop-app-2
 * hit the identical shape in `production` and named the rule this file follows:
 *
 *   ALWAYS ASSERT THE GENUINELY-EMPTY CASE ALONGSIDE THE ERROR CASE, or the fix
 *   degrades into "always show the error" and the suite stays green.
 *
 * So every describe below has BOTH arms: the failure renders the failure, AND a
 * real empty answer still renders the instructive empty state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({ enabled: true }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: access.enabled, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listDocuments: vi.fn(),
  listCanvasSources: vi.fn(),
  listTemplates: vi.fn(),
}));
vi.mock('../documentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../documentsClient.js')>();
  return { ...orig, ...api };
});

const acc = vi.hoisted(() => ({ getEffectiveAccess: vi.fn() }));
vi.mock('../../../client/accessClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getEffectiveAccess: acc.getEffectiveAccess };
});

import { DocumentsPage } from '../DocumentsPage.js';

const ORG = { orgId: 'org_1', name: 'Org One' };

function view(): void {
  render(<MemoryRouter initialEntries={['/documents']}><DocumentsPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  access.enabled = true;
  api.listOrgs.mockResolvedValue([ORG]);
  api.listDocuments.mockResolvedValue([]);
  api.listCanvasSources.mockResolvedValue({ canvases: [], total: 0 });
  api.listTemplates.mockResolvedValue([]);
  // The COMPLETE `EffectiveAccess` shape (`roles`/`scopes`/`basis`), not just the
  // field this file reads. `ui/OrgSelectionState`'s zero-org card calls
  // `canManageOrgs`, which touches `roles` too — a partial fixture crashed the
  // whole page render, and the failure surfaced as "text not found" rather than
  // as the TypeError it was.
  acc.getEffectiveAccess.mockResolvedValue({ roles: [], scopes: ['workspace:write'], basis: 'none' });
});
afterEach(cleanup);

describe('UX-DOC-1 — a failed orgs read never borrows the "create one first" instruction', () => {
  it('FAILURE: says the read failed, and does NOT tell the user to create an org', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    view();
    // The honest state…
    // The shared `ui/OrgSelectionState` owns this card now, so the copy is the
    // shared title plus THIS feature's consequence clause (`failedBody`).
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    expect(screen.getByText(/document list was never requested/i)).toBeTruthy();
    // …and emphatically NOT the instruction to redo work that already exists.
    expect(screen.queryByText(/belong to an organization/i)).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });

  it('EMPTY: a genuine empty answer still gets the instructive empty state', async () => {
    // The other arm. Without this, "always show the error" would pass the test
    // above and silently destroy the real empty-state guidance.
    api.listOrgs.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText(/Documents and canvases belong to an organization/i)).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('offers a retry on the failure arm', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    view();
    await screen.findByText('Could not load your organizations');
    // A dead end is not a designed error state.
    // The shared card's retry is labelled from the `ui` namespace ("Try again").
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });
});

describe('UX-DOC-3 — a failed permission check is not a denial', () => {
  it('FAILURE: explains the check failed rather than silently removing the button', async () => {
    acc.getEffectiveAccess.mockRejectedValue(new Error('access_503'));
    view();
    expect(await screen.findByText(/couldn't check your permissions/i)).toBeTruthy();
  });

  it('DENIED: a real answer without workspace:write stays quiet (no false alarm)', async () => {
    // The other arm: a genuine denial must NOT claim the check failed.
    acc.getEffectiveAccess.mockResolvedValue({ roles: [], scopes: [], basis: 'none' });
    view();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.queryByText(/couldn't check your permissions/i)).toBeNull();
  });
});

describe('UX-DOC-5 — a half-loaded list says which half is missing', () => {
  it('FAILURE: discloses that canvases are absent from the combined list', async () => {
    api.listCanvasSources.mockRejectedValue(new Error('canvas_500'));
    view();
    expect(await screen.findByText(/Canvases didn't load/i)).toBeTruthy();
  });

  it('EMPTY: genuinely zero canvases raises no warning', async () => {
    api.listCanvasSources.mockResolvedValue({ canvases: [], total: 0 });
    view();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.queryByText(/Canvases didn't load/i)).toBeNull();
  });
});
