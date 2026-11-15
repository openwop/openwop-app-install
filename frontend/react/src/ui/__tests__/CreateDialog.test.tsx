import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { CreateDialog } from '../CreateDialog.js';

afterEach(cleanup);

/**
 * issue 5921 — the create dialog list pages open from their header button. It owns the
 * busy / error / close cycle every page used to hand-roll: success closes it, a
 * failure keeps it open with the message inside, and submit is a real form submit.
 */
function setup(onSubmit: () => Promise<void>, canSubmit = true) {
  const onClose = vi.fn();
  render(
    <CreateDialog title="New project" submitLabel="Create project" canSubmit={canSubmit} onSubmit={onSubmit} onClose={onClose} errorFallback="Could not create it.">
      <label>Name <input aria-label="Name" defaultValue="Launch" /></label>
    </CreateDialog>,
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: 'New project' }), submit: screen.getByRole('button', { name: 'Create project' }) };
}

describe('CreateDialog', () => {
  it('is a named dialog whose heading matches, with the fields inside', () => {
    const { dialog } = setup(async () => undefined);
    expect(dialog.querySelector('h2')?.textContent).toBe('New project');
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('closes when the create succeeds', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { onClose, submit } = setup(onSubmit);
    fireEvent.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('stays open with the error inside when the create fails, and can be retried', async () => {
    const onSubmit = vi.fn(async () => { throw new Error('That name is taken.'); });
    const { onClose, submit, dialog } = setup(onSubmit);
    fireEvent.click(submit);
    await waitFor(() => expect(dialog.textContent).toContain('That name is taken.'));
    expect(onClose).not.toHaveBeenCalled();
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('falls back to its own message when the failure carries none', async () => {
    const { dialog, submit } = setup(async () => { throw new Error(''); });
    fireEvent.click(submit);
    await waitFor(() => expect(dialog.textContent).toContain('Could not create it.'));
  });

  it('cannot submit until the fields are complete', () => {
    const onSubmit = vi.fn(async () => undefined);
    const { submit } = setup(onSubmit, false);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(submit.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('while the form cannot be offered, the footer has only Close: no dead primary button', () => {
    const onClose = vi.fn();
    render(
      <CreateDialog title="New project" submitLabel="Create project" canSubmit={false} ready={false} onSubmit={async () => undefined} onClose={onClose} errorFallback="x">
        <p>Could not load your organizations.</p>
      </CreateDialog>,
    );
    expect(screen.queryByRole('button', { name: 'Create project' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes it', () => {
    const { onClose } = setup(async () => undefined);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
