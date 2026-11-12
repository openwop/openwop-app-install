/**
 * ADR 0107 follow-on — the knowledge-sync FolderPicker drill-in browser (a user picks a
 * Drive/OneDrive/Dropbox/Box folder instead of pasting a raw id). `browseFolders` is
 * mocked; nothing here fetches. What breaks each case:
 *  - the ROOT is browsed with `folderId: undefined` (the API's root form) — red if the
 *    picker sends its internal `'root'` sentinel to the API;
 *  - clicking a folder drills in (re-browses by THAT folder's id), and "Use “<name>”"
 *    names and selects the CURRENT (drilled-in) folder — red if drilling does not push
 *    onto the trail or Use selects anything but the trail tip;
 *  - a folder with no subfolders shows the empty-state copy, not a blank list.
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
    await screen.findByText('Reports');
    expect(screen.getByText('Decks')).toBeTruthy();
    expect(mBrowse).toHaveBeenCalledWith('o1', 'c1', undefined); // root
  });

  it('drills into a folder (re-browses by its id) and selects the current folder', async () => {
    mBrowse
      .mockResolvedValueOnce([{ id: 'fa', name: 'Reports' }]) // root
      .mockResolvedValueOnce([{ id: 'fa1', name: 'Q1' }]);     // inside Reports
    const onSelect = vi.fn();
    render(<FolderPicker orgId="o1" connectionId="c1" onSelect={onSelect} />);
    fireEvent.click(await screen.findByText('Reports'));
    await waitFor(() => expect(mBrowse).toHaveBeenCalledWith('o1', 'c1', 'fa')); // drilled in
    await screen.findByText('Q1');
    // The Use button names the folder it will select (en: `Use “{{name}}”`).
    fireEvent.click(screen.getByRole('button', { name: 'Use “Reports”' }));
    expect(onSelect).toHaveBeenCalledWith('fa', 'Reports'); // the current (drilled-in) folder, and its name (ADR 1101 D8)
  });

  it('shows an empty state when a folder has no subfolders', async () => {
    mBrowse.mockResolvedValue([]);
    render(<FolderPicker orgId="o1" connectionId="c1" onSelect={vi.fn()} />);
    expect(await screen.findByText('No subfolders here.')).toBeTruthy();
  });

  it('a failed browse is a localized Notice, not the server sentence in a chip (ADR 1101 D7)', async () => {
    mBrowse.mockRejectedValueOnce(new Error('SERVER ENGLISH 502'));
    render(<FolderPicker orgId="o1" connectionId="c1" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Could not list folders.')).toBeTruthy());
    expect(screen.queryByText(/SERVER ENGLISH/)).toBeNull();
  });
});
