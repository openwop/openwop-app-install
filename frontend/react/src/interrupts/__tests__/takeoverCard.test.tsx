/**
 * ADR 1136 P3a — the take-over card: the browser agent hands a sign-in to the
 * person. It shows the page's host from the recorded take-over, says in host
 * words to sign in in the browser window (never here), fences the page-derived
 * field label, and answers Continue / Stop.
 *
 * Sabotage witnesses (each red, then restored): render the clarification free-text
 * field for a take-over → "renders the take-over card"; show the full origin URL or
 * the label unfenced → "names the host"; accept a non-URL origin → "rejects".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OpenInterrupt } from '../../client/interruptsClient.js';

const resolveByRun = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../../client/interruptsClient.js', () => ({ resolveByRun }));
const { RenderInterrupt } = await import('../RenderInterrupt.js');
const { takeoverOf } = await import('../TakeoverCard.js');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const takeover = (over: Record<string, unknown> = {}): OpenInterrupt => ({
  interruptId: 'i-1', nodeId: 'n1', token: 't', kind: 'clarification', createdAt: '2026-11-18T10:00:00.000Z',
  data: {
    question: 'free-text question that must not render as a field',
    computerUseTakeover: { sessionId: 's', n: 1, origin: 'https://shop.example.com', reason: 'credential', expiresAt: '2026-11-18T10:15:00.000Z', label: 'Fill "Password"', ...over },
  },
} as OpenInterrupt);
const renderIt = (i: OpenInterrupt, onResolved = vi.fn()) => render(<MemoryRouter><RenderInterrupt runId="r" active={i} onResolved={onResolved} /></MemoryRouter>);

describe('ADR 1136 P3a — the take-over card', () => {
  it('renders the take-over card, not the free-text clarification field', () => {
    renderIt(takeover());
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop the task' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/Never type a password into this app/)).toBeTruthy();
  });

  it('names the host, and fences the page-derived label', () => {
    const { container } = renderIt(takeover());
    expect(screen.getAllByText(/Sign in yourself on shop\.example\.com/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('https://shop.example.com');
    const q = container.querySelector('q');
    expect(q?.textContent).toBe('Fill "Password"');
  });

  it('Continue and Stop answer with an action', async () => {
    const onResolved = vi.fn();
    renderIt(takeover(), onResolved);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('r', 'n1', { action: 'continue' }));
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalled());
    cleanup();
    renderIt(takeover());
    fireEvent.click(screen.getByRole('button', { name: 'Stop the task' }));
    await vi.waitFor(() => expect(resolveByRun).toHaveBeenLastCalledWith('r', 'n1', { action: 'stop' }));
  });

  it('rejects a take-over whose origin is not a URL, so the ordinary card renders', () => {
    expect(takeoverOf({ computerUseTakeover: { origin: 'not a url' } })).toBeNull();
    expect(takeoverOf({ computerUseTakeover: 'x' })).toBeNull();
    expect(takeoverOf(null)).toBeNull();
    expect(takeoverOf({ computerUseTakeover: { origin: 'https://a.example', label: 'x'.repeat(500) } })?.label).toHaveLength(120);
  });
});
