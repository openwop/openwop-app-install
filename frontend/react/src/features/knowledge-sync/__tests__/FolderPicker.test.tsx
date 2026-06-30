/**
 * ADR 0107 follow-on — the FolderPicker drill-in browser. `browseFolders` is mocked.
 * Covers: lists the root's subfolders, drilling into a folder re-browses by its id, and
 * "Use this folder" selects the current folder id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../knowledgeSyncClient.js', () => ({ browseFolders: vi.fn() }));
import { FolderPicker } from '../FolderPicker.js';
import { browseFolders } from '../knowledgeSyncClient.js';

const mBrowse = vi.mocked(browseFolders);
beforeEach(() => mBrowse.mockReset());
afterEach(cleanup);

describe('FolderPicker (ADR 0107)', () => {
  it('lists the root subfolders (root → undefined folderId)', async () => {
    mBrowse.mockResolvedValue([{ id: 'fa', name: 'Reports' }, { id: 'fb', name: 'Decks' }]);
    render(<FolderPicker orgId="o1" connectionId="c1" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Reports')).toBeTruthy());
    expect(mBrowse).toHaveBeenCalledWith('o1', 'c1', undefined); // root
  });

  it('drills into a folder (re-browses by its id) and selects the current folder', async () => {
    mBrowse
      .mockResolvedValueOnce([{ id: 'fa', name: 'Reports' }]) // root
      .mockResolvedValueOnce([{ id: 'fa1', name: 'Q1' }]);     // inside Reports
    const onSelect = vi.fn();
    render(<FolderPicker orgId="o1" connectionId="c1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('Reports')).toBeTruthy());
    fireEvent.click(screen.getByText('Reports'));
    await waitFor(() => expect(mBrowse).toHaveBeenCalledWith('o1', 'c1', 'fa')); // drilled in
    await waitFor(() => expect(screen.getByText('Q1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Use/ }));
    expect(onSelect).toHaveBeenCalledWith('fa'); // the current (drilled-in) folder
  });

  it('shows an empty state when a folder has no subfolders', async () => {
    mBrowse.mockResolvedValue([]);
    render(<FolderPicker orgId="o1" connectionId="c1" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No subfolders here.')).toBeTruthy());
  });
});
