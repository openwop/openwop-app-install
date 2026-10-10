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
 *
 * Sabotage-witnessed (/grade-tests wave 9, `w9g4-eh-*`): pointing the erased code
 * at `/email`, the suppressed code at `/consent`, or giving an unknown code a
 * fallback link each turns its case red. The `getRun` fixture is a production-
 * shaped `RunSnapshot` (typed), not a loose record.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { RunSnapshot } from '@openwop/openwop';

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

// ADR 0661 — the page's module graph reaches the SDK's discovery read
// (`/.well-known/openwop`). Refused deterministically here (the
// `runDetailIntegrity.test.tsx` precedent) instead of riding the shrink-only
// live-fetch allowlist: no leg may depend on a race with the network.
vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new Error('no network in unit tests'))));
const { RunDetailPage } = await import('../RunDetailPage.js');

function failedRun(code: string): RunSnapshot {
  return {
    runId: 'r1', status: 'failed', workflowId: 'wf1',
    owner: { tenant: 't1', subject: { issuer: 'urn:openwop:test', subjectId: 'u1', tenant: 't1', lane: 'session', kind: 'user' } },
    eventLogSchemaVersion: 3,
    startedAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-01T00:00:00Z',
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
