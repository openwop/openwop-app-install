/**
 * ADR 0036 — agentProfile policy enforcement at the assistant action enqueue
 * seam (`enqueueActionWithApproval`). The acting agent is the assistant-
 * capability holder; the action class is the action `kind`.
 *
 *   - an action kind on the agent's permissions.never is FORBIDDEN: enqueue
 *     fails closed (403) and NOTHING is drafted, enqueued, or made approvable;
 *   - a kind NOT forbidden enqueues normally (always proposes — the path's
 *     existing behavior; execution waits on a human approve).
 *
 * @see docs/adr/0036-agent-profile-policy-enforcement.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore } from '../src/features/assistant/assistantService.js';
import { __resetApprovalStore } from '../src/host/approvalService.js';
import { enqueueActionWithApproval } from '../src/features/assistant/actionApproval.js';
import { ensureAssistantAgent } from '../src/features/assistant/capability.js';
import { upsertAgentProfile, __resetAgentProfileStore } from '../src/host/agentProfileService.js';
import { __resetConnectionsStore } from '../src/features/connections/connectionsService.js';

const PORT = 18977;
let server: { close(cb?: () => void): void };
const TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  server = app.listen(PORT);
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => {
  await __resetAssistantStore();
  await __resetApprovalStore();
  await __resetAgentProfileStore();
  await __resetConnectionsStore();
});

function draft(kind: string) {
  return {
    kind: kind as 'email.send',
    payload: { to: ['dana@example.com'] },
    draft: 'Hi Dana — following up.',
    riskLevel: 'medium' as const,
  };
}

describe('enqueueActionWithApproval — agentProfile policy (ADR 0036)', () => {
  it('forbids an action kind on the acting agent permissions.never (403, nothing drafted)', async () => {
    const agent = await ensureAssistantAgent(TENANT);
    await upsertAgentProfile(TENANT, agent.rosterId, {
      roleKey: agent.roleKey ?? 'chief-of-staff',
      permissions: { read: [], write: [], never: ['email.send'] },
      autonomy: { specLevel: 'recommend' },
    });

    await expect(enqueueActionWithApproval(TENANT, draft('email.send'))).rejects.toMatchObject({ status: 403 });
  });

  it('enqueues normally for a kind NOT on permissions.never', async () => {
    const agent = await ensureAssistantAgent(TENANT);
    await upsertAgentProfile(TENANT, agent.rosterId, {
      roleKey: agent.roleKey ?? 'chief-of-staff',
      permissions: { read: [], write: [], never: ['calendar.reschedule'] },
      autonomy: { specLevel: 'recommend' },
    });

    const action = await enqueueActionWithApproval(TENANT, draft('email.send'));
    expect(action.actionId).toBeTruthy();
    expect(action.approvalId).toBeTruthy();
  });

  it('is ungated when the acting agent has no profile (back-compat: enqueues)', async () => {
    const action = await enqueueActionWithApproval(TENANT, draft('email.send'));
    expect(action.approvalId).toBeTruthy();
  });
});
