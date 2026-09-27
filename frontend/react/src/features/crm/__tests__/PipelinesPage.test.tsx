/**
 * CRM-UX-2 — the pipeline/stage editor, the missing consumer of routes that had
 * shipped with none.
 *
 * The load-bearing property is not "the form works": it is that the page never
 * turns a FAILED deals read into a confident "0 deals — safe to remove". The
 * server refuses (409) a removal that would strand a deal, so a page that
 * guessed zero would disable nothing, promise safety, and hand the user a
 * transport error instead of an answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listPipelines: vi.fn(),
  listDeals: vi.fn(),
  createPipeline: vi.fn(),
  updatePipeline: vi.fn(),
  deletePipeline: vi.fn(),
}));
vi.mock('../crmOrgClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});

// The toast HOST is not mounted here, so a refusal that only toasts would leave
// nothing in the DOM to assert — and "silently does nothing" would pass a test
// that only checked the write did not happen.
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', async (orig) => {
  const actual = await orig<{ toast: Record<string, unknown> }>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));

import { PipelinesPage } from '../PipelinesPage.js';
// The REAL class (the mock factory spreads the actual module), so a rejection
// built here is byte-identical to one `asJson` would throw.
import { CrmRequestError } from '../crmOrgClient.js';
import i18n from '../../../i18n/index.js';

const PIPELINE = {
  pipelineId: 'p1',
  name: 'Sales',
  stages: [
    { stageId: 's1', name: 'New', probability: 10 },
    { stageId: 's2', name: 'Won', probability: 90 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listPipelines.mockResolvedValue([PIPELINE]);
  api.listDeals.mockResolvedValue([]);
  api.updatePipeline.mockImplementation(async (_o: string, _p: string, patch: { name?: string; stages?: Array<{ stageId?: string; name: string; probability: number }> }) => ({
    ...PIPELINE,
    name: patch.name ?? PIPELINE.name,
    stages: (patch.stages ?? []).map((s, i) => ({ stageId: s.stageId ?? `new${i}`, name: s.name, probability: s.probability })),
  }));
});
afterEach(cleanup);

function view(search = '?org=o1'): void {
  render(
    <MemoryRouter initialEntries={[`/crm/pipelines${search}`]}>
      <Routes><Route path="/crm/pipelines" element={<PipelinesPage />} /></Routes>
    </MemoryRouter>,
  );
}

/**
 * A promise the TEST settles, so the window BETWEEN a Retry click and the read
 * landing is observable. `await waitFor(calls > before)` cannot see that window
 * at all — it only proves a request was issued, which is why HIGH-1 (the empty
 * state rendering over the whole retry) shipped under a green suite.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('CRM-UX-2 — pipelines editor: designed states', () => {
  it('a failed pipelines read is the announced card + Retry, never "No pipelines yet"', async () => {
    api.listPipelines.mockRejectedValue(new Error('pipelines_500'));
    view();
    expect(await screen.findByText('Could not load this')).toBeTruthy();
    expect(screen.queryByText('No pipelines yet')).toBeNull();
    const before = api.listPipelines.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.listPipelines.mock.calls.length).toBeGreaterThan(before));
  });

  it('HIGH-1 — DURING the retry it shows the loading state, never "No pipelines yet"', async () => {
    // The defect: `load()` cleared `failed` synchronously while the `[]` the
    // failed read had written stayed in state, and the empty card is gated on
    // `failed`. So for the entire retry request the page claimed this org has
    // no pipelines — a claim it had just failed to establish, on the surface
    // whose whole job is not making that claim.
    api.listPipelines.mockRejectedValueOnce(new Error('pipelines_500'));
    view();
    await screen.findByText('Could not load this');

    const inflight = deferred<typeof PIPELINE[]>();
    api.listPipelines.mockReturnValueOnce(inflight.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // The read is in flight and CANNOT settle until we say so.
    await waitFor(() => expect(api.listPipelines.mock.calls.length).toBe(2));
    expect(screen.queryByText('No pipelines yet')).toBeNull();
    expect(screen.queryByText('Could not load this')).toBeNull();

    inflight.resolve([PIPELINE]);
    expect(await screen.findByDisplayValue('Sales')).toBeTruthy();
  });

  it('a TRUTHFUL empty still shows the empty card', async () => {
    api.listPipelines.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No pipelines yet')).toBeTruthy();
    expect(screen.queryByText('Could not load this')).toBeNull();
  });

  it('without ?org= it says the link is incomplete instead of reading nothing', async () => {
    view('');
    expect(await screen.findByText('No organization in the link')).toBeTruthy();
    expect(api.listPipelines).not.toHaveBeenCalled();
  });

  it('the feature gate wins over everything', () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    view();
    expect(screen.getByText(/CRM is not enabled/i)).toBeTruthy();
  });
});

describe('CRM-UX-2 — pipelines editor: writes', () => {
  it('creates a pipeline with an empty stage list (the server seeds its defaults)', async () => {
    view();
    await screen.findByDisplayValue('Sales');
    const nameInputs = screen.getAllByLabelText('Pipeline name');
    fireEvent.change(nameInputs[0]!, { target: { value: 'Renewals' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add pipeline' }));
    await waitFor(() => expect(api.createPipeline).toHaveBeenCalledWith('o1', { name: 'Renewals', stages: [] }));
  });

  it('saves renamed + re-weighted stages, keeping each stageId so its deals stay attached', async () => {
    view();
    const prob = await screen.findByLabelText('Win % for New');
    fireEvent.change(prob, { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Stage 1'), { target: { value: 'Discovery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePipeline).toHaveBeenCalled());
    const [, , patch] = api.updatePipeline.mock.calls[0]!;
    expect(patch.stages[0]).toEqual({ stageId: 's1', name: 'Discovery', probability: 25 });
    expect(patch.stages[1]).toEqual({ stageId: 's2', name: 'Won', probability: 90 });
  });

  it('reorders stages — the array order IS the board column order', async () => {
    view();
    fireEvent.click(await screen.findByLabelText('Move Won earlier'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePipeline).toHaveBeenCalled());
    const [, , patch] = api.updatePipeline.mock.calls[0]!;
    expect(patch.stages.map((s: { name: string }) => s.name)).toEqual(['Won', 'New']);
  });

  it('an EMPTY probability box saves as 0, not NaN', async () => {
    // This is the coercion path that is actually REACHABLE. `min`/`max`/`step`
    // already refuse 480 and 25.7 at the control (measured: the submit never
    // fires), but an emptied box is perfectly valid — and the draft holds it as
    // `''` on purpose, so that it does not snap to 0 while you are clearing it.
    // `Number('')` is 0, but a naive `parseFloat` would be NaN, which
    // JSON-serializes to `null` and reads to the server as "unspecified".
    view();
    fireEvent.change(await screen.findByLabelText('Win % for New'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePipeline).toHaveBeenCalled());
    expect(api.updatePipeline.mock.calls[0]![2].stages[0].probability).toBe(0);
  });

  it('the probability field constrains its own range (0–100, whole numbers)', async () => {
    view();
    const prob = await screen.findByLabelText('Win % for New') as HTMLInputElement;
    expect(prob.min).toBe('0');
    expect(prob.max).toBe('100');
    expect(prob.step).toBe('1');
  });

  it('MEDIUM-2 — blanking an EXISTING stage’s name is a validation error, not a silent delete', async () => {
    // The defect: `save` filtered out every nameless draft, so a stage whose
    // name the user cleared mid-retype was simply absent from `patch.stages`
    // — and the server reads an absent stageId as REMOVED. A stage with no
    // deals was therefore DELETED outright: no confirm, no toast, no signal,
    // and straight past the guarded Remove button that exists for this.
    view();
    fireEvent.change(await screen.findByLabelText('Stage 1'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Stage 1 needs a name')));
    // The write never happens — which is the whole point: the old code DID
    // write, and the write is what destroyed the stage.
    expect(api.updatePipeline).not.toHaveBeenCalled();
    // …and the field itself is named, not only the toast.
    expect((screen.getByLabelText('Stage 1') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
  });

  it('MEDIUM-2 — a stage the user just ADDED and left blank is still discarded, not an error', async () => {
    // The discriminator: a never-saved stage has no `stageId`, so dropping it
    // removes nothing. Treating it as a validation error would trap the user
    // in a form they can only leave by naming a stage they did not want.
    view();
    await screen.findByDisplayValue('Sales');
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePipeline).toHaveBeenCalled());
    expect(api.updatePipeline.mock.calls[0]![2].stages.map((s: { name: string }) => s.name)).toEqual(['New', 'Won']);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('refuses to save a pipeline left with no stages at all', async () => {
    // The server would happily accept `stages: []`… and the board would then
    // have no columns at all, with no way back except re-adding a stage blind.
    // Reachable through the guarded Remove control (both stages are empty of
    // deals here), which is the only way a stage may leave a pipeline.
    view();
    fireEvent.click(await screen.findByLabelText('Remove New'));
    fireEvent.click(screen.getByLabelText('Remove Won'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('A pipeline needs at least one named stage.'));
    expect(api.updatePipeline).not.toHaveBeenCalled();
  });
});

describe('CRM-UX-2 — a removal that would strand a deal', () => {
  it('blocks the pipeline delete and names the count AND the way out', async () => {
    api.listDeals.mockResolvedValue([{ dealId: 'd1', title: 'X', pipelineId: 'p1', stageId: 's1' }]);
    view();
    const del = await screen.findByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    // LOW-6 — i18next's `count` is RESERVED and drives plural selection. Without
    // `_one`/`_other` these read "1 deals"; the test used to pin that.
    expect(screen.getByText(/1 deal is still in this pipeline/)).toBeTruthy();
    // A refusal with no exit is a defect — the link IS the exit.
    expect(screen.getAllByRole('link', { name: /Move them from the Deals tab/ }).length).toBeGreaterThan(0);
  });

  it('LOW-6 — the count strings pluralize (2 deals, not "2 deals" by luck)', async () => {
    api.listDeals.mockResolvedValue([
      { dealId: 'd1', title: 'X', pipelineId: 'p1', stageId: 's1' },
      { dealId: 'd2', title: 'Y', pipelineId: 'p1', stageId: 's1' },
    ]);
    view();
    // Discriminates the plural branch from the singular one above; a single
    // hard-coded "{{count}} deals" would pass one of these two, never both.
    expect(await screen.findByText(/2 deals are still in this pipeline/)).toBeTruthy();
    expect(screen.getByText(/2 deals sit on this stage/)).toBeTruthy();
  });

  it('blocks the STAGE remove only for the stage that actually has deals, and names its exit', async () => {
    api.listDeals.mockResolvedValue([{ dealId: 'd1', title: 'X', pipelineId: 'p1', stageId: 's1' }]);
    view();
    const removeNew = await screen.findByLabelText('Remove New') as HTMLButtonElement;
    const removeWon = screen.getByLabelText('Remove Won') as HTMLButtonElement;
    expect(removeNew.disabled).toBe(true);
    expect(removeWon.disabled).toBe(false);
    // LOW-5 — the stage refusal named WHY but not WHERE, unlike its sibling on
    // the pipeline Delete. The file's own docblock calls a refusal with no
    // exit a defect.
    const hint = screen.getByText(/1 deal sits on this stage/);
    expect(within(hint).getByRole('link', { name: /Move them from the Deals tab/ })).toBeTruthy();
  });

  it('a FAILED deals read never renders a confident zero — it says the counts are unknown and leaves the controls live', async () => {
    // This is the whole point of the page's honesty rule. Guessing zero here
    // would promise a safe delete and then hand the user a 409.
    api.listDeals.mockRejectedValue(new Error('deals_500'));
    view();
    expect(await screen.findByText(/can’t say which stages and pipelines are safe/)).toBeTruthy();
    expect(screen.queryByText('0 deals')).toBeNull();
    const del = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    expect((screen.getByLabelText('Remove New') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a SUCCESSFUL read is distinguishable from a failed one (the discriminator for the test above)', async () => {
    // The old discriminator was the literal "0 deals" chip, which MEDIUM-1
    // deleted. What separates the two states now: a successful read renders
    // the scope line and real counts for the stages that HAVE deals; a failed
    // one renders the unknown-counts warning and no counts at all.
    api.listDeals.mockResolvedValue([{ dealId: 'd1', title: 'X', pipelineId: 'p1', stageId: 's1' }]);
    view();
    expect(await screen.findByText(/Deal counts cover the deals you can see/)).toBeTruthy();
    expect(screen.getByText(/1 deal sits on this stage/)).toBeTruthy();
    expect(screen.queryByText(/can’t say which stages/)).toBeNull();
  });
});

describe('MEDIUM-1 — the deals read is territory-filtered, so a zero is a LOWER BOUND', () => {
  // `GET …/crm/orgs/:orgId/deals` passes the CALLER as viewer into
  // `filterVisibleCrmRecords`, and the `territories` feature registers that
  // resolver. The server's own integrity guards (`anyDealsOnPipeline`,
  // `listDealsOnStages`) count with NO viewer. So for a user whose territory
  // excludes deals, this page's zero is wrong — and it used to render that
  // zero as a chip and hand out an enabled control that promised safety.
  it('never renders a confident "0 deals" for a stage or a pipeline', async () => {
    api.listDeals.mockResolvedValue([]);
    view();
    await screen.findByDisplayValue('Sales');
    expect(screen.queryByText('0 deals')).toBeNull();
    expect(screen.queryByText('0 deal')).toBeNull();
  });

  it('says out loud that the counts only cover what this user can see', async () => {
    api.listDeals.mockResolvedValue([]);
    view();
    // Without this line an enabled Remove beside a silent stage still reads as
    // "there is nothing here" — the same claim, made by omission.
    expect(await screen.findByText(/A removal you are allowed to try can still be refused/)).toBeTruthy();
  });

  it('a positive count is still trusted: a lower bound above zero blocks the removal', async () => {
    api.listDeals.mockResolvedValue([{ dealId: 'd1', title: 'X', pipelineId: 'p1', stageId: 's1' }]);
    view();
    expect(((await screen.findByRole('button', { name: 'Delete' })) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the server’s 409 on DELETE is translated, not handed over as wire English', async () => {
    api.listDeals.mockResolvedValue([]); // a zero this viewer cannot back
    api.deletePipeline.mockRejectedValue(new CrmRequestError('Pipeline still has deals — move or delete them first.', 409));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('outside your territory'));
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining('Pipeline still has deals'));
    confirmSpy.mockRestore();
  });

  it('the server’s 409 on a dropped STAGE is translated too', async () => {
    api.listDeals.mockResolvedValue([]);
    api.updatePipeline.mockRejectedValue(new CrmRequestError('A removed stage still has deals — move them to another stage first.', 409));
    view();
    fireEvent.click(await screen.findByLabelText('Remove Won'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('outside your territory'));
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining('A removed stage still has deals'));
  });

  it('a NON-409 failure maps the STATUS to localized copy — never the wire string (CRM-UX-14)', async () => {
    // This used to assert the raw `deletePipeline returned 500` reached the
    // toast, under the theory that translating only the 409 kept the
    // diagnosis for the rest. That pinned the defect: the diagnosis is for
    // the developer (console.warn); the user gets what a 500 MEANS.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.listDeals.mockResolvedValue([]);
    api.deletePipeline.mockRejectedValue(new CrmRequestError('deletePipeline returned 500', 500));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const msg = toastError.mock.calls[0]![0] as string;
    expect(msg).toBe(i18n.t('crm:httpServerError'));
    expect(msg).not.toContain('returned 500');
    confirmSpy.mockRestore();
  });
});
