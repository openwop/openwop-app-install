/**
 * ADR 0852 D3 — the feature label in the UI.
 *   - a feature / a campaign's project carries its chip on the list;
 *   - "Features only" appears once any project is a feature, and filters;
 *   - a writer toggles the label from the project page; a notebook or a
 *     campaign's project offers no toggle; a failed save is said.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listProjects = vi.fn();
const listOrgs = vi.fn();
const getEffectiveAccess = vi.fn();
const getProject = vi.fn();
const setProjectFacet = vi.fn();

vi.mock('../../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listWorkflowSummaries: vi.fn(async () => []),
  getWorkflowRunInputs: vi.fn(async () => []),
}));
vi.mock('../projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listProjects: () => listProjects(),
  listOrgs: () => listOrgs(),
  getProject: (id: string) => getProject(id),
  setProjectFacet: (id: string, f: unknown) => setProjectFacet(id, f),
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getEffectiveAccess: () => getEffectiveAccess() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
// The overview tab's strategy chips are another feature's read; not under test here.
vi.mock('../../strategy/StrategyAlignment.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ProjectStrategyChips: () => null }));

import { ProjectsPage } from '../ProjectsPage.js';
import { ProjectDetailPage } from '../ProjectDetailPage.js';

const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const base = { tenantId: 't', orgId: 'org-1', workflows: [], boardId: 'b', canWrite: true };
const PROJECTS: Array<typeof base & { id: string; name: string; facet?: string }> = [
  { ...base, id: 'p1', name: 'Checkout v2', facet: 'feature' },
  { ...base, id: 'p2', name: 'Spring launch', facet: 'campaign' },
  { ...base, id: 'p3', name: 'Plain one' },
  { ...base, id: 'p4', name: 'Another plain' },
];

beforeEach(() => {
  for (const f of [listProjects, listOrgs, getEffectiveAccess, getProject, setProjectFacet]) f.mockReset();
  listProjects.mockResolvedValue(PROJECTS);
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  getEffectiveAccess.mockResolvedValue({ scopes: ['workspace:write'] });
});
afterEach(cleanup);

describe('feature label — the list', () => {
  it('shows the chips, and "Features only" filters to features', async () => {
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    await settle();
    expect(screen.getByText('Feature')).toBeTruthy();
    expect(screen.getByText('Campaign')).toBeTruthy();
    expect(screen.getByText('Plain one')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Features only'));
    expect(screen.getByText('Checkout v2')).toBeTruthy();
    expect(screen.queryByText('Plain one')).toBeNull();
    expect(screen.queryByText('Spring launch')).toBeNull();
  });

  it('no feature anywhere ⇒ no "Features only" control', async () => {
    listProjects.mockResolvedValue(PROJECTS.filter((p) => p.facet !== 'feature'));
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    await settle();
    expect(screen.queryByLabelText('Features only')).toBeNull();
  });
});

describe('feature label — the project page', () => {
  const view = async (): Promise<void> => { render(<MemoryRouter><ProjectDetailPage /></MemoryRouter>); await settle(); };

  it('a writer marks and unmarks it', async () => {
    getProject.mockResolvedValue(PROJECTS[2]);
    setProjectFacet.mockResolvedValueOnce({ ...PROJECTS[2], facet: 'feature' }).mockResolvedValueOnce(PROJECTS[2]);
    await view();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as a feature' }));
    await waitFor(() => expect(setProjectFacet).toHaveBeenCalledWith('p3', 'feature'));
    fireEvent.click(await screen.findByRole('button', { name: 'Not a feature' }));
    await waitFor(() => expect(setProjectFacet).toHaveBeenLastCalledWith('p3', null));
  });

  it("a campaign's project offers no toggle; a failed save is said", async () => {
    getProject.mockResolvedValue(PROJECTS[1]);
    await view();
    expect(screen.queryByRole('button', { name: 'Mark as a feature' })).toBeNull();
    cleanup();
    getProject.mockResolvedValue(PROJECTS[3]);
    setProjectFacet.mockRejectedValue(new Error('403'));
    await view();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as a feature' }));
    expect(await screen.findByText(/feature label could not be saved/)).toBeTruthy();
  });
});
