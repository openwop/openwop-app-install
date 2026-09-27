/**
 * SET-R2-1 (settings-admin round 2) — type-to-confirm for the highest-blast-
 * radius deletions.
 *
 * Deleting an organization cascades to every team + member it holds, yet it
 * was one click past a generic confirm. The Vercel delete-project convention
 * (type the resource name before Continue activates —
 * vercel.com/docs/projects/managing-projects) is the industry shape for this
 * class. `ConfirmDialog` gains an opt-in `typeToConfirm`; the affirmative
 * button is DISABLED until the typed value matches exactly.
 *
 * Both polarities: without the prop the dialog behaves exactly as before
 * (no input, immediately armed) — the gate must not tax single-record deletes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '../ConfirmDialog.js';

afterEach(cleanup);

function mount(typeToConfirm?: string): { onConfirm: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      title="Delete organization “Acme”?"
      confirmLabel="Delete"
      danger
      {...(typeToConfirm !== undefined ? { typeToConfirm } : {})}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );
  return { onConfirm };
}

describe('SET-R2-1 — typeToConfirm arms the destructive button only on an exact match', () => {
  it('stays disabled for empty and WRONG input; arms on the exact name; fires', () => {
    const { onConfirm } = mount('Acme');
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByLabelText(/Type Acme to confirm/i);
    fireEvent.change(input, { target: { value: 'Acm' } });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // A disabled button must also not fire if something clicks it anyway.
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Acme' } });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('without the prop the dialog is immediately armed and shows NO input (the old contract)', () => {
    const { onConfirm } = mount();
    expect(screen.queryByLabelText(/to confirm/i)).toBeNull();
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
