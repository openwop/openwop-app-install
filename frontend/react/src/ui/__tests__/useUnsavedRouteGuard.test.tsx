import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../confirm.js', () => ({ confirm: confirmMock }));

import { useUnsavedRouteGuard } from '../useUnsavedChangesWarning.js';

function Editor(): JSX.Element {
  useUnsavedRouteGuard(true);
  return <Link to="/next">Leave editor</Link>;
}

afterEach(() => { cleanup(); confirmMock.mockReset(); });

describe('useUnsavedRouteGuard', () => {
  it('preserves the route when discard is rejected', async () => {
    confirmMock.mockResolvedValue(false);
    render(<MemoryRouter initialEntries={['/edit']}><Routes><Route path="/edit" element={<Editor />} /><Route path="/next" element={<p>Next page</p>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('link', { name: 'Leave editor' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledOnce());
    expect(screen.queryByText('Next page')).toBeNull();
  });

  it('continues same-origin navigation after discard is confirmed', async () => {
    confirmMock.mockResolvedValue(true);
    render(<MemoryRouter initialEntries={['/edit']}><Routes><Route path="/edit" element={<Editor />} /><Route path="/next" element={<p>Next page</p>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('link', { name: 'Leave editor' }));
    expect(await screen.findByText('Next page')).toBeTruthy();
  });
});
