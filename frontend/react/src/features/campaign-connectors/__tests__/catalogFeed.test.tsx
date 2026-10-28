/**
 * ADR 0952 D6 (P7) — the product feed card.
 *
 *  - a failed read is a stated failure, never an "off" feed presented as saved;
 *  - the signed URL shows only while the feed is on;
 *  - rotating asks first (the old URL dies at once) and calls nothing on cancel;
 *  - a push that is not verified says so, never "0 sent" as if it ran;
 *  - the push buttons stay disabled until the target id is saved.
 *
 * Sabotage that turns it red: render the form on a failed read; show the URL
 * while off; rotate without confirm; report `unsupported` as a pushed result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { CatalogFeed } from '../campaignConnectorsClient.js';

const getCatalogFeed = vi.fn();
const saveCatalogFeed = vi.fn();
const rotateCatalogFeed = vi.fn();
const pushCatalogFeed = vi.fn();
const confirmMock = vi.fn();

vi.mock('../campaignConnectorsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCatalogFeed: (...a: unknown[]) => getCatalogFeed(...a),
  saveCatalogFeed: (...a: unknown[]) => saveCatalogFeed(...a),
  rotateCatalogFeed: (...a: unknown[]) => rotateCatalogFeed(...a),
  pushCatalogFeed: (...a: unknown[]) => pushCatalogFeed(...a),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (...a: unknown[]) => confirmMock(...a) }));

import { CatalogFeedCard } from '../CatalogFeedCard.js';

const feed = (over: Partial<CatalogFeed> = {}): CatalogFeed => ({
  enabled: false, version: 1, contentLanguage: 'en', feedLabel: 'US', items: 3, excluded: [{ productId: 'prod:x', reason: 'no_image' }], ...over,
});
const URL1 = 'https://app.example/host/openwop-app/public/org-1/catalog/feed.xml?v=1&sig=abc';

describe('CatalogFeedCard (ADR 0952 D6)', () => {
  beforeEach(() => { for (const m of [getCatalogFeed, saveCatalogFeed, rotateCatalogFeed, pushCatalogFeed, confirmMock]) m.mockReset(); });
  afterEach(() => cleanup());

  it('a failed read says so and shows no form', async () => {
    getCatalogFeed.mockRejectedValue(new Error('boom'));
    render(<CatalogFeedCard orgId="org-1" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByLabelText(/publish the product feed/i)).toBeNull();
  });

  it('shows the signed URL only while on, and lists what is left out', async () => {
    getCatalogFeed.mockResolvedValue(feed());
    saveCatalogFeed.mockResolvedValue(feed({ enabled: true, feedUrl: URL1 }));
    render(<CatalogFeedCard orgId="org-1" />);
    const box = await screen.findByLabelText(/publish the product feed/i);
    expect(screen.queryByLabelText(/feed url/i)).toBeNull();
    expect(screen.getByText(/1 product is left out/i)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(saveCatalogFeed).toHaveBeenCalledWith('org-1', { enabled: true }));
    expect((await screen.findByLabelText(/feed url/i) as HTMLInputElement).value).toBe(URL1);
  });

  it('rotating asks first and does nothing on cancel', async () => {
    getCatalogFeed.mockResolvedValue(feed({ enabled: true, feedUrl: URL1 }));
    confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    rotateCatalogFeed.mockResolvedValue(feed({ enabled: true, version: 2, feedUrl: URL1.replace('v=1', 'v=2') }));
    render(<CatalogFeedCard orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /replace url/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(rotateCatalogFeed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /replace url/i }));
    await waitFor(() => expect(rotateCatalogFeed).toHaveBeenCalledWith('org-1'));
  });

  it('push stays disabled until the id is saved, and an unverified push says so', async () => {
    getCatalogFeed.mockResolvedValue(feed({ enabled: true, feedUrl: URL1 }));
    saveCatalogFeed.mockResolvedValue(feed({ enabled: true, feedUrl: URL1, metaCatalogId: '777' }));
    pushCatalogFeed.mockResolvedValue({ outcome: 'unsupported' });
    render(<CatalogFeedCard orgId="org-1" />);
    const send = await screen.findByRole('button', { name: /send to meta/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/meta catalog id/i), { target: { value: '777' } });
    fireEvent.click(screen.getByRole('button', { name: /save ids/i }));
    await waitFor(() => expect(saveCatalogFeed).toHaveBeenCalledWith('org-1', { metaCatalogId: '777', merchantAccountId: null, merchantDataSource: null }));
    await waitFor(() => expect((screen.getByRole('button', { name: /send to meta/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /send to meta/i }));
    expect(await screen.findByText(/not verified yet/i)).toBeTruthy();
    expect(screen.queryByText(/0 sent/i)).toBeNull();
  });
});
