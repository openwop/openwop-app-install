/**
 * Settings → Insights & Drafting (ADR 1102 D10, `INS91-9`) — the only screen that
 * reads or writes the suite config.
 *
 * Red when: the panel stops saying who the schedule runs as; a take-over is not
 * confirmed, or omits `takeOver`; the schedule is not sent as the `M H * * D` the
 * door expects with its time zone; a stored custom cron is overwritten by an
 * unrelated edit; a field refusal lands anywhere but its field, or shows the
 * server's English instead of the panel's sentence; a paused schedule reads as
 * running; a read-only caller is offered a save or take-over copy; the anniversary
 * trigger becomes armable; an unavailable suite renders the form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InsightsSuitePanel } from '../InsightsSuitePanel.js';
import { InsightsSuiteSaveError, type InsightsSuiteState } from '../../insights-suite/insightsSuiteClient.js';

const mocks = vi.hoisted(() => ({
  getInsightsSuite: vi.fn<() => Promise<InsightsSuiteState | null>>(),
  saveInsightsSuite: vi.fn<(body: unknown) => Promise<unknown>>(),
}));

vi.mock('../../insights-suite/insightsSuiteClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../insights-suite/insightsSuiteClient.js')>()),
  getInsightsSuite: mocks.getInsightsSuite,
  saveInsightsSuite: mocks.saveInsightsSuite,
}));

const saved = (over: Partial<InsightsSuiteState> = {}): InsightsSuiteState => ({
  config: { principalUserId: 'u-me', scheduleCron: '30 6 * * 2', scheduleTimezone: 'America/Chicago', planSource: { projectId: 'acme-analytics' }, businessUnit: 'TX', updatedAt: '2026-11-11T00:00:00.000Z' },
  runsAsYou: true,
  scheduleArmed: true,
  canWrite: true,
  ...over,
});

beforeEach(() => {
  mocks.getInsightsSuite.mockReset();
  mocks.saveInsightsSuite.mockReset();
  mocks.saveInsightsSuite.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('InsightsSuitePanel', () => {
  it('reads the saved schedule back into day, time and zone, and says it runs as you', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved());
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText('This schedule runs as you.')).toBeTruthy());
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('06:30');
    expect((screen.getByLabelText('Day') as HTMLSelectElement).value).toBe('2');
    expect((screen.getByLabelText('Time zone') as HTMLSelectElement).value).toBe('America/Chicago');
    expect((screen.getByLabelText('BigQuery project') as HTMLInputElement).value).toBe('acme-analytics');
  });

  it('saves the schedule as the cron the door expects, with its time zone', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved());
    render(<InsightsSuitePanel />);
    await waitFor(() => screen.getByLabelText('Time'));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '07:05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveInsightsSuite).toHaveBeenCalledTimes(1));
    expect(mocks.saveInsightsSuite.mock.calls[0]![0]).toEqual({
      scheduleCron: '5 7 * * 2', scheduleTimezone: 'America/Chicago',
      planSource: { projectId: 'acme-analytics' }, businessUnit: 'TX',
    });
  });

  it('over someone else\'s suite, warns, asks first, and saves with takeOver', async () => {
    // `confirm()` falls back to the native dialog when its host is not mounted.
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mocks.getInsightsSuite.mockResolvedValue(saved({ runsAsYou: false }));
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText(/runs as another member\. Saving/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Take over and save' }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith('Take over this schedule?'));
    expect(mocks.saveInsightsSuite, 'a declined take-over still saved').not.toHaveBeenCalled();
    ask.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Take over and save' }));
    await waitFor(() => expect(mocks.saveInsightsSuite).toHaveBeenCalledTimes(1));
    expect(mocks.saveInsightsSuite.mock.calls[0]![0]).toMatchObject({ takeOver: true });
  });

  it('keeps a stored custom cron when only another field is edited', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved({ config: { ...saved().config!, scheduleCron: '0 9 1 * *' } }));
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText(/0 9 1 \* \*/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Business unit'), { target: { value: 'CA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveInsightsSuite).toHaveBeenCalledTimes(1));
    expect(mocks.saveInsightsSuite.mock.calls[0]![0], 'an unrelated edit replaced the custom cron with Monday 06:00').toMatchObject({ scheduleCron: '0 9 1 * *', businessUnit: 'CA' });
  });

  it('says a saved schedule that is not armed is not running, and only offers a save to an editor', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved({ scheduleArmed: false }));
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText(/paused or removed in Schedules\. Save here/)).toBeTruthy());
    cleanup();
    mocks.getInsightsSuite.mockResolvedValue(saved({ scheduleArmed: false, canWrite: false }));
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText(/paused or removed in Schedules\.$/)).toBeTruthy());
    expect(screen.queryByText(/Save here/), 'a read-only viewer was told to save').toBeNull();
  });

  it('a custom cron hides the day and time pickers until the person chooses to replace it', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved({ config: { ...saved().config!, scheduleCron: '0 9 1 * *' } }));
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText(/0 9 1 \* \*/)).toBeTruthy());
    expect(screen.queryByLabelText('Time'), 'the pickers showed a schedule that is not the saved one').toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a day and time instead' }));
    expect(screen.getByLabelText('Time')).toBeTruthy();
  });

  it('turning someone else\'s schedule off asks about turning it off, not about taking it over', async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.getInsightsSuite.mockResolvedValue(saved({ runsAsYou: false }));
    render(<InsightsSuitePanel />);
    await waitFor(() => screen.getByLabelText('Run the weekly variance on a schedule'));
    fireEvent.click(screen.getByLabelText('Run the weekly variance on a schedule'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off and save' }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith('Turn off this schedule?'));
    await waitFor(() => expect(mocks.saveInsightsSuite).toHaveBeenCalledTimes(1));
    expect(mocks.saveInsightsSuite.mock.calls[0]![0]).toMatchObject({ takeOver: true });
    expect(mocks.saveInsightsSuite.mock.calls[0]![0]).not.toHaveProperty('scheduleCron');
  });

  it('a busy refusal is said for the form, not pinned on the schedule field', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved());
    mocks.saveInsightsSuite.mockRejectedValue(new InsightsSuiteSaveError('The weekly variance schedule was refused: lost a write race', 400, 'scheduleCron', 'write_contention'));
    render(<InsightsSuitePanel />);
    await waitFor(() => screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/being changed right now/)).toBeTruthy());
    expect(screen.getByLabelText('Time').getAttribute('aria-invalid')).toBe('false');
  });

  it('a read-only viewer of someone else\'s suite gets no take-over copy', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved({ runsAsYou: false, canWrite: false }));
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText('This schedule runs as another member.')).toBeTruthy());
    expect(screen.queryByText(/Saving makes it run as you/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take over and save' })).toBeNull();
  });

  it('turning the schedule off sends no cron', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved());
    render(<InsightsSuitePanel />);
    await waitFor(() => screen.getByLabelText('Run the weekly variance on a schedule'));
    fireEvent.click(screen.getByLabelText('Run the weekly variance on a schedule'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveInsightsSuite).toHaveBeenCalledTimes(1));
    expect(mocks.saveInsightsSuite.mock.calls[0]![0]).not.toHaveProperty('scheduleCron');
  });

  it('puts a field refusal on its field, in the panel\'s words, not the server\'s', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved());
    mocks.saveInsightsSuite.mockRejectedValue(new InsightsSuiteSaveError('`0 0 31 2 *` never fires within the next 400 days.', 400, 'scheduleCron', 'schedule_horizon_exceeded'));
    render(<InsightsSuitePanel />);
    await waitFor(() => screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('That schedule never runs. Choose a day and time.')).toBeTruthy());
    expect(screen.queryByText(/never fires within/), 'the server\'s developer English reached the panel').toBeNull();
    const time = screen.getByLabelText('Time');
    expect(time.getAttribute('aria-invalid')).toBe('true');
    expect(time.getAttribute('aria-describedby')).toContain('insights-schedule-err');
    // Focus moves to the first invalid field, so the person lands on it.
    await waitFor(() => expect(document.activeElement).toBe(time));
  });

  it('checks the project id before sending it', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved());
    render(<InsightsSuitePanel />);
    await waitFor(() => screen.getByLabelText('BigQuery project'));
    fireEvent.change(screen.getByLabelText('BigQuery project'), { target: { value: 'Not A Project!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Use the project id/)).toBeTruthy());
    expect(mocks.saveInsightsSuite).not.toHaveBeenCalled();
    const project = screen.getByLabelText('BigQuery project');
    expect(project.getAttribute('aria-describedby')).toBe('insights-project-hint insights-project-err');
  });

  it('refuses locally to schedule with no project', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved({ config: null, runsAsYou: null }));
    render(<InsightsSuitePanel />);
    await waitFor(() => screen.getByLabelText('Run the weekly variance on a schedule'));
    fireEvent.click(screen.getByLabelText('Run the weekly variance on a schedule'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Enter the BigQuery project/)).toBeTruthy());
    expect(mocks.saveInsightsSuite).not.toHaveBeenCalled();
  });

  it('a read-only caller sees the settings and no save', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved({ canWrite: false }));
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText('Only workspace editors can change these settings.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect((screen.getByLabelText('BigQuery project') as HTMLInputElement).disabled).toBe(true);
  });

  it('the anniversary trigger is shown, unavailable with its reason, and cannot be turned on', async () => {
    mocks.getInsightsSuite.mockResolvedValue(saved());
    render(<InsightsSuitePanel />);
    const box = (await screen.findByLabelText(/recognition draft automatically/)) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute('aria-describedby')).toBe('insights-anniversary-note');
    fireEvent.click(box);
    expect(box.checked, 'the unavailable trigger could be ticked').toBe(false);
    expect(screen.getByText(/Not available yet/)).toBeTruthy();
  });

  it('an unavailable suite renders a state, not the form', async () => {
    mocks.getInsightsSuite.mockResolvedValue(null);
    render(<InsightsSuitePanel />);
    await waitFor(() => expect(screen.getByText('Insights & Drafting is not available')).toBeTruthy());
    expect(screen.queryByLabelText('BigQuery project')).toBeNull();
  });
});
