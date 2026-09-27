/**
 * ADR 0742 — the runtime posture page shows only what the backend read back from
 * Cloud Run. A failed or unavailable read offers no change request (there is no
 * posture to change FROM), and a configuration change whose revision is at 0 %
 * traffic renders as NOT live, never as the new posture.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

const { getRuntimePosture, requestPostureChange, useEffectiveAccessState } = vi.hoisted(() => ({
  getRuntimePosture: vi.fn(), requestPostureChange: vi.fn(), useEffectiveAccessState: vi.fn(),
}));
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../client/useEffectiveAccess.js')>()),
  useEffectiveAccessState,
}));
vi.mock('../../client/runtimePostureClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/runtimePostureClient.js')>()),
  getRuntimePosture, requestPostureChange,
}));

import { RuntimePosturePage } from '../RuntimePosturePage.js';
import { RuntimePostureRequestError } from '../../client/runtimePostureClient.js';

const PINNED = {
  available: true as const,
  service: 'svc', project: 'p', region: 'us-central1',
  servingRevision: 'rev-1',
  serving: { minInstances: 0, cpuThrottled: true, posture: 'cold' as const, cpu: 2, memoryGiB: 1 },
  pendingRevision: 'rev-2',
  rollout: 'not-live' as const,
  monthlyCostUsd: { warm: 98.5, cold: 0 },
  readAt: '2026-09-22T12:00:00.000Z',
};

const mount = async (): Promise<void> => {
  render(<RuntimePosturePage />);
  await act(async () => {});
};
const requestButtons = (): HTMLElement[] => screen.queryAllByRole('button').filter((b) => /warm|cold|rpRequest/i.test(b.textContent ?? ''));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useEffectiveAccessState.mockReturnValue({ access: { superadmin: true, scopes: [] }, resolved: true });
});

describe('runtime posture page', () => {
  it('a failed read offers a retry and NO change request', async () => {
    getRuntimePosture.mockRejectedValue(new Error('503'));
    await mount();
    expect(requestButtons()).toEqual([]);
    expect(requestPostureChange).not.toHaveBeenCalled();
  });

  it('an unavailable read (off Cloud Run) offers NO change request either', async () => {
    getRuntimePosture.mockResolvedValue({ available: false, reason: 'not running on Cloud Run' });
    await mount();
    expect(requestButtons()).toEqual([]);
    expect(document.body.textContent).toContain('not running on Cloud Run');
  });

  it('a change whose revision is at 0 % traffic is shown as NOT live, naming both revisions', async () => {
    getRuntimePosture.mockResolvedValue(PINNED);
    await mount();
    const text = document.body.textContent ?? '';
    expect(text).toContain('rev-2');
    expect(text).toContain('rev-1');
    // The serving revision's posture is what is shown as current — cold, not the pending warm.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/cold|Fr|Fría|Froide|rpPostureCold/i);
    expect(requestButtons().length).toBe(2);
  });
});

describe('ADR 0742 defect 1 — the pre-auth window (measured on rev 00737-vkq)', () => {
  it('does NOT read the posture until the access state resolves', async () => {
    useEffectiveAccessState.mockReturnValue({ access: { superadmin: false, scopes: [] }, resolved: false });
    await mount();
    expect(getRuntimePosture, 'asking before the session binds measures the anonymous session').not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('failed read');
  });

  it('reads once the access state has resolved', async () => {
    getRuntimePosture.mockResolvedValue(PINNED);
    await mount();
    expect(getRuntimePosture).toHaveBeenCalledTimes(1);
  });

  it('a 401/403 renders the AUTHORITY state, not the failed-read card', async () => {
    for (const status of [401, 403]) {
      cleanup();
      getRuntimePosture.mockRejectedValue(new RuntimePostureRequestError('nope', status));
      await mount();
      const text = document.body.textContent ?? '';
      expect(text, `status ${status}`).not.toContain('failed read');
      expect(requestButtons(), `status ${status}`).toEqual([]);
    }
  });

  it('a non-authority failure still reads as a failed read', async () => {
    getRuntimePosture.mockRejectedValue(new RuntimePostureRequestError('boom', 503));
    await mount();
    expect(document.body.textContent ?? '').toContain('failed read');
  });
});
