/**
 * PROJ-UX-5 — the delete confirm names the blast radius, and the backend's
 * receipt finally has a reader.
 *
 * The backend destroys board, memory, schedules, and the chat's full history
 * (plus a notebook-facet corpus) and reports honest counts; the client used to
 * discard the body (zero consumers repo-wide) while the confirm's body was the
 * generic `cannotBeUndone`.
 *
 * Sabotage (w13 g3 probes): reading `facet === 'notebook'` instead of the
 * server's `deletesCorpus` reds THE DEFECT + the NEGATIVE CONTROL; a blank
 * cascade body reds the plain-project case; swapping or zeroing a receipt count
 * reds "surfaces the backend counts"; dropping the corpus/dependents toast line,
 * the dependents list, the zero filter, the failed-count sentence, the failure
 * notice, the `disabled` busy state or the finally re-enable each reds its case.
 * Ceiling: the `deletingRef` re-entry guard sits behind `disabled`, and jsdom
 * never dispatches a click to a disabled button, so that second guard cannot be
 * driven here (probe w13g3-del-ref-guard-off is vacuous by construction).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { Project, DeleteProjectReceipt, ProjectDependentCounts } from '../projectsClient.js';
import type { ConfirmOptions } from '../../../ui/confirm.js';

const getProject = vi.fn<(id: string) => Promise<Project>>();
const deleteProject = vi.fn<(id: string) => Promise<DeleteProjectReceipt>>();
const getDeletePreview = vi.fn<(id: string) => Promise<ProjectDependentCounts>>();
const confirmMock = vi.fn<(o: ConfirmOptions) => Promise<boolean>>();
const toastSuccess = vi.fn<(m: string) => void>();

vi.mock('../projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProject: (id: string) => getProject(id),
  deleteProject: (id: string) => deleteProject(id),
  getDeletePreview: (id: string) => getDeletePreview(id),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: ConfirmOptions) => confirmMock(o) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }));

import { ProjectDetailPage } from '../ProjectDetailPage.js';

const PROJECT: Project = {
  id: 'p1', tenantId: 't', orgId: 'org-1', name: 'Atlas', workflows: [], boardId: 'b1', canWrite: true,
};

/** The first confirm's body text (the page passes a plain string). */
const confirmBody = (): string => {
  const b = confirmMock.mock.calls[0]?.[0]?.body;
  return typeof b === 'string' ? b : '';
};
/** The first success toast's text. */
const toastText = (): string => toastSuccess.mock.calls[0]?.[0] ?? '';

const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  for (const m of [getProject, deleteProject, getDeletePreview, confirmMock, toastSuccess]) m.mockReset();
  getDeletePreview.mockResolvedValue({ canvases: 0, documents: 0, priorityLists: 0, teamLedger: 0 });
  getProject.mockResolvedValue(PROJECT);
  confirmMock.mockResolvedValue(true);
  deleteProject.mockResolvedValue({ deleted: true, memoryEntriesCleared: 4, schedulesCleared: 2, conversationsDeleted: 1 });
});
afterEach(cleanup);

async function clickDelete(): Promise<void> {
  render(<MemoryRouter initialEntries={['/projects/p1']}><ProjectDetailPage /></MemoryRouter>);
  await settle();
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Atlas' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /delete/i }));
  await settle();
}

