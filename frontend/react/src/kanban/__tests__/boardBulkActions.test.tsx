/**
 * KB-BULK — multi-select + bulk actions (the Linear model, round-4 catalog).
 * Invariants:
 *   - `x` on the focused card toggles selection; the bulk bar appears with
 *     the count and disappears when cleared (Esc)
 *   - ⌘A selects the whole VIEW (both columns), never while typing
 *   - bulk move / priority / delete fan out over the EXISTING per-card
 *     callbacks — one call per selected card, then the selection clears
 *   - actions render only when their callback exists (structural no-op)
 *   - Shift-click ranges within a column
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ComponentProps } from 'react';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const ann = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock('../../ui/announce.js', () => ann);

import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';

const board: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done', terminal: true }],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
} as KanbanBoard;
const cards: KanbanCard[] = [
  { id: 'c1', boardId: 'b1', columnId: 'todo', title: 'Alpha', priority: 'normal', order: 0 } as KanbanCard,
  { id: 'c2', boardId: 'b1', columnId: 'todo', title: 'Beta', priority: 'normal', order: 1 } as KanbanCard,
  { id: 'c3', boardId: 'b1', columnId: 'todo', title: 'Gamma', priority: 'normal', order: 2 } as KanbanCard,
  { id: 'c4', boardId: 'b1', columnId: 'done', title: 'Delta', priority: 'normal', order: 0 } as KanbanCard,
];

afterEach(cleanup);

// Mocks are typed from the component's OWN prop types rather than bare
// `ReturnType<typeof vi.fn>`, which erases to `Mock<Procedure | Constructable>`
// and is not assignable to any concrete handler signature. The type ratchet
// (`npm run check:test-types`) surfaced these — unit tests are excluded from the
// build's tsc and vitest transpiles without checking, so they were invisible.
// Typing from the props also means a future signature change fails HERE rather
// than passing a wrongly-shaped mock into a green test.
type BoardProps = ComponentProps<typeof KanbanBoardView>;
type MoveCard = NonNullable<BoardProps['onMoveCard']>;

function view(overrides: {
  onEditCard?: BoardProps['onEditCard'];
  onDeleteCards?: BoardProps['onDeleteCards'];
  onMoveCard?: Mock<MoveCard>;
  onCreateCard?: BoardProps['onCreateCard'];
} = {}): Mock<MoveCard> {
  const onMoveCard: Mock<MoveCard> = overrides.onMoveCard ?? vi.fn<MoveCard>();
  render(
    <MemoryRouter>
      <KanbanBoardView
        board={board}
        cards={cards}
        onMoveCard={onMoveCard}
        onCreateCard={overrides.onCreateCard}
        onEditCard={overrides.onEditCard}
        onDeleteCards={overrides.onDeleteCards}
      />
    </MemoryRouter>,
  );
  return onMoveCard;
}
const grip = (title: string): HTMLElement => screen.getByLabelText(`Drag ${title} to another lane`);
const bar = (): HTMLElement => screen.getByRole('toolbar', { name: 'Bulk actions for selected cards' });

describe('KB-BULK — selection', () => {
  it('`x` toggles the focused card; the bar shows the count; Esc clears', () => {
    view();
    fireEvent.keyDown(grip('Alpha'), { key: 'x' });
    expect(within(bar()).getByText('1 selected')).toBeTruthy();
    fireEvent.keyDown(grip('Beta'), { key: 'x' });
    expect(within(bar()).getByText('2 selected')).toBeTruthy();
    fireEvent.keyDown(grip('Beta'), { key: 'x' }); // toggle off
    expect(within(bar()).getByText('1 selected')).toBeTruthy();
    fireEvent.keyDown(grip('Alpha'), { key: 'Escape' });
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions for selected cards' })).toBeNull();
  });

  it('⌘A selects the whole view — cards in BOTH columns', () => {
    view();
    fireEvent.keyDown(grip('Alpha'), { key: 'a', metaKey: true });
    expect(within(bar()).getByText('4 selected')).toBeTruthy();
  });

  it('`x` inside a form field is typing, not selection (polarity)', () => {
    view({ onCreateCard: vi.fn() });
    fireEvent.click(screen.getAllByRole('button', { name: '+ Add card' })[0]!);
    fireEvent.keyDown(screen.getByPlaceholderText('Task title…'), { key: 'x' });
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions for selected cards' })).toBeNull();
  });

  it('Shift+x ranges within the column from the anchor', () => {
    view();
    fireEvent.keyDown(grip('Alpha'), { key: 'x' }); // anchor
    fireEvent.keyDown(grip('Gamma'), { key: 'x', shiftKey: true });
    expect(within(bar()).getByText('3 selected')).toBeTruthy(); // Alpha..Gamma spans Beta
  });
});

describe('KB-BULK — bulk actions fan out over the existing callbacks', () => {
  it('move: one onMoveCard per selected card, then the selection clears', () => {
    const onMoveCard = view();
    fireEvent.keyDown(grip('Alpha'), { key: 'x' });
    fireEvent.keyDown(grip('Beta'), { key: 'x' });
    fireEvent.change(within(bar()).getByLabelText('Move to'), { target: { value: 'done' } });
    expect(onMoveCard).toHaveBeenCalledTimes(2);
    expect(onMoveCard.mock.calls.map((c) => c[0]).sort()).toEqual(['c1', 'c2']);
    expect(onMoveCard.mock.calls.every((c) => c[1] === 'done')).toBe(true);
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions for selected cards' })).toBeNull();
  });

  it('priority + delete render ONLY with their callbacks; delete is ONE batched call', () => {
    const onEditCard = vi.fn();
    const onDeleteCards = vi.fn();
    view({ onEditCard, onDeleteCards });
    fireEvent.keyDown(grip('Alpha'), { key: 'x' });
    fireEvent.keyDown(grip('Gamma'), { key: 'x' });
    fireEvent.change(within(bar()).getByLabelText('Priority'), { target: { value: 'high' } });
    expect(onEditCard).toHaveBeenCalledTimes(2);
    expect(onEditCard).toHaveBeenCalledWith('c1', { priority: 'high' });

    fireEvent.keyDown(grip('Beta'), { key: 'x' });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Delete 1' }));
    // ONE call with the id list — the consumer confirms ONCE for the batch
    // (a fan-out over onDeleteCard would pop N confirm dialogs).
    expect(onDeleteCards).toHaveBeenCalledTimes(1);
    expect(onDeleteCards).toHaveBeenCalledWith(['c2']);
  });

  it('without onEditCard/onDeleteCards the bar offers NO priority/delete (structural no-op)', () => {
    view();
    fireEvent.keyDown(grip('Alpha'), { key: 'x' });
    expect(within(bar()).queryByLabelText('Priority')).toBeNull();
    expect(within(bar()).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(within(bar()).getByLabelText('Move to')).toBeTruthy(); // move always exists
  });
});

describe('KB-BULK — announced counts are grammatical (live-verified defect)', () => {
  it('singular vs plural: "1 card selected" then "2 cards selected"', () => {
    view();
    fireEvent.keyDown(grip('Alpha'), { key: 'x' });
    expect(ann.announce).toHaveBeenLastCalledWith('1 card selected.'); // NOT "1 cards"
    fireEvent.keyDown(grip('Beta'), { key: 'x' });
    expect(ann.announce).toHaveBeenLastCalledWith('2 cards selected.');
  });
});
