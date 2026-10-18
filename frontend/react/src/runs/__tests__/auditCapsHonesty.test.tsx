/**
 * UX_UPGRADE-runs P1 — a failed capability read must not be reported as a host
 * capability.
 *
 * UX-RUN-1: both `RunAuditPage` and `RunOpsPanel` pre-flight
 * `getCapabilities()` and did `.catch(() => setAuditProfile(false))`. The
 * `false` arm is not neutral on these screens — it renders, verbatim:
 *   • RunAuditPage:  "Host does not advertise openwop-audit-log-integrity."
 *   • RunOpsPanel:   "Host does not advertise the … profile; verification unavailable."
 * Both are definitive claims about the HOST, made when we merely failed to ASK
 * it.
 *
 * SCOPE (corrected w49 grade pass): this file drives `RunAuditPage` ONLY. The
 * same fix in `RunOpsPanel` (`RunOpsPanel.tsx`, its `capsFailed` line) has NO
 * behavioural test here or anywhere else — an earlier header implied both were
 * covered. That gap is a tracker row, not something this file asserts. On an audit-integrity surface that is the worst thing to be wrong about:
 * an operator checking whether their audit log is tamper-evident is told their
 * host cannot do it, and may go reconfigure something that was working.
 *
 * This is also peer session openwop-app-3's rule in action — the comment above
 * the effect justifies the explainer with "without the profile the audit.verify
 * endpoint 404s", i.e. it reasons ONLY about a genuine absence. The failed-read
 * path was never contemplated by the comment, but the catch routed into it.
 *
 * `auditProfile` was ALREADY `boolean | null`, so the tri-state existed and the
 * catch threw it away. The fix keeps it null and flags the failure separately.
 *
 * Both arms asserted: a failed read says unknown, and a host that genuinely
 * lacks the profile still gets the real explainer. Absence is asserted only
 * after a signal that renders POST-load (the explainer, the failure notice, or
 * the "Re-verify" button, which mounts only when `auditProfile === true`) —
 * never after the heading, which is on screen before the read settles.
 *
 * What turns it red: the caps catch routed to `setAuditProfile(false)`; the
 * profile check misreading a present profile; Retry that never re-reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const api = vi.hoisted(() => ({ getCapabilities: vi.fn(), pollEvents: vi.fn(), getSdkClient: vi.fn() }));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getCapabilities: api.getCapabilities, pollEvents: api.pollEvents, getSdkClient: api.getSdkClient };
});

import { RunAuditPage } from '../RunAuditPage.js';

const WITH_PROFILE = { auth: { profiles: ['openwop-audit-log-integrity'] } };
const WITHOUT_PROFILE = { auth: { profiles: [] } };

function view(): void {
  render(
    <MemoryRouter initialEntries={['/runs/r1/audit']}>
      <Routes><Route path="/runs/:runId/audit" element={<RunAuditPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.pollEvents.mockResolvedValue({ events: [] });
  api.getSdkClient.mockReturnValue({ audit: { verify: vi.fn() } });
  api.getCapabilities.mockResolvedValue(WITH_PROFILE);
});
afterEach(cleanup);

describe('UX-RUN-1 — a failed capability read never claims the host lacks audit integrity', () => {
  it('FAILURE: says the check failed, and does NOT say the host lacks the profile', async () => {
    api.getCapabilities.mockRejectedValue(new Error('caps_503'));
    view();
    expect(await screen.findByText(/Couldn't check this host's audit-integrity support/i)).toBeTruthy();
    // The false claim must be gone.
    expect(screen.queryByText(/Host does not advertise/i)).toBeNull();
  });

  it('ABSENT: a host that genuinely lacks the profile still gets the real explainer', async () => {
    // The other arm — without it, "always say unknown" would pass the test above
    // while destroying the accurate operator guidance for a real clean install.
    api.getCapabilities.mockResolvedValue(WITHOUT_PROFILE);
    view();
    expect(await screen.findByText(/Host does not advertise/i)).toBeTruthy();
    expect(screen.queryByText(/Couldn't check this host's audit-integrity support/i)).toBeNull();
  });

  it('PRESENT: a host that advertises the profile shows neither message', async () => {
    api.getCapabilities.mockResolvedValue(WITH_PROFILE);
    view();
    // Post-load signal: the verify action bar renders only when the profile read
    // RESOLVED true. The heading is first-paint and would assert while loading.
    await screen.findByRole('button', { name: 'Re-verify' });
    expect(screen.queryByText(/Host does not advertise/i)).toBeNull();
    expect(screen.queryByText(/Couldn't check this host's audit-integrity support/i)).toBeNull();
  });

  it('the failure state offers a retry rather than a dead end', async () => {
    api.getCapabilities.mockRejectedValue(new Error('caps_503'));
    view();
    await screen.findByText(/Couldn't check this host's audit-integrity support/i);
    // The retry must actually RE-ASK the host and recover, not just exist.
    api.getCapabilities.mockResolvedValue(WITH_PROFILE);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByRole('button', { name: 'Re-verify' });
    expect(api.getCapabilities).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByText(/Couldn't check this host's audit-integrity support/i)).toBeNull());
    expect(screen.queryByText(/Host does not advertise/i)).toBeNull();
  });
});
