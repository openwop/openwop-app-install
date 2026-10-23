/**
 * ADR 0930 (feature loop row 52) — the page's personal-data controls, pinned.
 *
 *  1. The pause is the caller's own and stops processing: while paused the page
 *     shows the paused state (never "no patterns yet"), Scan is disabled, and
 *     Resume writes `paused:false` before reloading.
 *  2. Pausing writes `paused:true` and clears the list on screen.
 *  3. A Scan that stopped before the workspace's oldest run says so; a complete
 *     one says nothing.
 *  4. "Make a workflow" is described by the share note: accepting shares the
 *     step pattern with the workspace.
 *
 * Sabotage-witnessed (wave 55/56 probes, each red here): the pause write
 * inverted; Resume's reload dropped; Resume reloading BEFORE its PUT; a declined
 * confirm proceeding anyway; the paused card gated on rows; the status filter
 * kept while paused; the truncation notice dropped or always shown; a swallowed
 * settings-read failure; the erased copy dropped; the 403 mapping moved to 401;
 * dismiss focus landing on the PREVIOUS row; the route tier moved to admin; the
 * share-note description dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Client = typeof import('../workGraphClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<Client['listOrgs']>(), listSuggestions: vi.fn<Client['listSuggestions']>(),
  refreshSuggestions: vi.fn<Client['refreshSuggestions']>(),
  dismissSuggestion: vi.fn<Client['dismissSuggestion']>(), acceptSuggestion: vi.fn<Client['acceptSuggestion']>(),
  getWorkGraphSettings: vi.fn<Client['getWorkGraphSettings']>(), setWorkGraphPaused: vi.fn<Client['setWorkGraphPaused']>(),
}));
vi.mock('../workGraphClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const confirmMock = vi.hoisted(() => vi.fn<typeof import('../../../ui/confirm.js').confirm>());
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));
type Toast = typeof import('../../../ui/toast.js').toast;
const toastMock = vi.hoisted(() => ({ error: vi.fn<Toast['error']>(), success: vi.fn<Toast['success']>() }));
vi.mock('../../../ui/toast.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../ui/toast.js')>();
  return { ...orig, toast: { ...orig.toast, ...toastMock } };
});

import { WorkGraphPage } from '../WorkGraphPage.js';
import { WorkGraphError, type WorkflowSuggestion } from '../workGraphClient.js';

const SUGGESTION: WorkflowSuggestion = {
  suggestionId: 'sg1', tenantId: 't1', ownerPrincipal: 'me', signature: 'email.send>kb.search', sampleGoal: 'Weekly digest',
  toolSequence: ['email.send', 'kb.search'], count: 4, exampleRunIds: ['r1', 'r2'], status: 'suggested',
  firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-02T00:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  api.listSuggestions.mockResolvedValue([SUGGESTION]);
  api.getWorkGraphSettings.mockResolvedValue({ paused: false });
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

const view = (): void => { render(<MemoryRouter><WorkGraphPage /></MemoryRouter>); };

describe('ADR 0930 — personal work patterns', () => {
  it('while paused: the paused state, Scan disabled, and Resume un-pauses then reloads', async () => {
    api.listSuggestions.mockResolvedValue([]);
    api.getWorkGraphSettings.mockResolvedValue({ paused: true });
    api.setWorkGraphPaused.mockResolvedValue({ paused: false });
    view();
    expect(await screen.findByText('Pattern detection is paused')).toBeTruthy();
    expect(screen.queryByText('No patterns yet')).toBeNull();
    // Scan is not offered while paused (it would read nothing).
    expect(screen.queryByRole('button', { name: 'Scan now' })).toBeNull();
    api.listSuggestions.mockResolvedValue([SUGGESTION]);
    api.getWorkGraphSettings.mockResolvedValue({ paused: false }); // what the server says after the PUT
    fireEvent.click(screen.getByRole('button', { name: 'Resume pattern detection' }));
    await waitFor(() => expect(api.setWorkGraphPaused).toHaveBeenCalledWith('o1', false));
    expect(await screen.findByText(/Weekly digest/)).toBeTruthy();
    // "writes BEFORE reloading": the second list read (the reload) follows the PUT.
    // A reload fired before the PUT would read the still-paused server.
    expect(api.listSuggestions).toHaveBeenCalledTimes(2);
    expect(api.setWorkGraphPaused.mock.invocationCallOrder[0]!).toBeLessThan(api.listSuggestions.mock.invocationCallOrder[1]!);
  });

  it('pausing writes paused:true and clears the patterns on screen', async () => {
    api.setWorkGraphPaused.mockResolvedValue({ paused: true });
    // Four rows, so the status filter is showing; it must go with the rows.
    api.listSuggestions.mockResolvedValue([1, 2, 3, 4].map((i) => ({ ...SUGGESTION, suggestionId: `sg${i}`, sampleGoal: i === 1 ? 'Weekly digest' : `Other ${i}` })));
    view();
    expect(await screen.findByText(/Weekly digest/)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause pattern detection' }));
    await waitFor(() => expect(api.setWorkGraphPaused).toHaveBeenCalledWith('o1', true));
    // AWG2UX-3 — the deletion was stated BEFORE the click took effect.
    expect(String(confirmMock.mock.calls[0]?.[0].body)).toMatch(/stored patterns will be deleted/);
    expect(await screen.findByText('Pattern detection is paused')).toBeTruthy();
    expect(screen.queryByText(/Weekly digest/)).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Filter by status' })).toBeNull();
  });

  it('a Scan that stopped short says how far it read', async () => {
    api.refreshSuggestions.mockResolvedValue({ suggestions: [SUGGESTION], paused: false, scanned: 1000, truncated: true });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Scan now' }));
    expect(await screen.findByText(/1000 most recent runs/)).toBeTruthy();
  });

  it('CONTROL: a complete Scan shows no truncation notice', async () => {
    api.refreshSuggestions.mockResolvedValue({ suggestions: [SUGGESTION], paused: false, scanned: 12, truncated: false });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Scan now' }));
    // Positive settle signal: the scan's own success toast has fired, so the
    // truncation state has already been written when the absence is read.
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Scanned your recent runs'));
    expect(screen.queryByText(/most recent runs/)).toBeNull();
  });

  it('"Make a workflow" is described by the share note', async () => {
    view();
    const btn = await screen.findByRole('button', { name: 'Make a workflow: Weekly digest' });
    expect(btn.getAttribute('aria-describedby')).toBe('work-graph-share-note');
    expect(document.getElementById('work-graph-share-note')?.textContent).toMatch(/shares the step pattern/);
  });

  it('AWG2UX-3: declining the confirm changes nothing', async () => {
    confirmMock.mockResolvedValue(false);
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause pattern detection' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    // Settle: let the awaited `false` resolve and any continuation run before
    // reading the absences.
    await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
    expect(api.setWorkGraphPaused).not.toHaveBeenCalled();
    expect(screen.getByText(/Weekly digest/)).toBeTruthy();
    const pause = screen.getByRole('button', { name: 'Pause pattern detection' });
    expect(pause.hasAttribute('disabled')).toBe(false);
  });

  it('AWG2UX-4: a failed settings read is a failed load, never "No patterns yet"', async () => {
    api.listSuggestions.mockResolvedValue([]);
    api.getWorkGraphSettings.mockRejectedValue(new Error('settings_500'));
    view();
    expect(await screen.findByText(/Couldn.t load work patterns/)).toBeTruthy();
    expect(screen.queryByText('No patterns yet')).toBeNull();
  });

  it('AWG2UX-15: after an erasure the page says so, and offers to turn detection back on', async () => {
    api.listSuggestions.mockResolvedValue([]);
    api.getWorkGraphSettings.mockResolvedValue({ paused: true, reason: 'erased' });
    view();
    expect(await screen.findByText('Your work patterns were erased')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn pattern detection back on' })).toBeTruthy();
  });

  it('AWG2UX-9: a refused accept is explained, not echoed', async () => {
    api.acceptSuggestion.mockRejectedValue(new WorkGraphError('workspace:write required', 403));
    view();
    fireEvent.click(await screen.findByRole('button', { name: /^Make a workflow/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('You need edit access in this workspace to do that.'));
  });

  it('AWG2UX-7: after a dismiss the keyboard lands on the next pattern', async () => {
    // Three rows, dismissing the MIDDLE one: "next" (Third) and "previous"
    // (Weekly digest) are different elements, so landing on the wrong one is red.
    api.listSuggestions.mockResolvedValue([
      SUGGESTION,
      { ...SUGGESTION, suggestionId: 'sg2', sampleGoal: 'Second pattern' },
      { ...SUGGESTION, suggestionId: 'sg3', sampleGoal: 'Third pattern' },
    ]);
    api.dismissSuggestion.mockResolvedValue(undefined);
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss: Second pattern' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Make a workflow: Third pattern'));
    expect(api.dismissSuggestion).toHaveBeenCalledWith('o1', 'sg2');
    expect(screen.queryByText(/Second pattern/)).toBeNull();
  });

  it('AWG2UX-7: Scan says it is working while it reads', async () => {
    let finish: (v: Awaited<ReturnType<Client['refreshSuggestions']>>) => void = () => {};
    api.refreshSuggestions.mockReturnValue(new Promise((r) => { finish = r; }));
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Scan now' }));
    const busy = await screen.findByRole('button', { name: 'Scanning…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    finish({ suggestions: [SUGGESTION], paused: false, scanned: 3, truncated: false });
    expect(await screen.findByRole('button', { name: 'Scan now' })).toBeTruthy();
  });

  it('AWG2UX-1: the page is a workspace route, so every member reaches their own patterns', async () => {
    const { ambientWorkGraphFeature } = await import('../routes.js');
    expect(ambientWorkGraphFeature.routes.map((r) => r.tier)).toEqual(['workspace']);
  });

  it('ADR 0930 coverage: the empty state says what it can find today, not a promise', async () => {
    api.listSuggestions.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No patterns yet')).toBeTruthy();
    expect(screen.getByText(/Chat conversations stay open and are not read yet/)).toBeTruthy();
  });
});
