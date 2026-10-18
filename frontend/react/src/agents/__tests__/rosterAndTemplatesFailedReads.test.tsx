/**
 * `/roster` + `/agents/templates` — the two rows the tracker marked covered by
 * #2567, which #2567 never opened (its file list is `AgentDashboardPage`,
 * `agentViewModel`, one test and 4 locale files). This is the pass those rows
 * claimed had already happened.
 *
 * Three defects, all the same family — a failed read wearing the clothes of a
 * legitimate answer:
 *
 *  R-1  a failed org-chart read rendered "No org-chart yet" AND offered to build
 *       a replacement, over a workspace that has one.
 *  R-2  a failed department roll-up rendered NOTHING, which reads as less
 *       configured than a department that legitimately owns nothing ("nothing
 *       yet"). Silence is inferred as an answer when its neighbours all speak.
 *  T-1  the templates Retry button set `isLoading: true` against a `[]`-dep
 *       effect, so it never refetched — clicking it replaced a stated failure
 *       with a permanent "Loading templates…".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type RosterClient = typeof import('../rosterClient.js');
const { listRoster, getOrgChart, getDepartmentRollup, putOrgChart, listAgents } = vi.hoisted(() => ({
  listRoster: vi.fn<RosterClient['listRoster']>(),
  getOrgChart: vi.fn<RosterClient['getOrgChart']>(),
  getDepartmentRollup: vi.fn<RosterClient['getDepartmentRollup']>(),
  putOrgChart: vi.fn<RosterClient['putOrgChart']>(),
  listAgents: vi.fn<typeof import('../../client/agentsClient.js')['listAgents']>(),
}));
vi.mock('../rosterClient.js', async (orig) => ({
  ...(await orig<typeof import('../rosterClient.js')>()),
  listRoster, getOrgChart, getDepartmentRollup, putOrgChart,
}));
vi.mock('../../client/agentsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/agentsClient.js')>()),
  listAgents,
}));

import type { OrgChart, OrgDepartment, ResponsibilityView, RosterEntry } from '../rosterClient.js';
import type { AgentEntry } from '../../client/agentsClient.js';
import { RosterPage } from '../RosterPage.js';
import { AgentsPage } from '../AgentsPage.js';

// A COMPLETE fixture. An incomplete one throws inside render, which fails every
// assertion in the file for a reason that has nothing to do with the defect.
const ENTRY: RosterEntry = {
  rosterId: 'r1', persona: 'Ada', label: 'Ada', roleKey: 'engineer',
  autonomyLevel: 'review', agentRef: { agentId: 'a1' },
  workflows: [], tenantId: 't1', enabled: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const CHART: OrgChart = {
  tenantId: 't1',
  departments: [
    { departmentId: 'd1', name: 'Engineering', parentDepartmentId: null, roles: [{ roleId: 'role-member', name: 'Member' }] },
    { departmentId: 'd2', name: 'Sales', parentDepartmentId: null, roles: [{ roleId: 'role-member', name: 'Member' }] },
  ],
  members: [{ rosterId: 'r1', departmentId: 'd1', roleId: 'role-member', reportsTo: null }],
};
const EMPTY_CHART: OrgChart = { tenantId: 't1', departments: [], members: [] };
const TEMPLATE: AgentEntry = {
  agentId: 'a1', persona: 'Ada', label: 'Ada', description: 'x', modelClass: 'balanced',
  packName: 'core', packVersion: '1.0.0', toolAllowlist: [], degraded: [],
  hasHandoffSchemas: false,
};
/** A typed roll-up for department `id` (the page reads only `responsibilities`). */
const rollup = (id: string, responsibilities: string[]): ResponsibilityView => {
  const department: OrgDepartment | undefined = CHART.departments.find((d) => d.departmentId === id);
  if (!department) throw new Error(`fixture has no department ${id}`);
  return { department, members: CHART.members.filter((m) => m.departmentId === id), responsibilities };
};

const mountRoster = async (): Promise<void> => {
  render(<MemoryRouter><RosterPage /></MemoryRouter>);
  await act(async () => {});
};
const mountTemplates = async (): Promise<void> => {
  render(<MemoryRouter><AgentsPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  listRoster.mockResolvedValue([ENTRY]);
  getOrgChart.mockResolvedValue(CHART);
  getDepartmentRollup.mockImplementation(async (id) => rollup(id, ['shipping']));
  putOrgChart.mockResolvedValue(CHART);
  listAgents.mockResolvedValue([TEMPLATE]);
});

