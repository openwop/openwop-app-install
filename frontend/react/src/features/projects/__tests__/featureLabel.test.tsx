/**
 * ADR 0852 D3 — the feature label in the UI.
 *   - a feature / a campaign's project carries its chip on the list;
 *   - "Features only" appears once any project is a feature, and filters;
 *   - a writer toggles the label from the project page; a notebook or a
 *     campaign's project offers no toggle; a failed save is said.
 *
 * Sabotage-witnessed (wave 13, w13g4-fl-*): the `facet === 'feature'` chip, the
 * `featuresOnly` filter, the `anyFeature || featuresOnly` control condition, the
 * facet toggle's `null : 'feature'` value, the `!== 'campaign'` exclusion, and the
 * `facetSaveFailed` catch each turn their case below red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  Project, listProjects as ListProjects, listOrgs as ListOrgs, getProject as GetProject, setProjectFacet as SetProjectFacet,
} from '../projectsClient.js';
import type { getEffectiveAccess as GetEffectiveAccess } from '../../../client/accessClient.js';

const listProjects = vi.fn<typeof ListProjects>();
const listOrgs = vi.fn<typeof ListOrgs>();
const getEffectiveAccess = vi.fn<typeof GetEffectiveAccess>();
const getProject = vi.fn<typeof GetProject>();
const setProjectFacet = vi.fn<typeof SetProjectFacet>();

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
  setProjectFacet: (...a: Parameters<typeof SetProjectFacet>) => setProjectFacet(...a),
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
const CHECKOUT: Project = { ...base, id: 'p1', name: 'Checkout v2', facet: 'feature' };
const SPRING: Project = { ...base, id: 'p2', name: 'Spring launch', facet: 'campaign' };
const PLAIN: Project = { ...base, id: 'p3', name: 'Plain one' };
const ANOTHER: Project = { ...base, id: 'p4', name: 'Another plain' };
const PROJECTS: Project[] = [CHECKOUT, SPRING, PLAIN, ANOTHER];

beforeEach(() => {
  for (const f of [listProjects, listOrgs, getEffectiveAccess, getProject, setProjectFacet]) f.mockReset();
  listProjects.mockResolvedValue(PROJECTS);
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  getEffectiveAccess.mockResolvedValue({ roles: [], scopes: ['workspace:write'], basis: 'member' });
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
    getProject.mockResolvedValue(PLAIN);
    setProjectFacet.mockResolvedValueOnce({ ...PLAIN, facet: 'feature' }).mockResolvedValueOnce(PLAIN);
    await view();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as a feature' }));
    await waitFor(() => expect(setProjectFacet).toHaveBeenCalledWith('p3', 'feature'));
    fireEvent.click(await screen.findByRole('button', { name: 'Not a feature' }));
    await waitFor(() => expect(setProjectFacet).toHaveBeenLastCalledWith('p3', null));
  });

  it("a campaign's project offers no toggle; a failed save is said", async () => {
    getProject.mockResolvedValue(SPRING);
    await view();
    expect(screen.queryByRole('button', { name: 'Mark as a feature' })).toBeNull();
    cleanup();
    getProject.mockResolvedValue(ANOTHER);
    setProjectFacet.mockRejectedValue(new Error('403'));
    await view();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as a feature' }));
    expect(await screen.findByText(/feature label could not be saved/)).toBeTruthy();
  });
});
