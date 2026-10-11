/**
 * ADR 0862 D1 — the POST-CAS integrity check, witnessed deterministically.
 *
 * D1 added an early, non-consuming refusal of an already-stale card BEFORE the approval
 * CAS. That early check makes the definitive post-CAS check unreachable from any sequential
 * HTTP test: by the time a test can edit, the early check catches it. The window it guards
 * is the one between the early read and the CAS (ADR 0473 F2/F3), so this file opens that
 * window on purpose: a partial mock of `resolveApproval` lands a peer edit immediately
 * before the real CAS runs. Without the post-CAS check, the approval would dispatch bytes
 * the approver never saw; with it, both rows return to `pending` and nothing executes.
 *
 * Sabotages that turn it red (grade-tests w11): the post-CAS hash check disabled; the
 * approval-side reopen dropped; the action-side reopen leaving the row `approved`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const hook: { beforeCas: null | (() => Promise<void>) } = { beforeCas: null };

vi.mock('../src/host/approvalService.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/host/approvalService.js')>();
  return {
    ...orig,
    resolveApproval: async (...args: Parameters<typeof orig.resolveApproval>) => {
      const fn = hook.beforeCas;
      hook.beforeCas = null;
      if (fn) await fn();
      return orig.resolveApproval(...args);
    },
  };
});

import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore, editPendingAction, getPendingAction } from '../src/features/assistant/assistantService.js';
import { contentHashOf, decideActionViaApproval, enqueueActionWithApproval } from '../src/features/assistant/actionApproval.js';
import { getApproval } from '../src/host/approvalService.js';

const TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18997, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
});

describe('ADR 0862 D1 — an edit inside the early-check→CAS window', () => {
  it('is caught AFTER the CAS: 409 action_changed, both rows pending, nothing executed', async () => {
    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: ['dana@example.com'], subject: 'Q3' },
      draft: 'Hi Dana — the Q3 numbers.',
    });
    const seen = contentHashOf(action);
    hook.beforeCas = async () => {
      const r = await editPendingAction(TENANT, action.actionId, { payload: { to: ['someone-else@example.com'], subject: 'Q3' } }, () => true);
      expect(r.ok).toBe(true);
    };

    await expect(decideActionViaApproval(TENANT, action.approvalId!, 'approved', { decidedByUserId: 'u-a', expectedContentHash: seen }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'action_changed' } });

    expect(hook.beforeCas, 'the window must actually have been opened').toBeNull();
    const row = await getPendingAction(TENANT, action.actionId);
    expect(row?.status).toBe('pending');
    expect(row?.executionRunId).toBeUndefined();
    expect((await getApproval(action.approvalId!))?.status).toBe('pending');
  });
});
