/**
 * ADR 0107 follow-on — the knowledge-sync FolderPicker drill-in browser (a user picks a
 * Drive/OneDrive/Dropbox/Box folder instead of pasting a raw id). `browseFolders` is
 * mocked; nothing here fetches. What breaks each case:
 *  - the ROOT is browsed with `folderId: undefined` (the API's root form) — red if the
 *    picker sends its internal `'root'` sentinel to the API;
 *  - clicking a folder drills in (re-browses by THAT folder's id), and "Use “<name>”"
 *    names and selects the CURRENT (drilled-in) folder — red if drilling does not push
 *    onto the trail or Use selects anything but the trail tip;
 *  - a folder with no subfolders shows the empty-state copy, not a blank list;
 *  - a failed browse shows the localized error Notice (ADR 1101 D7), never the server's
 *    English and never the empty state.
 * `onSelect` receives the folder's id AND name (ADR 1101 D8), so a swapped or dropped
 * name is red too. Each read is settled by draining the mocked promise inside `act`,
 * then asserted synchronously, so a break reads as a value mismatch, not a timeout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

vi.mock('../knowledgeSyncClient.js', () => ({ browseFolders: vi.fn() }));
import { FolderPicker } from '../FolderPicker.js';
import { browseFolders } from '../knowledgeSyncClient.js';

const mBrowse = vi.mocked(browseFolders);
beforeEach(() => mBrowse.mockReset());
afterEach(cleanup);

/** Let the mocked `browseFolders` promise (and its `.then`/`.catch`) settle and commit. */
const settle = (): Promise<void> => act(async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
});

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
    // Drilling PUSHES onto the trail: the breadcrumb is `Home › Reports`, Home still
    // clickable and the current crumb disabled (a replaced trail would lose `Home`).
    expect(screen.getAllByRole('button').map((b) => [b.textContent?.trim(), b.hasAttribute('disabled')])).toEqual([
      ['Home', false], ['Reports', true], ['Q1', false], ['Use “Reports”', false],
    ]);
    // The Use button names the folder it will select (en: `Use “{{name}}”`).
    fireEvent.click(screen.getByRole('button', { name: 'Use “Reports”' }));
    expect(onSelect.mock.calls).toEqual([['fa', 'Reports']]); // the current (drilled-in) folder, and its name (ADR 1101 D8)
  });

  it('shows an empty state when a folder has no subfolders', async () => {
    mBrowse.mockResolvedValue([]);
    render(<FolderPicker orgId="o1" connectionId="c1" onSelect={vi.fn()} />);
    await settle();
    expect(mBrowse).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByText('No subfolders here.')).toHaveLength(1);
  });

  it('a failed browse is a localized Notice, not the server sentence in a chip (ADR 1101 D7)', async () => {
    mBrowse.mockRejectedValueOnce(new Error('SERVER ENGLISH 502'));
    render(<FolderPicker orgId="o1" connectionId="c1" onSelect={vi.fn()} />);
    await settle();
    expect(mBrowse).toHaveBeenCalledTimes(1);
    const notices = screen.queryAllByText('Could not list folders.');
    expect(notices).toHaveLength(1);
    // An error-toned Notice (`.alert.error`), not a chip or neutral text.
    expect(notices[0]!.closest('.alert.error')).not.toBeNull();
    expect(screen.queryByText(/SERVER ENGLISH/)).toBeNull();
    // A failed read is not presented as an empty folder.
    expect(screen.queryByText('No subfolders here.')).toBeNull();
  });
});
