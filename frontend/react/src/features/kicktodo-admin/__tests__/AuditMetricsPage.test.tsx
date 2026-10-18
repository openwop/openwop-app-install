/**
 * KTD-4 (KickTodo UX-ASSESSMENT) — Audit & metrics had no test. Pins:
 *  - every verifier rate shows its denominator (`agreed / resolved`), and the
 *    disagreement rate says "indicative" while it cannot be computed (B18) —
 *    never a fabricated number;
 *  - nothing sampled says so, rather than rendering zeros as a measurement;
 *  - the audit trail is LINKED at its own authority (`/audit-log`), not embedded;
 *  - a failed read is an error with a working Retry, never an empty section.
 *
 * Breaks it (sabotage-witnessed): the `vq.sampled === 0` branch dropped (zeros
 * render as figures); `disagreementRate === null` rendered as a percentage; the
 * Retry button removed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { VerifierQuality } from '../../../client/kicktodoMetricsClient.js';
import { messages as en } from '../i18n/en.js';

const api = vi.hoisted(() => ({ getVerifierQuality: vi.fn<() => Promise<VerifierQuality>>() }));
vi.mock('../../../client/kicktodoMetricsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoMetricsClient.js')>()),
  ...api,
}));

import { AuditMetricsPage } from '../AuditMetricsPage.js';

const SAMPLED: VerifierQuality = { sampled: 40, resolved: 30, agreed: 27, falsePositives: 2, falseNegatives: 1, disagreementRate: 0.1 };
const renderPage = () => render(<MemoryRouter><AuditMetricsPage /></MemoryRouter>);
afterEach(() => { cleanup(); api.getVerifierQuality.mockReset(); });

describe('AuditMetricsPage (KTD-4)', () => {
  it('renders each rate over its denominator and the computed disagreement rate', async () => {
    api.getVerifierQuality.mockResolvedValue(SAMPLED);
    renderPage();
    await waitFor(() => expect(screen.getByText('27 / 30')).toBeTruthy());
    expect(screen.getByText('2 / 30')).toBeTruthy();
    expect(screen.getByText('1 / 30')).toBeTruthy();
    expect(screen.getByText('Disagreement rate: 10%')).toBeTruthy();
    expect(screen.queryByText(en.disagreementIndicative)).toBeNull();
    expect(screen.getByRole('link', { name: en.openAuditLog }).getAttribute('href')).toBe('/audit-log');
  });

  it('an uncomputable disagreement rate says "indicative", never a number', async () => {
    api.getVerifierQuality.mockResolvedValue({ ...SAMPLED, disagreementRate: null });
    renderPage();
    await waitFor(() => expect(screen.getByText(en.disagreementIndicative)).toBeTruthy());
    expect(screen.queryByText(/^Disagreement rate: /)).toBeNull();
  });

  it('nothing sampled says so instead of presenting zero figures', async () => {
    api.getVerifierQuality.mockResolvedValue({ sampled: 0, resolved: 0, agreed: 0, falsePositives: 0, falseNegatives: 0, disagreementRate: null });
    renderPage();
    await waitFor(() => expect(screen.getByText(en.verifierNoSample)).toBeTruthy());
    expect(screen.queryByText('0 / 0')).toBeNull();
  });

  it('a failed read shows the error with Retry, which re-reads and recovers', async () => {
    api.getVerifierQuality.mockRejectedValueOnce(new Error('metrics request failed: 503')).mockResolvedValue(SAMPLED);
    renderPage();
    await waitFor(() => expect(screen.getByText(en.auditMetricsError)).toBeTruthy());
    expect(screen.queryByText(en.verifierNoSample)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.retry }));
    await waitFor(() => expect(screen.getByText('27 / 30')).toBeTruthy());
    expect(screen.queryByText(en.auditMetricsError)).toBeNull();
  });
});
