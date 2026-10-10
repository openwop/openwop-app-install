/**
 * ANL-UX-19 / ADR 0857 — a plan refusal on an analytics read re-resolves
 * entitlements through the shared seam (the `requestJson` UI-ENT-1b behaviour),
 * so the route guard shows the locked panel instead of a Retry that fails forever.
 *
 * Sabotage witnesses (grade-tests wave 8): deleting `noteRequestStatus(res.status)`
 * in `asJson`, or skipping its `!res.ok` throw, reds the case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const noteRequestStatus = vi.fn<(status: number) => void>();
vi.mock('../../../client/entitlementRefresh.js', () => ({ noteRequestStatus: (s: number) => noteRequestStatus(s) }));

const { getSummary } = await import('../analyticsClient.js');

afterEach(() => { vi.unstubAllGlobals(); noteRequestStatus.mockClear(); });

describe('ANL-UX-19 — plan refusals reach the entitlement seam', () => {
  it('a 403 on the summary read is reported to the seam (and still throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'not entitled' }), { status: 403 })));
    await expect(getSummary('org:1')).rejects.toThrow();
    expect(noteRequestStatus).toHaveBeenCalledWith(403);
  });
});
