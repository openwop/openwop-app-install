/**
 * ADR 1090 — feature-contributed project tabs. A contributed tab appears after
 * the host's own, deep-links by `?tab=`, renders with the project and write
 * access, and follows its feature's visibility; a key that repeats a host tab
 * is dropped, and a hidden tab's deep link falls back to Overview.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getProject = vi.fn();
const visible = vi.hoisted(() => ({ ids: new Set<string>(['demo']) }));

vi.mock('../projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProject: (id: string) => getProject(id),
  listProjectMembers: vi.fn(async () => ({ members: [], visibility: 'org' })),
}));
vi.mock('../../../client/accessClient.js', () => ({
  listMembers: vi.fn(async () => []),
  getEffectiveAccess: vi.fn(async () => ({ scopes: ['workspace:write'] })),
}));
vi.mock('../../../agents/rosterClient.js', () => ({ listRoster: vi.fn(async () => []) }));
// The Overview tab's strategy chips read the strategy feature; not under test here.
vi.mock('../../strategy/StrategyAlignment.js', () => ({ ProjectStrategyChips: () => null }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useFeatureVisible: () => (id?: string) => !!id && visible.ids.has(id),
}));
vi.mock('../../registry.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  featureProjectTabs: () => [
    { featureId: 'demo', key: 'home', label: 'Studio home', order: 1, render: (p: { project: { name: string }; canWrite: boolean }) => <p>Home for {p.project.name}, {p.canWrite ? 'writable' : 'read only'}</p> },
    { featureId: 'demo', key: 'members', label: 'Shadow members', render: () => <p>shadow</p> },
  ],
}));

import { ProjectDetailPage } from '../ProjectDetailPage.js';

const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const show = (url: string) => render(<MemoryRouter initialEntries={[url]}><ProjectDetailPage /></MemoryRouter>);

beforeEach(() => {
  getProject.mockReset();
  getProject.mockResolvedValue({ id: 'p1', tenantId: 't', orgId: 'org-1', name: 'Atlas', workflows: [], boardId: 'b1', canWrite: true });
  visible.ids = new Set(['demo']);
});
afterEach(cleanup);

describe('ADR 1090 — contributed project tabs', () => {
  it('adds the tab after the host tabs and deep-links to it', async () => {
    show('/projects/p1?tab=home');
    await settle();
    await waitFor(() => expect(screen.getByText('Home for Atlas, writable')).toBeTruthy());
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs[tabs.length - 1]).toBe('Studio home');
    expect(screen.getByRole('tab', { name: 'Studio home', selected: true })).toBeTruthy();
  });

  it('drops a key that repeats a host tab', async () => {
    show('/projects/p1?tab=members');
    await settle();
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBeGreaterThan(0));
    expect(screen.queryByRole('tab', { name: 'Shadow members' })).toBeNull();
    expect(screen.queryByText('shadow')).toBeNull();
  });

  it('a hidden feature hides its tab, and its deep link falls back to Overview', async () => {
    visible.ids = new Set();
    show('/projects/p1?tab=home');
    await settle();
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBeGreaterThan(0));
    expect(screen.queryByRole('tab', { name: 'Studio home' })).toBeNull();
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/overview/i);
  });
});
