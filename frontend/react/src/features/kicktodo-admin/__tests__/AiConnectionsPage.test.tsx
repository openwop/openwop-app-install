/**
 * KTD-4 (KickTodo UX-ASSESSMENT) — AI & connections had no test. Its whole job
 * is the B20 rule: the calendar-write port reads "awaiting adapter" and NEVER
 * "connected" until a transport is actually wired, and a status it could not
 * read is "unknown" — neither connected nor awaiting.
 *
 * Breaks it (sabotage-witnessed): the `configured ? connected : awaiting`
 * branches swapped; a failed read rendered as "awaiting adapter" (`null`
 * collapsed into `false`); the Retry button removed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { messages as en } from '../i18n/en.js';

const api = vi.hoisted(() => ({ getCalendarStatus: vi.fn<() => Promise<{ transportConfigured: boolean }>>() }));
vi.mock('../../../client/kicktodoIntegrationsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoIntegrationsClient.js')>()),
  ...api,
}));

import { AiConnectionsPage } from '../AiConnectionsPage.js';

const renderPage = () => render(<MemoryRouter><AiConnectionsPage /></MemoryRouter>);
afterEach(() => { cleanup(); api.getCalendarStatus.mockReset(); });

describe('AiConnectionsPage (KTD-4)', () => {
  it('no transport wired: "awaiting adapter", never "connected"', async () => {
    api.getCalendarStatus.mockResolvedValue({ transportConfigured: false });
    renderPage();
    await waitFor(() => expect(screen.getByText(en.calendarAwaitingAdapter)).toBeTruthy());
    expect(screen.queryByText(en.calendarConnected)).toBeNull();
    expect(screen.getByRole('link', { name: en.openConnections }).getAttribute('href')).toBe('/connections');
  });

  it('a wired transport reads "connected"', async () => {
    api.getCalendarStatus.mockResolvedValue({ transportConfigured: true });
    renderPage();
    await waitFor(() => expect(screen.getByText(en.calendarConnected)).toBeTruthy());
    expect(screen.queryByText(en.calendarAwaitingAdapter)).toBeNull();
  });

  it('a failed read is "unknown" with Retry — not "awaiting adapter" — and Retry recovers', async () => {
    api.getCalendarStatus.mockRejectedValueOnce(new Error('calendar status failed: 503')).mockResolvedValue({ transportConfigured: true });
    renderPage();
    await waitFor(() => expect(screen.getByText(en.connectionsError)).toBeTruthy());
    expect(screen.getByText(en.calendarUnknown)).toBeTruthy();
    expect(screen.queryByText(en.calendarAwaitingAdapter)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.retry }));
    await waitFor(() => expect(screen.getByText(en.calendarConnected)).toBeTruthy());
    expect(screen.queryByText(en.connectionsError)).toBeNull();
  });
});
