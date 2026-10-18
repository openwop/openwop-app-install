/**
 * ADR 0886 D3 / SL2UX-2 — the phone remote stops pretending once the server
 * stops honouring it. The token is re-checked on every command (the minter left
 * the org, lost access to the deck, or the feature was turned off ⇒ 404), but
 * the open SSE feed is only checked at connect, so the page kept saying
 * "Connected" while every tap did nothing. A command's 404 is now the signal.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react';
import { PresentRemotePage } from '../PresentRemotePage.js';

class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { setTimeout(() => this.onopen?.(), 0); }
  addEventListener(): void { /* no nav frames in this test */ }
  close(): void { /* noop */ }
}

let commandStatus = 202;
const fetchMock = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
  if (String(url).endsWith('/outline')) {
    return new Response(JSON.stringify({ title: 'Q3', frames: [{ name: 'Open' }, { name: 'Close' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(null, { status: commandStatus });
});
const EXPIRED = "This remote link has expired. Ask the presenter for a new code.";

/** Wait until a POST to `/command` was made, then let its response settle. */
async function commandLanded(): Promise<void> {
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/present/v2.x.1.y/command'))).toBe(true));
  const at = fetchMock.mock.calls.findIndex(([u]) => String(u).endsWith('/command'));
  const [, init] = fetchMock.mock.calls[at]!;
  expect(init?.method).toBe('POST');
  expect(init?.body).toBe(JSON.stringify({ action: 'next' }));
  await act(async () => {
    await fetchMock.mock.results[at]!.value;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  commandStatus = 202;
  fetchMock.mockClear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PresentRemotePage — revoked mid-show (ADR 0886 D3)', () => {
  it('keeps the controls while commands land', async () => {
    render(<PresentRemotePage token="v2.x.1.y" />);
    const next = await screen.findByRole('button', { name: /next/i });
    fireEvent.click(next);
    await commandLanded(); // the 202 actually came back — not a read taken before it did
    expect(screen.getByRole('button', { name: /next/i })).toBeTruthy();
    expect(screen.queryByText(EXPIRED)).toBeNull();
  });

  it('swaps to the expired state the moment a command answers 404', async () => {
    render(<PresentRemotePage token="v2.x.1.y" />);
    const next = await screen.findByRole('button', { name: /next/i });
    commandStatus = 404;
    fireEvent.click(next);
    await waitFor(() => expect(screen.queryByRole('button', { name: /next/i })).toBeNull());
    // The EXPIRED state specifically (loading/error states also lack Next).
    expect(screen.getByText(EXPIRED)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
