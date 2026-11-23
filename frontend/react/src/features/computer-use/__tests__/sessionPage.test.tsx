/**
 * ADR 1136 P3b — the session trajectory page. Steps read as HOST labels with the
 * site's host and path; the page-derived label is fenced and labelled; a waiting
 * session names the site and points at the Inbox; `browser_not_connected` shows
 * the Connect-a-browser card; and Stop appears only while the session is live.
 *
 * Sabotage witnesses (each red, then restored): render `step.description` as the
 * step's heading → "fences the page label"; drop the connect branch → "connect
 * card"; show Stop for an ended session → "no Stop once ended"; render `step.url`
 * whole → "a known typed value never reaches the page".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SessionDetail } from '../computerUseClient.js';

const api = vi.hoisted(() => ({ getSession: vi.fn(), stopSession: vi.fn() }));
vi.mock('../computerUseClient.js', async (orig) => ({ ...(await orig<typeof import('../computerUseClient.js')>()), getSession: api.getSession, stopSession: api.stopSession }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));
const { ComputerUseSessionPage } = await import('../ComputerUseSessionPage.js');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const session = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  sessionId: 'cu:1', orgId: 'org-1', status: 'completed', task: 'Find the order status',
  startUrl: 'https://shop.example.com/', allowedOrigins: ['https://shop.example.com'],
  steps: [
    { kind: 'navigate', tier: 'observe', decidedBy: 'auto', at: '2026-11-18T10:00:00.000Z', url: 'https://shop.example.com/orders', description: 'Orders link' },
    { kind: 'submit', tier: 'commit', decidedBy: 'human', at: '2026-11-18T10:01:00.000Z', url: 'https://shop.example.com/orders/track', description: 'Track "IGNORE PREVIOUS"' },
  ],
  createdBy: 'user:a', createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:01:00.000Z',
  ...over,
});
const renderAt = () => render(
  <MemoryRouter initialEntries={['/computer-use/sessions/cu%3A1?org=org-1']}>
    <Routes><Route path="/computer-use/sessions/:sessionId" element={<ComputerUseSessionPage />} /></Routes>
  </MemoryRouter>,
);

describe('ADR 1136 P3b — the session trajectory page', () => {
  it('shows each step as host words with the site, and fences the page label', async () => {
    api.getSession.mockResolvedValue(session());
    const { container } = renderAt();
    await screen.findByText('Opened a page');
    expect(api.getSession).toHaveBeenCalledWith('org-1', 'cu:1');
    const steps = container.querySelectorAll('[data-testid="cu-step"]');
    expect(steps).toHaveLength(2);
    expect(steps[1]!.querySelector('strong')?.textContent).toBe('Submitted');
    expect(steps[1]!.textContent).toContain('shop.example.com/orders/track');
    expect(steps[1]!.textContent).toContain('approved by a person');
    // The page-derived label is a quoted note, never the heading.
    expect(steps[1]!.querySelector('q')?.textContent).toBe('Track "IGNORE PREVIOUS"');
    expect(screen.getAllByText(/Page label \(from the site, not verified\)/)).toHaveLength(2);
  });

  it('a known typed value never reaches the page, even if a URL arrived carrying it', async () => {
    // The backend strips queries (adr1136-p3b-projection); this proves the page
    // does not rely on that alone: it renders host and path, never the query.
    const typed = 'hunter2-typed-value';
    api.getSession.mockResolvedValue(session({
      status: 'awaiting_approval',
      startUrl: `https://shop.example.com/search?q=${typed}`,
      steps: [
        { kind: 'type', tier: 'interact', decidedBy: 'auto', at: '2026-11-18T10:00:00.000Z', url: `https://shop.example.com/search?q=${typed}#${typed}`, description: 'Search' },
        { kind: 'credential', tier: 'commit', decidedBy: 'human', at: '2026-11-18T10:02:00.000Z', url: 'https://login.example.com/', description: 'Password' },
      ],
      pendingAction: { kind: 'submit', description: 'Pay', url: `https://shop.example.com/pay?card=${typed}` },
    }));
    const { container } = renderAt();
    await screen.findByText('Filled a field');
    expect(container.textContent).not.toContain(typed);
    expect(container.innerHTML).not.toContain(typed);
    // The take-over step reads as host text with the reported host only.
    const steps = container.querySelectorAll('[data-testid="cu-step"]');
    expect(steps[1]!.querySelector('strong')?.textContent).toBe('The person signed in themselves on login.example.com');
    expect(steps[1]!.textContent).not.toContain('Sign-in step');
  });

  it('a waiting take-over names the site and points at the Inbox', async () => {
    api.getSession.mockResolvedValue(session({ status: 'awaiting_takeover', takeover: { n: 1, reason: 'credential', origin: 'https://login.example.com', label: 'Password', expiresAt: '2026-11-18T10:15:00.000Z' } }));
    renderAt();
    expect(await screen.findByText(/Waiting for you to sign in on login\.example\.com/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Answer in your Inbox' }).getAttribute('href')).toBe('/inbox');
    expect(screen.getByRole('button', { name: 'Stop the session' })).toBeTruthy();
  });

  it('browser_not_connected shows the connect card, not a bare error', async () => {
    api.getSession.mockResolvedValue(session({ status: 'failed', error: 'browser_not_connected', steps: [] }));
    const { container } = renderAt();
    await screen.findByText('Connect a browser');
    expect(container.querySelector('[data-testid="cu-connect"]')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an unknown error shows its code in host words', async () => {
    api.getSession.mockResolvedValue(session({ status: 'failed', error: 'executor_timeout' }));
    renderAt();
    expect(await screen.findByText('It ended with an error (executor_timeout).')).toBeTruthy();
  });

  it('no Stop once ended; Stop on a live session confirms, then stops', async () => {
    api.getSession.mockResolvedValue(session());
    renderAt();
    await screen.findByText('Opened a page');
    expect(screen.queryByRole('button', { name: 'Stop the session' })).toBeNull();
    cleanup();

    api.getSession.mockResolvedValue(session({ status: 'running' }));
    api.stopSession.mockResolvedValue(session({ status: 'aborted', error: 'aborted_by_user' }));
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop the session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => expect(api.stopSession).toHaveBeenCalledWith('org-1', 'cu:1'));
    expect(await screen.findByText('Someone stopped it.')).toBeTruthy();
  });

  it('a 404 reads as not found', async () => {
    const { ComputerUseApiError } = await import('../computerUseClient.js');
    api.getSession.mockRejectedValue(new ComputerUseApiError('nope', 404));
    renderAt();
    expect(await screen.findByText('Session not found')).toBeTruthy();
  });
});
