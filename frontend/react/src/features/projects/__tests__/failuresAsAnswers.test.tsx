/**
 * UX_UPGRADE-projects ROUND 2 — the four places a FAILURE was still being
 * rendered as an ANSWER about the workspace, and the one place a failed action
 * destroyed the screen it failed on.
 *
 *  - PRJ2-M2: `listWorkflowSummaries` failing truncated the ASSIGN PICKER to the
 *    in-tree role templates. Round 1 (PRJ-G2) fixed how that failure reads in
 *    the portfolio list above it and left the picker below silently asserting
 *    completeness — the same read, the same failure, one component apart.
 *  - PRJ2-M3: ONE `error` state served both the load and the delete, so a delete
 *    that changed NOTHING replaced the entire project with a bare error notice.
 *  - PRJ2-M4: `listOrgs` and `getEffectiveAccess` failed into `catch {}` /
 *    `catch(false)` — an empty workspace picker and a vanished create form,
 *    both indistinguishable from a real answer about this workspace.
 *  - PRJ2-M5: the charter caps are enforced by SILENT TRUNCATION on a
 *    full-replace PATCH that answers 200, so the editor now refuses the save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listWorkflowSummaries = vi.fn();
const listProjects = vi.fn();
const listOrgs = vi.fn();
const getEffectiveAccess = vi.fn();
const getProject = vi.fn();
const deleteProject = vi.fn();
const updateCharter = vi.fn();

vi.mock('../../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listWorkflowSummaries: () => listWorkflowSummaries(),
  getWorkflowRunInputs: vi.fn(async () => []),
}));
vi.mock('../projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listProjects: () => listProjects(),
  listOrgs: () => listOrgs(),
  getProject: (id: string) => getProject(id),
  deleteProject: (id: string) => deleteProject(id),
  updateCharter: (id: string, c: unknown) => updateCharter(id, c),
  updateWorkflows: vi.fn(async () => ({})),
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getEffectiveAccess: () => getEffectiveAccess(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The confirm dialog is a portal + a promise; the tests below are about what
// happens AFTER the user confirms, so it always resolves true.
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

import { ProjectWorkflowsTab } from '../ProjectWorkflowsTab.js';
import { ProjectsPage } from '../ProjectsPage.js';
import { ProjectDetailPage } from '../ProjectDetailPage.js';
import { ProjectOverviewTab } from '../ProjectOverviewTab.js';

const PROJECT = {
  id: 'p1', tenantId: 't', orgId: 'org-1', name: 'Atlas', workflows: [], boardId: 'b1', canWrite: true,
} as never;

const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  for (const m of [listWorkflowSummaries, listProjects, listOrgs, getEffectiveAccess, getProject, deleteProject, updateCharter]) m.mockReset();
  listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf-mine', name: 'My real workflow' }]);
  listProjects.mockResolvedValue([]);
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  getEffectiveAccess.mockResolvedValue({ scopes: ['workspace:write'] });
  getProject.mockResolvedValue(PROJECT);
  deleteProject.mockResolvedValue({ ok: true });
  updateCharter.mockResolvedValue(PROJECT);
});
afterEach(cleanup);

describe('PRJ2-M2 — the assign picker stopped claiming to be complete', () => {
  const view = async (): Promise<void> => {
    render(<MemoryRouter><ProjectWorkflowsTab projectId="p1" workflows={[]} canWrite onSaved={() => {}} /></MemoryRouter>);
    await settle();
  };

  it('discloses that the list is missing the user’s own workflows when the read failed', async () => {
    listWorkflowSummaries.mockRejectedValue(new Error('boom'));
    await view();
    // Not "no workflows" — the honest claim is that THIS LIST is short.
    expect(await screen.findByText(/only the built-in templates/i)).toBeTruthy();
  });

  it('says nothing when the read succeeded (the negative control)', async () => {
    await view();
    await waitFor(() => expect(listWorkflowSummaries).toHaveBeenCalled());
    expect(screen.queryByText(/only the built-in templates/i)).toBeNull();
    // …and the workflow it loaded is genuinely offered, so the control above is
    // asserting on a picker that WORKS rather than one that is empty anyway.
    expect(screen.getByRole('option', { name: 'My real workflow' })).toBeTruthy();
  });
});

describe('PRJ2-M3 — a failed delete no longer destroys the project it failed on', () => {
  const view = async (): Promise<void> => {
    render(<MemoryRouter><ProjectDetailPage /></MemoryRouter>);
    await settle();
  };

  it('keeps the project on screen and reports the failure inside it', async () => {
    deleteProject.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }));
    await view();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Atlas' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await settle();

    expect(await screen.findByText(/Failed to delete the project/i)).toBeTruthy();
    // The whole point: the project — its header, its tabs, the user's place in
    // them — survived an action that changed nothing.
    expect(screen.getByRole('heading', { name: 'Atlas' })).toBeTruthy();
    expect(screen.getByRole('tablist')).toBeTruthy();
  });

  it('a failed LOAD still replaces the page, because there is nothing to keep', async () => {
    getProject.mockRejectedValue(Object.assign(new Error('gone'), { status: 500 }));
    await view();
    // The localized `common:error_server` sentence — NOT `getProject failed (500)`.
    expect(await screen.findByText(/went wrong on our end/i)).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});

describe('PRJ2-M4 — the two reads that gate project creation', () => {
  const view = async (): Promise<void> => {
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    await settle();
  };

  it('a failed org read is not an empty workspace list — and replaces the picker, not decorates it', async () => {
    listOrgs.mockRejectedValue(new Error('boom'));
    await view();
    // The shared `OrgSelectionState` (this page migrated to it — see the
    // org-selection ratchet). Its failed branch names the consequence…
    expect(await screen.findByText(/workspace list/i)).toBeTruthy();
    // …offers a retry, because the read is the only place the fetch happens…
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeTruthy();
    // …and REPLACES the form's controls. The bespoke notice this round first
    // shipped sat below a workspace `<select>` and a permanently dead Create
    // button, which is the ordering bug the shared component exists to encode.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /create project/i })).toBeNull();
  });

  it('a failed access read says the permission was UNCHECKED, not denied', async () => {
    getEffectiveAccess.mockRejectedValue(new Error('boom'));
    await view();
    expect(await screen.findByText(/could not check your permissions/i)).toBeTruthy();
    // Still fail-closed — the disclosure replaces the form, it does not restore it.
    expect(screen.queryByRole('button', { name: /create project/i })).toBeNull();
  });

  it('says neither thing when both reads succeed (the negative control)', async () => {
    await view();
    await waitFor(() => expect(screen.getByRole('button', { name: /create project/i })).toBeTruthy());
    // PRJC-8 — this used to assert absence of /Your workspaces could not be
    // loaded/, a sentence NO branch renders (the real failure copy is
    // `orgStateFailedTitle` "Could not load your organizations" + a body naming
    // the "workspace list"), so the line passed even if the failure branch
    // rendered in the success case. Match what the failure branch ACTUALLY
    // renders — the same /workspace list/i the positive test above matches.
    expect(screen.queryByText(/workspace list/i)).toBeNull();
    expect(screen.queryByText(/could not check your permissions/i)).toBeNull();
  });
});

describe('PRJ2-M5 — the charter editor refuses a save the server would silently trim', () => {
  const edit = async (charter?: unknown): Promise<void> => {
    render(<MemoryRouter><ProjectOverviewTab project={{ ...(PROJECT as object), charter } as never} canWrite onSaved={() => {}} /></MemoryRouter>);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /add a charter|^edit$/i }));
    await settle();
  };

  const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: /save charter/i }) as HTMLButtonElement;

  it('blocks the save and names the overflow when there are more objectives than the server keeps', async () => {
    await edit();
    fireEvent.change(screen.getByLabelText(/objectives/i), {
      target: { value: Array.from({ length: 23 }, (_, i) => `objective ${i}`).join('\n') },
    });
    await settle();
    expect(await screen.findByText(/3 objective\(s\) over the limit of 20/i)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await settle();
    // The defect: the old editor sent all 23, got a 200 back, and reported
    // success while three of them had ceased to exist.
    expect(updateCharter).not.toHaveBeenCalled();
  });

  it('caps the goal field at the length the server keeps, so it cannot be trimmed after the fact', async () => {
    await edit();
    expect(screen.getByLabelText(/goal/i).getAttribute('maxlength')).toBe('200');
  });

  it('blocks a charter that ARRIVED over the length cap — `maxLength` cannot shorten it', async () => {
    // `maxLength` restricts typing, not a value loaded from the server. A goal
    // that predates the cap (or survives one being lowered) opened over-limit
    // with Save enabled and was silently trimmed on write — the very defect
    // the caps exist to close, surviving inside the fix for it.
    await edit({ goal: 'g'.repeat(240) });
    expect(await screen.findByText(/goal is longer than 200 characters/i)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('saves normally when everything is within the caps (the negative control)', async () => {
    await edit();
    fireEvent.change(screen.getByLabelText(/objectives/i), { target: { value: 'ship it\nreview it' } });
    await settle();
    expect(screen.queryByText(/over the limit/i)).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await settle();
    expect(updateCharter).toHaveBeenCalledWith('p1', expect.objectContaining({ objectives: ['ship it', 'review it'] }));
  });
});
