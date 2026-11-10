/**
 * ADR 1014 P4b — RFC 0254 §D: a transition an approval gate holds answers `202`
 * with the record UNCHANGED apart from `transitionRunId`. `transitionDeployment`
 * reports `pending` for exactly that and nothing else.
 *
 * Red when: an applied transition reads as pending, or a held one as applied
 * (including a held record the server sends back with its keys in another order,
 * since JSON objects are unordered).
 *
 * Sabotage-witnessed (w83): `sameExceptRun` always false or always true; compare
 * without stripping `transitionRunId`; compare without sorting keys; send the
 * body without `version`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn<(path: string, opts?: unknown) => Promise<DeploymentRecord>>() }));
vi.mock('../requestJson.js', async (orig) => ({ ...(await orig<typeof import('../requestJson.js')>()), requestJson }));

import { transitionDeployment } from '../agentDeploymentsClient.js';
import type { DeploymentRecord } from '../agentDeploymentsClient.js';

const prior: DeploymentRecord = { agentId: 'a', version: '1.1.0', state: 'staged', transitionRunId: 'old-run' };
afterEach(() => vi.resetAllMocks());

describe('transitionDeployment', () => {
  it('pending when only transitionRunId changed (the 202 shape)', async () => {
    // The 202 body: unchanged apart from the run id, and in another key order.
    requestJson.mockResolvedValue({ transitionRunId: 'new-run', state: 'staged', version: '1.1.0', agentId: 'a' });
    expect((await transitionDeployment('a', prior, { transition: 'promote', toState: 'active' })).pending).toBe(true);
    expect(requestJson).toHaveBeenCalledWith('/agents/a/deployments', { method: 'POST', json: { version: '1.1.0', transition: 'promote', toState: 'active' } });
  });

  it('applied when the record changed', async () => {
    requestJson.mockResolvedValue({ agentId: 'a', version: '1.1.0', state: 'active', channels: ['stable'], transitionRunId: 'new-run' });
    expect((await transitionDeployment('a', prior, { transition: 'promote', toState: 'active' })).pending).toBe(false);
    expect(requestJson).toHaveBeenCalledWith('/agents/a/deployments', { method: 'POST', json: { version: '1.1.0', transition: 'promote', toState: 'active' } });
  });
});
