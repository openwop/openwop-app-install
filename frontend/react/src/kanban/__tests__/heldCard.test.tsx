/**
 * ADR 0963 D3 — a card the work loop holds after a stopped or failed run.
 *
 * The note on such a card mixes a person's text with a machine line marked
 * `[auto:run-restore]`. The board must show the hold as a STATE with a Release
 * action, never print the marker, and an edit of the person's text must neither
 * release the hold nor merge the two lines.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';
import { humanNote, isHeldNote, machineNote, withMachineNote } from '../restoreNote.js';

const MACHINE = '[auto:run-restore] Held — its run failed (run-1). Clear this note to let the agent pick it up again.';
const board: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done', terminal: true }],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};
const card = (blockerNote: string): KanbanCard => ({
  id: 'c1', boardId: 'b1', columnId: 'todo', title: 'Crashed thing', order: 0, blockerNote,
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
});

afterEach(cleanup);

function view(c: KanbanCard, onEditCard: ComponentProps<typeof KanbanBoardView>['onEditCard']): HTMLElement {
  return render(
    <MemoryRouter>
      <KanbanBoardView board={board} cards={[c]} onMoveCard={vi.fn()} onEditCard={onEditCard} />
    </MemoryRouter>,
  ).container;
}

describe('a held card on the board', () => {
  it('shows the hold as a state, keeps the person\'s note, and never prints the marker', () => {
    const container = view(card(`waiting on legal\n${MACHINE}`), vi.fn());
    expect(container.textContent).not.toContain('[auto:run-restore]');
    expect(container.textContent).toContain('waiting on legal');
    expect(screen.getByRole('button', { name: /Release “Crashed thing”/ })).toBeTruthy();
  });

  it('Release removes only the machine line', () => {
    const onEditCard = vi.fn();
    view(card(`waiting on legal\n${MACHINE}`), onEditCard);
    fireEvent.click(screen.getByRole('button', { name: /Release “Crashed thing”/ }));
    expect(onEditCard).toHaveBeenCalledWith('c1', { blockerNote: 'waiting on legal', ifBlockerNote: `waiting on legal\n${MACHINE}` });
  });

  it('editing the person\'s note keeps the hold on its own line', () => {
    const onEditCard = vi.fn();
    view(card(`waiting on legal\n${MACHINE}`), onEditCard);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Crashed thing' }));
    const field = screen.getByLabelText('Blocker note') as HTMLInputElement;
    expect(field.value).toBe('waiting on legal');
    fireEvent.change(field, { target: { value: 'waiting on legal and finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEditCard).toHaveBeenCalledWith('c1', { blockerNote: `waiting on legal and finance\n${MACHINE}`, ifBlockerNote: `waiting on legal\n${MACHINE}` });
  });

  it('a peer note arriving while editing cannot authorize overwriting unseen text', () => {
    const onEditCard = vi.fn();
    const initial = `waiting on legal\n${MACHINE}`;
    const renderBoard = (note: string) => (
      <MemoryRouter>
        <KanbanBoardView board={board} cards={[card(note)]} onMoveCard={vi.fn()} onEditCard={onEditCard} />
      </MemoryRouter>
    );
    const { rerender } = render(renderBoard(initial));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Crashed thing' }));
    rerender(renderBoard('peer edited this\n[auto:run-restore] a different hold'));
    fireEvent.change(screen.getByLabelText('Blocker note'), { target: { value: 'my revised note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEditCard).toHaveBeenCalledExactlyOnceWith('c1', { blockerNote: `my revised note\n${MACHINE}`, ifBlockerNote: initial });
  });

  it('a card with only a person\'s note is not held', () => {
    view(card('waiting on legal'), vi.fn());
    expect(screen.queryByRole('button', { name: /Release/ })).toBeNull();
  });
});

describe('restoreNote helpers', () => {
  it('split and recombine a mixed note', () => {
    const note = `a\n${MACHINE}`;
    expect(isHeldNote(note)).toBe(true);
    expect(humanNote(note)).toBe('a');
    expect(machineNote(note)).toBe(MACHINE);
    expect(withMachineNote('b', machineNote(note))).toBe(`b\n${MACHINE}`);
    expect(withMachineNote('', '')).toBe('');
  });
});

describe('the card is a focus target for "show me this card"', () => {
  it('can take programmatic focus without becoming a tab stop', () => {
    const container = view(card(MACHINE), vi.fn());
    const el = container.querySelector<HTMLElement>('[data-card-id="c1"]')!;
    expect(el.tabIndex).toBe(-1);
    el.focus();
    expect(document.activeElement).toBe(el);
  });
});
