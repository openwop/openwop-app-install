/**
 * ADR 1014 P4b — RFC 0254 §D: a transition an approval gate holds answers `202`
 * with the record UNCHANGED apart from `transitionRunId`. `transitionDeployment`
 * reports `pending` for exactly that and nothing else.
 *
 * Red when: an applied transition reads as pending, or a held one as applied.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn() }));
vi.mock('../requestJson.js', async (orig) => ({ ...(await orig<typeof import('../requestJson.js')>()), requestJson }));

import { transitionDeployment, type DeploymentRecord } from '../agentDeploymentsClient.js';

const prior: DeploymentRecord = { agentId: 'a', version: '1.1.0', state: 'staged', transitionRunId: 'old-run' };
afterEach(() => vi.clearAllMocks());

describe('transitionDeployment', () => {
  it('pending when only transitionRunId changed (the 202 shape)', async () => {
    requestJson.mockResolvedValue({ agentId: 'a', version: '1.1.0', state: 'staged', transitionRunId: 'new-run' });
    expect((await transitionDeployment('a', prior, { transition: 'promote', toState: 'active' })).pending).toBe(true);
    expect(requestJson).toHaveBeenCalledWith('/agents/a/deployments', { method: 'POST', json: { version: '1.1.0', transition: 'promote', toState: 'active' } });
  });

  it('applied when the record changed', async () => {
    requestJson.mockResolvedValue({ agentId: 'a', version: '1.1.0', state: 'active', channels: ['stable'], transitionRunId: 'new-run' });
    expect((await transitionDeployment('a', prior, { transition: 'promote', toState: 'active' })).pending).toBe(false);
  });
});
