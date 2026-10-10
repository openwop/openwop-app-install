/**
 * UX_UPGRADE-priority-matrix — PM-G1 / PM-G2.
 *
 *  - PM-G1: a failed orgs read left `orgs` empty, which empties the workspace
 *    select, leaves `effectiveOrg` blank, and makes submit silently inert (the
 *    handler returns early on `!effectiveOrg`). A dead form with no explanation.
 *  - PM-G2: `listPresets()` was fetched, stored, passed as a prop and typed —
 *    and never read; the scoring-model select hard-coded all five options. The
 *    request was wasted and the list could drift from the backend's presets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CriteriaSet, PriorityList } from '../priorityMatrixClient.js';

const listOrgs = vi.fn();
const listProjects = vi.fn();
const listPresets = vi.fn();
const listLists = vi.fn();

vi.mock('../priorityMatrixClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: () => listOrgs(),
  listProjects: () => listProjects(),
  listPresets: () => listPresets(),
  listLists: () => listLists(),
  createList: vi.fn(async () => ({} as PriorityList)),
  // ADR 0590 fixture completeness — the page ALSO reads the portfolio + peers;
  // unmocked they hit real fetch in jsdom, fail, and (post-PMX-8c honesty)
  // legitimately render "…could not be loaded" notices that collide with this
  // suite's absence assertions (the incomplete-fixture trap).
  listPortfolio: vi.fn(async () => ({ items: [], lists: [], normalize: 'none' })),
  listFederatedPortfolio: vi.fn(async () => ({ items: [], peers: [] })),
  listPeers: vi.fn(async () => []),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const getEffectiveAccess = vi.fn();
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getEffectiveAccess: (o?: unknown) => getEffectiveAccess(o),
}));

import { PriorityMatrixPage } from '../PriorityMatrixPage.js';

const preset = (id: string): CriteriaSet => ({ presetId: id, aggregation: 'weighted-sum', criteria: [] } as unknown as CriteriaSet);

/** The create form lives in a modal behind "New list", which only appears once
 *  at least one list exists — so seed one and open it. */
const view = async (): Promise<void> => {
  render(<MemoryRouter><PriorityMatrixPage /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(listOrgs).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: /new list/i }));
  await screen.findByRole('dialog');
};

const scoringOptions = (): string[] => {
  const select = screen.getByLabelText(/scoring model/i) as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.value);
};

beforeEach(() => {
  listOrgs.mockReset(); listProjects.mockReset(); listPresets.mockReset(); listLists.mockReset(); getEffectiveAccess.mockReset();
  getEffectiveAccess.mockResolvedValue({ roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' });
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  listProjects.mockResolvedValue([]);
  listPresets.mockResolvedValue([preset('weighted'), preset('wsjf'), preset('rice'), preset('ice'), preset('value-effort')]);
  listLists.mockResolvedValue([{ id: 'l1', name: 'Q3 ideas', orgId: 'org-1', criteriaSet: { presetId: 'weighted', aggregation: 'weighted-sum', criteria: [] } } as unknown as PriorityList]);
});
afterEach(cleanup);

describe('PM-G1: a failed workspaces read explains the dead form', () => {
  it('says workspaces could not be loaded', async () => {
    listOrgs.mockRejectedValue(new Error('orgs down'));
    await view();
    // Previously: an empty select, an inert submit, and no explanation at all.
    expect(await screen.findByText(/workspaces could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/workspaces unavailable/i)).toBeTruthy();
  });

  it('a workspace-less account says so WITHOUT claiming a failure', async () => {
    listOrgs.mockResolvedValue([]);
    await view();
    expect(await screen.findByText(/no workspaces/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it('a healthy read says nothing', async () => {
    await view();
    // POSITIVE ANCHOR: absence-only, this arm would have passed against a tree
    // that rendered no form at all — the failure copy is missing there too. The
    // 'Acme' OPTION cannot exist until `listOrgs` RESOLVED into the workspace
    // select, which is the very read whose silence this case is asserting.
    expect(await screen.findByRole('option', { name: 'Acme' })).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(screen.queryByText(/workspaces unavailable/i)).toBeNull();
  });
});

describe('PM-G2: the scoring model is driven by the fetched presets', () => {
  it('renders one option per preset the server returned', async () => {
    listPresets.mockResolvedValue([preset('weighted'), preset('rice')]);
    await view();
    await waitFor(() => expect(scoringOptions()).toEqual(['weighted', 'rice']));
  });

  it('falls back to every known id when the presets read fails', async () => {
    listPresets.mockRejectedValue(new Error('presets down'));
    await view();
    // Never worse than the previous hard-coded behaviour.
    await waitFor(() => expect(scoringOptions()).toEqual(['weighted', 'wsjf', 'rice', 'ice', 'value-effort']));
  });

  it('every option carries a catalog label, never a bare id or a missing key', async () => {
    await view();
    const select = screen.getByLabelText(/scoring model/i) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent ?? '');
    // Not "labels differ from ids" — RICE and ICE ARE the framework names, so
    // the label legitimately equals the id for those. What must hold is that
    // nothing is blank and nothing leaked its i18n key.
    expect(labels.every((l) => l.trim().length > 0 && !l.startsWith('scoringModel'))).toBe(true);
    // The two ids that are NOT acronyms do get prose.
    expect(labels).not.toContain('value-effort');
    expect(labels).not.toContain('weighted');
  });
});

describe('PM4UX-1 (ADR 0842 D9): a list is offered only where it can be created', () => {
  it('a read-only member is not offered "New list" (it could only end in a 403)', async () => {
    getEffectiveAccess.mockResolvedValue({ roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' });
    render(<MemoryRouter><PriorityMatrixPage /></MemoryRouter>);
    await waitFor(() => expect(getEffectiveAccess).toHaveBeenCalledWith({ orgId: 'org-1' }));
    await screen.findByText('Q3 ideas');
    await waitFor(() => expect(screen.queryByRole('button', { name: /new list/i })).toBeNull());
  });

  it('the create form offers only the workspaces the caller can write in', async () => {
    listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }, { orgId: 'org-2', name: 'Beta' }]);
    getEffectiveAccess.mockImplementation(async (o: { orgId: string }) => ({ roles: [], scopes: o.orgId === 'org-1' ? ['workspace:read', 'workspace:write'] : ['workspace:read'], basis: 'member' }));
    await view();
    await waitFor(() => {
      const ws = screen.getByLabelText(/workspace/i) as HTMLSelectElement;
      expect(Array.from(ws.options).map((o) => o.textContent)).not.toContain('Beta');
    });
  });
});
