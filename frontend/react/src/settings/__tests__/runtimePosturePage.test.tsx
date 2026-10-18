/**
 * ADR 0742 — the runtime posture page shows only what the backend read back from
 * Cloud Run. A failed or unavailable read offers no change request (there is no
 * posture to change FROM), and a configuration change whose revision is at 0 %
 * traffic renders as NOT live, never as the new posture.
 *
 * Sabotage that turns it red: fetch before the access state resolves; treat 401 as a
 * failed read; render the settled notice for a not-live rollout; swap the posture names;
 * retitle the failed-read card; a 401/403 rendered as anything but the authority card.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { EffectiveAccess } from '../../client/accessClient.js';
import type { RuntimePosture } from '../../client/runtimePostureClient.js';

type RpClient = typeof import('../../client/runtimePostureClient.js');
type AccessHooks = typeof import('../../client/useEffectiveAccess.js');
const { getRuntimePosture, requestPostureChange, useEffectiveAccessState } = vi.hoisted(() => ({
  getRuntimePosture: vi.fn<RpClient['getRuntimePosture']>(),
  requestPostureChange: vi.fn<RpClient['requestPostureChange']>(),
  useEffectiveAccessState: vi.fn<AccessHooks['useEffectiveAccessState']>(),
}));
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<AccessHooks>()),
  useEffectiveAccessState,
}));
vi.mock('../../client/runtimePostureClient.js', async (orig) => ({
  ...(await orig<RpClient>()),
  getRuntimePosture, requestPostureChange,
}));

import { RuntimePosturePage } from '../RuntimePosturePage.js';
import { RuntimePostureRequestError } from '../../client/runtimePostureClient.js';

const SUPERADMIN: EffectiveAccess = { roles: [], scopes: [], basis: 'tenant-owner', superadmin: true };
const PINNED: RuntimePosture = {
  available: true,
  service: 'svc', project: 'p', region: 'us-central1',
  servingRevision: 'rev-1',
  serving: { minInstances: 0, cpuThrottled: true, posture: 'cold', cpu: 2, memoryGiB: 1 },
  pendingRevision: 'rev-2',
  rollout: 'not-live',
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
  vi.resetAllMocks();
  useEffectiveAccessState.mockReturnValue({ access: SUPERADMIN, resolved: true });
});

describe('runtime posture page', () => {
  it('a failed read offers a retry and NO change request', async () => {
    getRuntimePosture.mockRejectedValueOnce(new Error('503'));
    await mount();
    expect(screen.getByText('Couldn’t load the runtime posture')).toBeTruthy();
    expect(requestButtons()).toEqual([]);
    expect(requestPostureChange).not.toHaveBeenCalled();
    // The retry is real: it re-reads, and a good read then offers the requests.
    getRuntimePosture.mockResolvedValueOnce(PINNED);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(getRuntimePosture).toHaveBeenCalledTimes(2);
    expect(requestButtons().length).toBe(2);
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
    expect(screen.getByText('A configuration change is NOT live: revision rev-2 exists but serves 0% of traffic. rev-1 is still serving. Shift traffic to rev-2 by name.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Live: revision');
    // The serving revision's posture is what is shown as current — cold, not the pending warm.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Current posture: Cold');
    expect(requestButtons().length).toBe(2);
  });
});

describe('ADR 0742 defect 1 — the pre-auth window (measured on rev 00737-vkq)', () => {
  it('does NOT read the posture until the access state resolves', async () => {
    useEffectiveAccessState.mockReturnValue({ access: { roles: [], scopes: [], basis: 'none' }, resolved: false });
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
      expect(screen.getByText('Superadmin access required'), `status ${status}`).toBeTruthy();
      expect(requestButtons(), `status ${status}`).toEqual([]);
    }
  });

  it('a non-authority failure still reads as a failed read', async () => {
    getRuntimePosture.mockRejectedValue(new RuntimePostureRequestError('boom', 503));
    await mount();
    expect(document.body.textContent ?? '').toContain('failed read');
  });
});