describe('R-1 — a failed org-chart read is not "no org chart"', () => {
  it('does not claim the workspace has none', async () => {
    getOrgChart.mockRejectedValue(new Error('503'));
    await mountRoster();
    expect(document.body.textContent).not.toContain('No org-chart yet');
    expect(document.body.textContent).toContain('Could not load the org chart');
  });

  it('does not offer to BUILD one — that PUT replaces the stored chart', async () => {
    getOrgChart.mockRejectedValue(new Error('503'));
    await mountRoster();
    // Positive control that the page settled on the FAILURE state, not loading.
    expect(document.body.textContent).toContain('Could not load the org chart');
    const build = screen.queryAllByRole('button')
      .find((b) => /Generate flat chart|Rebuild flat chart/.test(b.textContent ?? ''));
    expect(build).toBeUndefined();
  });

  it('a failed chart read also discards the roster read (one Promise.all) — implementation tripwire', async () => {
    // IMPLEMENTATION TRIPWIRE, not the behavioural guard. One `Promise.all` — a
    // rejection discards the roster result too, so `roster` stays `[]` and
    // `disabled={roster.length === 0}` blocked the destructive build by accident.
    // The behaviour this once stood in for (no build offer over a failed read) is
    // now witnessed by "does not offer to BUILD" + "does not claim the workspace
    // has none" (probes w48g1-r1-order / w48g1-r1-flag). This case reds only if
    // the roster is loaded separately — loud, so whoever does that re-checks the
    // build offer, but not by itself a defect.
    getOrgChart.mockRejectedValue(new Error('503'));
    await mountRoster();
    expect(listRoster).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Ada'); // roster never landed
  });

  it('the retry recovers into the real chart', async () => {
    getOrgChart.mockRejectedValueOnce(new Error('503')).mockResolvedValue(CHART);
    await mountRoster();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(document.body.textContent).not.toContain('Could not load the org chart');
    expect(document.body.textContent).toContain('Engineering');
  });

  it('a genuinely EMPTY chart still reads as empty and still offers the build', async () => {
    // The failure mode of this fix: a workspace that can never build its first chart.
    getOrgChart.mockResolvedValue(EMPTY_CHART);
    await mountRoster();
    expect(document.body.textContent).toContain('No org-chart yet');
    expect(document.body.textContent).not.toContain('Could not load the org chart');
    const build = screen.getByRole('button', { name: /Generate flat chart from roster/ }) as HTMLButtonElement;
    expect(build.disabled).toBe(false);
  });
});

describe('R-2 — a failed roll-up says so instead of rendering nothing', () => {
  it('discloses the department whose roll-up failed', async () => {
    getDepartmentRollup.mockImplementation(async (id) => {
      if (id === 'd2') throw new Error('503');
      return rollup(id, ['shipping']);
    });
    await mountRoster();
    expect(document.body.textContent).toContain('roll-up unavailable');
    expect(document.body.textContent).toContain('shipping'); // d1 unaffected
  });

  it('says nothing extra when every roll-up loads', async () => {
    await mountRoster();
    expect(document.body.textContent).not.toContain('roll-up unavailable');
  });

  it('a department that genuinely owns nothing is NOT reported as failed', async () => {
    getDepartmentRollup.mockImplementation(async (id) => rollup(id, []));
    await mountRoster();
    expect(document.body.textContent).toContain('nothing yet');
    expect(document.body.textContent).not.toContain('roll-up unavailable');
  });
});

describe('T-1 — the templates retry actually retries', () => {
  it('refetches, instead of leaving the page permanently loading', async () => {
    listAgents.mockRejectedValueOnce(new Error('503')).mockResolvedValue([TEMPLATE]);
    await mountTemplates();
    expect(listAgents).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(listAgents).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Loading templates');
    expect(document.body.textContent).toContain('Ada');
  });

  it('discloses when the advisor filter could not be read', async () => {
    // `[]` from this catch means both "no advisors" and "could not check", and
    // undisclosed it presents advisor-backed agents as installable templates.
    listRoster.mockRejectedValue(new Error('503'));
    await mountTemplates();
    expect(document.body.textContent).toContain('may include agents that are not reusable templates');
  });

  it('says nothing when the filter loads — including when there are no advisors', async () => {
    // The failure mode of this fix: warning on every healthy load, because an
    // empty advisor list is the common case.
    listRoster.mockResolvedValue([]);
    await mountTemplates();
    expect(document.body.textContent).not.toContain('may include agents that are not reusable templates');
  });
});
