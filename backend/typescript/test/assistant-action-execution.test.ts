/**
 * ADR 0023 §12 T6 — execute-on-approve:
 *   - the winning claim is the single dispatch site (CAS already T4-tested);
 *   - `nudge` executes internally (it IS a notification) → `sent`;
 *   - provider kinds dispatch the boot-registered `assistant.action.<kind>`
 *     workflow via runStarter AS the approving human; with no Google
 *     connection the Phase-D seam fails closed and the action lands `failed`
 *     — the run, not the assistant, is the single execution record;
 *   - `prepare-action-request` is deterministic (replay-stable request).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore, getPendingAction } from '../src/features/assistant/assistantService.js';
import { enqueueActionWithApproval, decideActionViaApproval } from '../src/features/assistant/actionApproval.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

const TENANT = 'default';

let nodes: (typeof import('../../../packs/feature.assistant.nodes/index.mjs'))['nodes'];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18987, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
  nodes = (await import('../../../packs/feature.assistant.nodes/index.mjs')).nodes;
});

async function waitForStatus(actionId: string, statuses: string[], timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getPendingAction(TENANT, actionId);
    if (row && statuses.includes(row.status)) return row.status;
    if (Date.now() > deadline) return row?.status ?? 'missing';
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('execution workflows (boot-registered)', () => {
  it('registers assistant.action.* schema-clean (Option C: opt-in is run-level) with the send-verdict gate, never a secret', () => {
    for (const wfId of ['assistant.action.email-send', 'assistant.action.calendar-invite', 'assistant.action.calendar-reschedule']) {
      const def = getRegisteredWorkflow(wfId);
      expect(def, wfId).toBeDefined();
      const send = def!.nodes.find((n) => n.nodeId === 'send');
      expect(send?.typeId).toBe('core.openwop.http.fetch');
      // ADR 0024 §4 / Option C — nothing connection-shaped in node config;
      // the opt-in is run-level configurable.connections (asserted below).
      expect(send?.config?.connection).toBeUndefined();
      // The verdict gate: without it a refused send would record as `sent`
      // (fetch completes on any outcome, side-effect-once).
      expect(def!.nodes.find((n) => n.nodeId === 'confirm')?.typeId).toBe('feature.assistant.nodes.confirm-action-send');
      expect(JSON.stringify(def)).not.toMatch(/Bearer |secret|token/i);
    }
  });
});

describe('prepare-action-request (pure, replay-stable)', () => {
  it('maps email.send into a Gmail base64url raw message', async () => {
    const out = await nodes['feature.assistant.nodes.prepare-action-request']!({
      inputs: { action: { kind: 'email.send', payload: { to: ['dana@example.com'], subject: 'Q3' }, draft: 'Numbers attached.' } },
      config: {},
    });
    expect(out.status).toBe('success');
    const raw = (out.outputs as { body: { raw: string } }).body.raw;
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toContain('To: dana@example.com');
    expect(decoded).toContain('Subject: Q3');
    expect(decoded).toContain('Numbers attached.');
  });

  it('strips CRLF from to/subject (header-injection defense) and rejects all-invalid recipients', async () => {
    const out = await nodes['feature.assistant.nodes.prepare-action-request']!({
      inputs: {
        action: {
          kind: 'email.send',
          payload: { to: ['dana@example.com', 'bad recipient', 'evil@x.com\r\nBcc: attacker@evil.example'], subject: 'Q3\r\nBcc: attacker@evil.example' },
          draft: 'Body text.',
        },
      },
      config: {},
    });
    const raw = (out.outputs as { body: { raw: string } }).body.raw;
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    // No LINE in the header section starts a Bcc header — the CRLF payload
    // is flattened into the Subject's DATA, not a new header.
    const headerLines = decoded.split('\r\n\r\n')[0]!.split('\r\n');
    expect(headerLines.some((l) => l.startsWith('Bcc:'))).toBe(false);
    expect(headerLines).toContain('To: dana@example.com');
    expect(headerLines).toContain('Subject: Q3 Bcc: attacker@evil.example'); // flattened, single line

    await expect(
      nodes['feature.assistant.nodes.prepare-action-request']!({
        inputs: { action: { kind: 'email.send', payload: { to: ['\r\nBcc: x@y.z'] }, draft: 'x' } },
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('reschedule without an eventId fails validation', async () => {
    await expect(
      nodes['feature.assistant.nodes.prepare-action-request']!({
        inputs: { action: { kind: 'calendar.reschedule', payload: {}, draft: 'move it' } },
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('execute-on-approve', () => {
  it('an approved nudge delivers internally and lands sent', async () => {
    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'nudge',
      payload: {},
      draft: 'You have not spoken with Alex in 3 weeks.',
    });
    const decided = await decideActionViaApproval(TENANT, action.approvalId!, 'approved', { decidedByUserId: 'u-approver' });
    expect(decided?.changed).toBe(true);
    expect(await waitForStatus(action.actionId, ['sent', 'failed'])).toBe('sent');
    const row = await getPendingAction(TENANT, action.actionId);
    expect(row?.executionRunId).toBeUndefined(); // internal — no run dispatched
  });

  it('an approved email.send dispatches the execution run AS the approver and fails closed without a connection', async () => {
    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: ['dana@example.com'] },
      draft: 'Hi Dana — the Q3 numbers.',
    });
    const decided = await decideActionViaApproval(TENANT, action.approvalId!, 'approved', { decidedByUserId: 'u-approver' });
    expect(decided?.changed).toBe(true);

    const row = await getPendingAction(TENANT, action.actionId);
    expect(row?.executionRunId).toBeTruthy(); // the single execution record

    // The dispatched run carries the Option C run-level credential opt-in.
    const run = await __hostExtStorage()!.getRun(row!.executionRunId!);
    expect((run?.configurable as Record<string, unknown> | undefined)?.connections).toEqual(['google']);
    // No Google connection exists for this tenant/user, so nothing is
    // injected; whatever the unauthenticated call yields (provider 401 or
    // network refusal), the confirm-action-send verdict gate fails the run
    // and the terminal projection marks the action failed — never sent.
    expect(await waitForStatus(action.actionId, ['sent', 'failed'], 15_000)).toBe('failed');
  });

  it('a rejected action never dispatches', async () => {
    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: ['dana@example.com'] },
      draft: 'Should never send.',
    });
    const decided = await decideActionViaApproval(TENANT, action.approvalId!, 'rejected', {});
    expect(decided?.changed).toBe(true);
    const row = await getPendingAction(TENANT, action.actionId);
    expect(row?.status).toBe('rejected');
    expect(row?.executionRunId).toBeUndefined();
  });
});
