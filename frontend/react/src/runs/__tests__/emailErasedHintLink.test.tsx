/**
 * ADR 0657 D7 (CONS-UX-25) — the run-detail hint for `email_recipient_erased`
 * links the CONSENT console, not the suppressions panel.
 *
 * An erased subject does not appear on `/email`'s suppressions list: erasure is
 * a consent-console fact (a tombstone the Consent page can show, and that only
 * its re-admit control can lift). Sending the operator to `/email` for it was a
 * link to a page that could neither explain nor act on the refusal. The other
 * egress codes keep their suppressions link — one per-code map, pinned here in
 * both directions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  pollEvents: vi.fn(),
  subscribeToRun: vi.fn(),
}));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRun: api.getRun, pollEvents: api.pollEvents };
});
vi.mock('../../client/streamsClient.js', () => ({ subscribeToRun: api.subscribeToRun }));
vi.mock('../../client/interruptsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listOpenInterrupts: vi.fn(async () => []) };
});
vi.mock('../../client/feedbackClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listAnnotations: vi.fn(async () => []) };
});
vi.mock('../../workflows/workflowsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRunRevision: vi.fn(async () => null) };
});

const { RunDetailPage } = await import('../RunDetailPage.js');

function failedRun(code: string): Record<string, unknown> {
  return {
    runId: 'r1', status: 'failed', workflowId: 'wf1',
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
    error: { code, message: 'refused' },
  };
}

function view(): void {
  render(
    <MemoryRouter initialEntries={['/runs/r1']}>
      <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.pollEvents.mockResolvedValue({ events: [] });
  api.subscribeToRun.mockImplementation(() => ({ close: () => {} }));
});
afterEach(() => cleanup());

describe('run detail — email egress hint destinations (ADR 0657 D7 / CONS-UX-25)', () => {
  it('email_recipient_erased links the Consent page, not the suppressions panel', async () => {
    api.getRun.mockResolvedValue(failedRun('email_recipient_erased'));
    view();
    const link = await screen.findByRole('link', { name: /consent page/i });
    expect(link.getAttribute('href')).toBe('/consent');
    expect(screen.queryByRole('link', { name: /suppressions on the email page/i })).toBeNull();
    expect(screen.getByText(/erased under a data-subject request/i)).toBeTruthy();
  });

  it('email_recipient_suppressed still links the suppressions panel on /email', async () => {
    api.getRun.mockResolvedValue(failedRun('email_recipient_suppressed'));
    view();
    const link = await screen.findByRole('link', { name: /suppressions on the email page/i });
    expect(link.getAttribute('href')).toBe('/email');
    expect(screen.queryByRole('link', { name: /consent page/i })).toBeNull();
  });

  it('an unknown code gets neither hint nor link', async () => {
    api.getRun.mockResolvedValue(failedRun('something_else'));
    view();
    // The Notice's `<strong>{code}:</strong>` — the raw-snapshot <pre> also
    // carries the code, so match the colon-suffixed headline only.
    await screen.findByText(/something_else:/);
    expect(screen.queryByRole('link', { name: /consent page/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /email page/i })).toBeNull();
  });
});
