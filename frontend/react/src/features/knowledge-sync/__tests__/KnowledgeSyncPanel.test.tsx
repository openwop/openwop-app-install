/**
 * ADR 0107 Phase 5 — the KnowledgeSyncPanel. The client + connections + toast are
 * mocked. Covers: self-hide when the feature is off (list rejects), rendering the
 * collection's sources, adding a source, and "Sync now".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../knowledgeSyncClient.js', () => ({
  listSyncSources: vi.fn(), createSyncSource: vi.fn(), deleteSyncSource: vi.fn(), setSyncPaused: vi.fn(), syncNow: vi.fn(),
}));
vi.mock('../../connections/connectionsClient.js', () => ({ listConnections: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { KnowledgeSyncPanel } from '../KnowledgeSyncPanel.js';
import { listSyncSources, createSyncSource, syncNow } from '../knowledgeSyncClient.js';
import { listConnections } from '../../connections/connectionsClient.js';

const mList = vi.mocked(listSyncSources);
const mCreate = vi.mocked(createSyncSource);
const mSync = vi.mocked(syncNow);
const mConns = vi.mocked(listConnections);

const source = (over = {}) => ({ id: 's1', orgId: 'o1', connectionId: 'c1', provider: 'google', externalFolderId: 'FOLDER', collectionId: 'col1', cadence: 'daily', status: 'active', ...over } as never);

beforeEach(() => {
  mList.mockReset(); mCreate.mockReset(); mSync.mockReset(); mConns.mockReset();
  mConns.mockResolvedValue([{ connectionId: 'c1', provider: 'google', displayName: 'My Drive' }] as never);
});
afterEach(cleanup);

describe('KnowledgeSyncPanel (ADR 0107)', () => {
  it('renders NOTHING when the feature is off (list rejects/404)', async () => {
    mList.mockRejectedValue(new Error('404'));
    const { container } = render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(mList).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.surface-card')).toBeNull());
  });

  it('lists the collection’s sources and the add form', async () => {
    mList.mockResolvedValue([source(), source({ id: 's2', collectionId: 'OTHER' })] as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('Drive sync')).toBeTruthy());
    // only the col1 source shows (the OTHER-collection one is filtered out)
    expect(screen.getByText('FOLDER')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('My Drive')).toBeTruthy()); // connection option loaded
  });

  it('adds a sync source', async () => {
    mList.mockResolvedValue([] as never);
    mCreate.mockResolvedValue(source() as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('My Drive')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Drive account'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Folder ID'), { target: { value: 'FOLDER42' } });
    fireEvent.click(screen.getByRole('button', { name: /Add sync/ }));
    await waitFor(() => expect(mCreate).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o1', collectionId: 'col1', connectionId: 'c1', externalFolderId: 'FOLDER42', provider: 'google', cadence: 'daily',
    })));
  });

  it('a Microsoft connection shows a Source selector; choosing SharePoint sends microsoft-sharepoint', async () => {
    mConns.mockResolvedValue([{ connectionId: 'ms', provider: 'microsoft-graph', displayName: 'Work 365' }] as never);
    mList.mockResolvedValue([] as never);
    mCreate.mockResolvedValue(source() as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('Work 365')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Drive account'), { target: { value: 'ms' } });
    // the OneDrive/SharePoint selector appears only for a Microsoft connection
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'sharepoint' } });
    fireEvent.change(screen.getByLabelText('Folder ID'), { target: { value: 'DRIVEID:ITEM' } });
    fireEvent.click(screen.getByRole('button', { name: /Add sync/ }));
    await waitFor(() => expect(mCreate).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'ms', provider: 'microsoft-sharepoint', externalFolderId: 'DRIVEID:ITEM',
    })));
  });

  it('runs "Sync now"', async () => {
    mList.mockResolvedValue([source()] as never);
    mSync.mockResolvedValue({ result: { ingested: 2, pruned: 1, unchanged: 0, failed: 0, errors: [] }, source: source() } as never);
    render(<KnowledgeSyncPanel orgId="o1" collectionId="col1" />);
    await waitFor(() => expect(screen.getByText('FOLDER')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(mSync).toHaveBeenCalledWith('s1'));
  });
});