describe('PROJ-UX-5 — confirm names the cascade', () => {
  it('a plain project confirm enumerates board / memory / schedules / chat history', async () => {
    await clickDelete();
    const body = confirmBody();
    expect(body).toMatch(/board/i);
    expect(body).toMatch(/memory/i);
    expect(body).toMatch(/schedules/i);
    expect(body).toMatch(/chat/i);
    expect(body).not.toMatch(/corpus/i); // no invented notebook claim (also the older-backend shape: the field is absent)
  });

  it('THE DEFECT — an ensure-provisioned notebook has NO facet and still gets the corpus warning', async () => {
    // ADR 0601 § Corrections (HIGH-2). The confirm asked `facet === 'notebook'`,
    // but `ensureNotebookForProject` — what opening the Sources tab calls — never
    // stamps `facet`. So this exact shape (a corpus that WILL be erased, no facet)
    // was warned about a board and some notes, and learned its sources were gone
    // from the success toast. Irreversible destruction disclosed after the fact.
    getProject.mockResolvedValue({ ...PROJECT, deletesCorpus: true }); // NO `facet` key at all — the ensure-provisioned shape
    deleteProject.mockResolvedValue({ deleted: true, memoryEntriesCleared: 0, schedulesCleared: 0, conversationsDeleted: 1, notebookCorpusDeleted: true });
    await clickDelete();
    expect(confirmBody(), 'the warning must match what the delete actually does').toMatch(/corpus/i);
    // …and the toast, which is the channel that used to carry the whole
    // disclosure, is now a CONFIRMATION of something already consented to.
    expect(toastText()).toMatch(/corpus/i);
  });

  it('NEGATIVE CONTROL — a facet:notebook project whose corpus is NOT erased gets no corpus warning', async () => {
    // The mirror of the defect: `facet` must not be able to invent a claim
    // either. A notebook-created project whose corpus predates the provenance
    // stamp loses auto-cleanup (an orphan, deliberately), and warning about a
    // destruction that will not happen is its own dishonesty.
    getProject.mockResolvedValue({ ...PROJECT, facet: 'notebook', deletesCorpus: false });
    await clickDelete();
    expect(confirmBody()).toMatch(/board/i); // the confirm DID run (not an empty body)
    expect(confirmBody()).not.toMatch(/corpus/i);
  });
});

describe('PROJ-UX-5 — the receipt has a reader', () => {
  it('surfaces the backend counts after a successful delete', async () => {
    await clickDelete();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const msg = toastText();
    // Each count in ITS slot — a digit-anywhere match let a swapped mapping pass.
    expect(msg).toContain('chat conversations removed: 1; memory entries cleared: 4; schedules removed: 2.');
    expect(msg).not.toMatch(/corpus/i); // the plain project must not claim one
  });

  it('a FAILED delete shows no receipt (negative control — no false success)', async () => {
    deleteProject.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }));
    await clickDelete();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(await screen.findByText(/Failed to delete the project/i)).toBeTruthy();
  });
});

describe('ADR 0839 D2 — the confirm and the receipt name what other features lose', () => {
  it('names the non-zero dependents the server counted, and only those', async () => {
    getDeletePreview.mockResolvedValue({ canvases: 2, documents: 1, priorityLists: 0, teamLedger: 3 });
    await clickDelete();
    const body = confirmBody();
    expect(body).toMatch(/2 canvases/);
    expect(body).toMatch(/1 document\b/);
    expect(body).toMatch(/team ledger/);
    expect(body).not.toMatch(/priority list/);
  });

  it('says nothing extra when there is nothing else to delete', async () => {
    await clickDelete();
    const body = confirmBody();
    expect(body).not.toMatch(/other features/);
    expect(body).not.toMatch(/could not count/);
  });

  it('a FAILED count is said as such — never rendered as "nothing else"', async () => {
    getDeletePreview.mockRejectedValue(new Error('503'));
    await clickDelete();
    const body = confirmBody();
    expect(body).toMatch(/could not count/i);
  });

  it('the success toast lists what was removed with the project', async () => {
    deleteProject.mockResolvedValue({ deleted: true, memoryEntriesCleared: 0, schedulesCleared: 0, conversationsDeleted: 0, dependentsDeleted: { canvases: 1, priorityLists: 2 } });
    await clickDelete();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const msg = toastText();
    expect(msg).toMatch(/Also removed: 1 canvas and 2 priority lists/);
  });
});

describe('grade-ux row 25 B1 — one delete at a time, and the button says which step it is on', () => {
  it('a second click while the preview is pending does nothing; the button is busy and disabled', async () => {
    let release: (v: ProjectDependentCounts) => void = () => undefined;
    getDeletePreview.mockReturnValue(new Promise<ProjectDependentCounts>((r) => { release = r; }));
    render(<MemoryRouter initialEntries={['/projects/p1']}><ProjectDetailPage /></MemoryRouter>);
    await settle();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Atlas' })).toBeTruthy());
    const btn = screen.getByRole('button', { name: /delete/i }) as HTMLButtonElement;
    fireEvent.click(btn);
    await settle();
    const busy = screen.getByRole('button', { name: /checking/i }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    await settle();
    expect(getDeletePreview).toHaveBeenCalledTimes(1);
    release({});
    await settle();
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it('a cancelled confirm re-enables the button', async () => {
    confirmMock.mockResolvedValue(false);
    await clickDelete();
    expect(deleteProject).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: /^delete$/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
