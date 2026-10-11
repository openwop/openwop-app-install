/**
 * An approved provider action checks the approver's Google credential BEFORE it
 * dispatches, and a refusal tells the approver how to fix it.
 *
 * The defect (prod run 8ed3c3e7, 2026-10-09): the approver's Google connection
 * held read scopes only. `actionExecution.ts`'s header said the send "fails
 * closed when write re-consent was never granted", and nothing checked: the
 * read-only token went to Gmail, Gmail answered 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT,
 * and the approver was told "Something went wrong. Check the server logs."
 *
 * Each case asserts the action is `failed` with NO execution run (nothing left
 * the host) and that the addressed receipt carries numbered steps naming the UI
 * controls the user must press. The send-capable case is the negative control: a
 * check that refused everything would pass the first three.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore, getPendingAction } from '../src/features/assistant/assistantService.js';
import { enqueueActionWithApproval, decideActionViaApproval, contentHashOf } from '../src/features/assistant/actionApproval.js';
import { credentialFixSteps, runFailureReason } from '../src/features/assistant/actionExecution.js';
import { upsertOAuthConnection, __setConnectionStatusForTests } from '../src/features/connections/connectionsService.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import type { NotificationRecord } from '../src/types.js';

const TENANT = 'default';
const READ_ONLY = ['https://www.googleapis.com/auth/gmail.readonly'];
const SEND = ['https://www.googleapis.com/auth/gmail.send'];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18993, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
});

async function connect(userId: string, scopes: string[]) {
  return upsertOAuthConnection({
    tenantId: TENANT, provider: 'google', userId,
    tokens: { accessToken: 'at-fake', refreshToken: 'rt-fake', scopes, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as never,
  });
}

async function approveSend(approver: string) {
  const action = await enqueueActionWithApproval(TENANT, { kind: 'email.send', payload: { to: ['dana@example.com'] }, draft: 'Hi Dana.' });
  const decided = await decideActionViaApproval(TENANT, action.approvalId!, 'approved', { expectedContentHash: contentHashOf(action), decidedByUserId: approver });
  expect(decided?.changed).toBe(true);
  return action;
}

async function receiptsFor(approver: string, actionId: string): Promise<NotificationRecord[]> {
  const rows = await __hostExtStorage()!.listNotifications({ tenantId: TENANT, limit: 200 });
  return rows.filter((n) => n.recipientUserId === approver && (n.metadata as { actionId?: string } | undefined)?.actionId === actionId);
}

async function expectRefusedBeforeDispatch(approver: string, actionId: string): Promise<NotificationRecord> {
  const row = await getPendingAction(TENANT, actionId);
  expect(row?.status).toBe('failed');
  expect(row?.executionRunId, 'a refused credential must not start a run').toBeUndefined();
  const receipts = await receiptsFor(approver, actionId);
  expect(receipts).toHaveLength(1);
  const r = receipts[0]!;
  // No run exists, and the type's action label is "View run": no link at all.
  expect(r.actionUrl).toBeUndefined();
  expect(r.message).toContain('/profile?tab=connections');
  expect(r.message).toMatch(/1\) .*2\) .*3\) /);
  return r;
}

describe('approved email.send — credential checked before dispatch', () => {
  it('no Google connection: refused, and the steps say to connect Google Workspace', async () => {
    const action = await approveSend('u-none');
    const r = await expectRefusedBeforeDispatch('u-none', action.actionId);
    expect(r.message).toContain('Connect Google Workspace');
    expect(r.message).toContain('Send email on your behalf');
  });

  it('read-only Google connection (the prod case): refused, and the steps say to grant write access', async () => {
    await connect('u-readonly', READ_ONLY);
    const action = await approveSend('u-readonly');
    const r = await expectRefusedBeforeDispatch('u-readonly', action.actionId);
    expect(r.message).toContain('not allowed to send email');
    expect(r.message).toContain('Grant write access');
    expect(r.message).toContain('Send email on your behalf');
  });

  it('expired Google connection: refused, and the steps say to reconnect', async () => {
    const c = await connect('u-expired', SEND);
    await __setConnectionStatusForTests(c.connectionId, 'needs-reconsent');
    const action = await approveSend('u-expired');
    const r = await expectRefusedBeforeDispatch('u-expired', action.actionId);
    expect(r.message).toContain('has expired');
    expect(r.message).toContain('Reconnect');
  });

  it('send-capable connection: the run IS dispatched (negative control)', async () => {
    await connect('u-send', SEND);
    const action = await approveSend('u-send');
    const row = await getPendingAction(TENANT, action.actionId);
    expect(row?.executionRunId, 'a send-capable credential must dispatch').toBeTruthy();
    // The fake token is refused downstream; the run, not the check, decides.
    await vi.waitFor(async () => expect((await getPendingAction(TENANT, action.actionId))?.status).toBe('failed'), { timeout: 10_000, interval: 50 }).catch(() => undefined);
  }, 30_000);
});

describe('a dispatched send the provider refuses gets the same steps', () => {
  it('HTTP 403 → grant-write steps; 401 → reconnect steps; anything else stays bare', () => {
    const fail = (message: string) => ({ status: 'failed', error: { code: 'send_failed', message } });
    expect(runFailureReason('email.send', fail('provider send failed (HTTP 403)'))).toContain('Grant write access');
    expect(runFailureReason('email.send', fail('provider send failed (HTTP 401)'))).toContain('Reconnect');
    expect(runFailureReason('email.send', fail('provider send failed (HTTP 500)'))).toBe('the send run ended `failed`');
    expect(runFailureReason('email.send', null)).toBe('the send run did not complete');
  });

  it('calendar kinds name the calendar permission, not the Gmail one', () => {
    const steps = credentialFixSteps('calendar.invite', 'insufficient_scope');
    expect(steps).toContain('change your calendar');
    expect(steps).toContain('View and edit events on all your calendars');
    expect(steps).not.toContain('Send email');
  });
});
