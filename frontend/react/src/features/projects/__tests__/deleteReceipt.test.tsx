/**
 * PROJ-UX-5 — the delete confirm names the blast radius, and the backend's
 * receipt finally has a reader.
 *
 * The backend destroys board, memory, schedules, and the chat's full history
 * (plus a notebook-facet corpus) and reports honest counts; the client used to
 * discard the body (zero consumers repo-wide) while the confirm's body was the
 * generic `cannotBeUndone`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getProject = vi.fn();
const deleteProject = vi.fn();
const getDeletePreview = vi.fn();
const confirmMock = vi.fn();
const toastSuccess = vi.fn();

vi.mock('../projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProject: (id: string) => getProject(id),
  deleteProject: (id: string) => deleteProject(id),
  getDeletePreview: (id: string) => getDeletePreview(id),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }));

import { ProjectDetailPage } from '../ProjectDetailPage.js';

const PROJECT = {
  id: 'p1', tenantId: 't', orgId: 'org-1', name: 'Atlas', workflows: [], boardId: 'b1', canWrite: true,
} as never;

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
    const opts = confirmMock.mock.calls[0]?.[0] as { body?: string };
    expect(opts.body).toMatch(/board/i);
    expect(opts.body).toMatch(/memory/i);
    expect(opts.body).toMatch(/schedules/i);
    expect(opts.body).toMatch(/chat/i);
    expect(opts.body).not.toMatch(/corpus/i); // no invented notebook claim
  });

  it('a project the backend says will lose its corpus names the ingested source corpus', async () => {
    getProject.mockResolvedValue({ ...(PROJECT as object), deletesCorpus: true } as never);
    await clickDelete();
    const opts = confirmMock.mock.calls[0]?.[0] as { body?: string };
    expect(opts.body).toMatch(/corpus/i);
  });

  it('THE DEFECT — an ensure-provisioned notebook has NO facet and still gets the corpus warning', async () => {
    // ADR 0601 § Corrections (HIGH-2). The confirm asked `facet === 'notebook'`,
    // but `ensureNotebookForProject` — what opening the Sources tab calls — never
    // stamps `facet`. So this exact shape (a corpus that WILL be erased, no facet)
    // was warned about a board and some notes, and learned its sources were gone
    // from the success toast. Irreversible destruction disclosed after the fact.
    getProject.mockResolvedValue({ ...(PROJECT as object), facet: undefined, deletesCorpus: true } as never);
    deleteProject.mockResolvedValue({ deleted: true, memoryEntriesCleared: 0, schedulesCleared: 0, conversationsDeleted: 1, notebookCorpusDeleted: true });
    await clickDelete();
    const opts = confirmMock.mock.calls[0]?.[0] as { body?: string };
    expect(opts.body, 'the warning must match what the delete actually does').toMatch(/corpus/i);
    // …and the toast, which is the channel that used to carry the whole
    // disclosure, is now a CONFIRMATION of something already consented to.
    expect(toastSuccess.mock.calls[0]?.[0] as string).toMatch(/corpus/i);
  });

  it('NEGATIVE CONTROL — a facet:notebook project whose corpus is NOT erased gets no corpus warning', async () => {
    // The mirror of the defect: `facet` must not be able to invent a claim
    // either. A notebook-created project whose corpus predates the provenance
    // stamp loses auto-cleanup (an orphan, deliberately), and warning about a
    // destruction that will not happen is its own dishonesty.
    getProject.mockResolvedValue({ ...(PROJECT as object), facet: 'notebook', deletesCorpus: false } as never);
    await clickDelete();
    const opts = confirmMock.mock.calls[0]?.[0] as { body?: string };
    expect(opts.body).not.toMatch(/corpus/i);
  });

  it('an older backend that omits the field falls back to the generic warning', async () => {
    getProject.mockResolvedValue({ ...(PROJECT as object), deletesCorpus: undefined } as never);
    await clickDelete();
    const opts = confirmMock.mock.calls[0]?.[0] as { body?: string };
    expect(opts.body).not.toMatch(/corpus/i);
    expect(opts.body).toMatch(/board/i);
  });
});

describe('PROJ-UX-5 — the receipt has a reader', () => {
  it('surfaces the backend counts after a successful delete', async () => {
    await clickDelete();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const msg = toastSuccess.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(/1/);   // conversationsDeleted
    expect(msg).toMatch(/4/);   // memoryEntriesCleared
    expect(msg).toMatch(/2/);   // schedulesCleared
    expect(msg).not.toMatch(/corpus/i); // the plain project must not claim one
  });

  it('names the corpus when the backend reports notebookCorpusDeleted', async () => {
    deleteProject.mockResolvedValue({ deleted: true, memoryEntriesCleared: 0, schedulesCleared: 0, conversationsDeleted: 1, notebookCorpusDeleted: true });
    await clickDelete();
    expect(toastSuccess.mock.calls[0]?.[0] as string).toMatch(/corpus/i);
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
    const body = (confirmMock.mock.calls[0]?.[0] as { body?: string }).body ?? '';
    expect(body).toMatch(/2 canvases/);
    expect(body).toMatch(/1 document\b/);
    expect(body).toMatch(/team ledger/);
    expect(body).not.toMatch(/priority list/);
  });

  it('says nothing extra when there is nothing else to delete', async () => {
    await clickDelete();
    const body = (confirmMock.mock.calls[0]?.[0] as { body?: string }).body ?? '';
    expect(body).not.toMatch(/other features/);
    expect(body).not.toMatch(/could not count/);
  });

  it('a FAILED count is said as such — never rendered as "nothing else"', async () => {
    getDeletePreview.mockRejectedValue(new Error('503'));
    await clickDelete();
    const body = (confirmMock.mock.calls[0]?.[0] as { body?: string }).body ?? '';
    expect(body).toMatch(/could not count/i);
  });

  it('the success toast lists what was removed with the project', async () => {
    deleteProject.mockResolvedValue({ deleted: true, memoryEntriesCleared: 0, schedulesCleared: 0, conversationsDeleted: 0, dependentsDeleted: { canvases: 1, priorityLists: 2 } });
    await clickDelete();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const msg = toastSuccess.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(/Also removed: 1 canvas and 2 priority lists/);
  });
});

describe('grade-ux row 25 B1 — one delete at a time, and the button says which step it is on', () => {
  it('a second click while the preview is pending does nothing; the button is busy and disabled', async () => {
    let release: (v: unknown) => void = () => undefined;
    getDeletePreview.mockReturnValue(new Promise((r) => { release = r; }));
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
