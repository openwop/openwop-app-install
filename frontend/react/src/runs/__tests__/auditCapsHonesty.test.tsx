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
 * it. On an audit-integrity surface that is the worst thing to be wrong about:
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
 * lacks the profile still gets the real explainer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
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
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/Host does not advertise/i)).toBeNull();
    expect(screen.queryByText(/Couldn't check this host's audit-integrity support/i)).toBeNull();
  });

  it('the failure state offers a retry rather than a dead end', async () => {
    api.getCapabilities.mockRejectedValue(new Error('caps_503'));
    view();
    await screen.findByText(/Couldn't check this host's audit-integrity support/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
