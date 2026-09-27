/**
 * CRM-UX-18 / CRM-UX-19 — the deals board driven by KEYBOARD, through the REAL
 * shared `KanbanBoardView` (every other CRM test stubs it, so no CRM test had
 * ever exercised dnd-kit's keyboard path).
 *
 *   Space (pick up) → ArrowRight ONCE → Space (drop)  ⇒  moveDeal(dealId, nextStageId), once.
 *
 * Before the column-snapping coordinate getter, one ArrowRight moved the card
 * 25 px inside a 280 px column: the drop landed on the SAME stage and
 * `moveDeal` never fired (KanbanBoardView's `moveCard` no-ops on a same-column
 * drop) — while the instructions read aloud promised "move between columns".
 *
 * jsdom has no layout, so the column and card rects are supplied through a
 * `getBoundingClientRect` stub keyed on the board's own markup
 * (`data-column-id` on `.kb-col`, `.kb-card` on the card).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../../i18n/index.js';
import { CrmRequestError } from '../crmRequestError.js';

const api = vi.hoisted(() => ({
  listCompanies: vi.fn(),
  listDeals: vi.fn(),
  listPipelines: vi.fn(),
  moveDeal: vi.fn(),
}));
vi.mock('../crmOrgClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});
// The REAL column-snapping getter, wrapped so a test can assert what it
// RETURNED for a press — the proof that the keyboard path reached it and that
// the edge case is a decision it made (a thrown call has no return value).
vi.mock('../../../kanban/columnKeyboardCoordinates.js', async (orig) => {
  const actual = await orig<typeof import('../../../kanban/columnKeyboardCoordinates.js')>();
  return { ...actual, columnSnapCoordinateGetter: vi.fn(actual.columnSnapCoordinateGetter) };
});
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', async (orig) => {
  const actual = await orig<{ toast: Record<string, unknown> }>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

import { DealsTab } from '../DealsTab.js';
import { columnSnapCoordinateGetter } from '../../../kanban/columnKeyboardCoordinates.js';
const getter = vi.mocked(columnSnapCoordinateGetter);

const box = (x: number, y: number, width: number, height: number): DOMRect =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect);

/** Two 280 px columns at x=0 and x=300. A card's rect is derived from the
 *  column that CONTAINS it (`closest('[data-column-id]')`) — a card in `s2`
 *  must report an `s2` rect, or the "last column" case below is never reached
 *  (the card would read as sitting in `s1`, move to `s2`, and the drop there
 *  would pass as a same-column no-op for the wrong reason). */
function rectFor(el: Element): DOMRect {
  const h = el as HTMLElement;
  const col = h.dataset?.columnId;
  if (col === 's1') return box(0, 0, 280, 600);
  if (col === 's2') return box(300, 0, 280, 600);
  if (h.classList?.contains('kb-card')) {
    const owner = (h.closest('[data-column-id]') as HTMLElement | null)?.dataset.columnId;
    return box((owner === 's2' ? 300 : 0) + 10, 40, 260, 80);
  }
  return box(0, 0, 0, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear(); // the board⇄table view is persisted; default is the board
  api.listPipelines.mockResolvedValue([{
    pipelineId: 'p1', name: 'Sales',
    stages: [{ stageId: 's1', name: 'New', probability: 10 }, { stageId: 's2', name: 'Qualified', probability: 40 }],
  }]);
  api.listDeals.mockResolvedValue([{ dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1', amount: 5000, status: 'open' }]);
  api.listCompanies.mockResolvedValue([]);
  api.moveDeal.mockResolvedValue({ dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's2', status: 'open' });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return rectFor(this); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Space → (sensor attaches its document listener on a timeout) → ArrowRight ×n → Space. */
async function keyboardMove(presses: number): Promise<void> {
  const grip = await screen.findByLabelText('Drag Globex expansion to another lane');
  fireEvent.keyDown(grip, { code: 'Space' });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  for (let i = 0; i < presses; i += 1) {
    fireEvent.keyDown(grip, { code: 'ArrowRight' });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  fireEvent.keyDown(grip, { code: 'Space' });
}

describe('deals board — keyboard moves are COLUMN moves (CRM-UX-18)', () => {
  it('Space → ArrowRight once → Space calls moveDeal(dealId, nextStageId) exactly once', async () => {
    render(<MemoryRouter><DealsTab orgId="org:1" /></MemoryRouter>);
    await keyboardMove(1);
    await waitFor(() => expect(api.moveDeal).toHaveBeenCalledTimes(1));
    expect(api.moveDeal).toHaveBeenCalledWith('org:1', 'd1', 's2');
    // One press landed the card centred in s2: 300 + (280 − 260) / 2.
    expect(getter).toHaveReturnedWith(expect.objectContaining({ x: 310 }));
  });

  it('ArrowRight at the LAST column moves nothing — a drop there is a same-column no-op', async () => {
    api.listDeals.mockResolvedValue([{ dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's2', amount: 5000, status: 'open' }]);
    render(<MemoryRouter><DealsTab orgId="org:1" /></MemoryRouter>);
    await keyboardMove(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(api.moveDeal).not.toHaveBeenCalled();
    // The getter was REACHED at the last column and chose "no move" — not
    // "threw before deciding" (which would also leave moveDeal uncalled).
    expect(getter).toHaveBeenCalledTimes(1);
    expect(getter).toHaveReturnedWith(undefined);
  });
});

describe('deals board — a failed move says it REVERTED, the table stage select\'s shape (CRM-UX-19)', () => {
  it('a 409 from moveDeal toasts the localized conflict reason + "your change was reverted", never the wire string', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.moveDeal.mockRejectedValue(new CrmRequestError('moveDeal returned 409', 409));
    render(<MemoryRouter><DealsTab orgId="org:1" /></MemoryRouter>);
    await keyboardMove(1);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const msg = toastError.mock.calls[0]![0] as string;
    expect(msg).toBe(`${i18n.t('crm:httpConflict')} — ${i18n.t('crm:changeReverted')}`);
    expect(msg).not.toContain('returned 409');
    // …and the board re-reads so the optimistic move snaps back.
    await waitFor(() => expect(api.listDeals.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
