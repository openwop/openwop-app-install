/**
 * ADR 0905 P3 — exercise notice rendering through the actual tenant SMTP broker,
 * recipient guard and sent ledger. Only the final socket transport is replaced.
 * This calls the delivery helper; emitter notification filtering is a separate seam.
 * A render-only golden cannot detect a lost voter binding, wrong connection scope,
 * a duplicated delivery or a notice sent to an erased/held recipient.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmtpDialOptions, SmtpMessage } from '../src/host/smtpSend.js';
import type { Storage } from '../src/storage/storage.js';
import { createApp } from '../src/index.js';
import { createSecretConnection, __resetConnectionsStore } from '../src/features/connections/connectionsService.js';
import { createMember, deleteMember } from '../src/host/accessControlService.js';
import { deliverApprovalEmail, setEmailApprovalPref } from '../src/host/emailApprovalDelivery.js';
import { verifyVoterBinding } from '../src/host/interruptVoterBinding.js';
import { priorSend } from '../src/host/emailSentLedger.js';
import { registerEmailEgressGuard } from '../src/features/email/egressGuard.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';
import { deleteSubject } from '../src/features/consent/consentService.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const capture = vi.hoisted(() => ({
  options: [] as SmtpDialOptions[],
  messages: [] as SmtpMessage[],
}));
vi.mock('nodemailer', () => ({ default: {
  createTransport(options: SmtpDialOptions) {
    capture.options.push(options);
    return { async sendMail(message: SmtpMessage) {
      capture.messages.push(message);
      return { messageId: `notice-${capture.messages.length}` };
    } };
  },
} }));

describe('approval notice delivery through tenant SMTP', () => {
  const tenantId = 'approval-notice-delivery';
  const envKeys = ['OPENWOP_STORAGE_DSN', 'OPENWOP_WEBHOOK_ALLOW_PRIVATE', 'OPENWOP_PUBLIC_BASE_URL', 'OPENWOP_NOTIFY_EMAIL_FROM'] as const;
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let storage: Storage;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://notices.example';
    process.env.OPENWOP_NOTIFY_EMAIL_FROM = 'reviews@notices.example';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    registerEmailEgressGuard();
    const privateSecret = JSON.stringify({ host: '127.0.0.1', port: 587, secure: false, user: 'must-not-select-private-smtp', pass: 'test-only' });
    await createSecretConnection({ tenantId, provider: 'smtp', kind: 'basic', scope: 'user', userId: 'eligible', secret: privateSecret });
    await createSecretConnection({ tenantId, provider: 'smtp', kind: 'basic', scope: 'org', orgId: tenantId, secret: privateSecret });
    await createSecretConnection({ tenantId, provider: 'smtp', kind: 'basic', scope: 'workspace', secret: JSON.stringify({ host: '127.0.0.1', port: 587, secure: false, user: 'tenant-smtp-user', pass: 'test-only' }) });
    // A surviving member makes offboarding observable; memberless demo semantics
    // must not accidentally be the positive control for membership revocation.
    await createMember({ tenantId, orgId: tenantId, subject: 'sentinel', displayName: 'Remaining member' });
  });
  afterAll(() => {
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
  });
  beforeEach(() => { capture.options.length = 0; capture.messages.length = 0; });

  async function recipient(id: string, enabled = true): Promise<string> {
    await createMember({ tenantId, orgId: tenantId, subject: id, displayName: id });
    await setEmailApprovalPref({ tenantId, userId: id, email: `${id}@notices.example`, enabled });
    return id;
  }
  const input = (recipientUserId: string, notificationId: string, interruptToken?: string) => ({
    tenantId, recipientUserId, notificationId, title: 'Approve the release', message: 'A release is waiting.',
    ...(interruptToken ? { interruptToken } : {}),
  });
  const links = (message: SmtpMessage): URL[] => [...(message.text ?? '').matchAll(/https:\/\/[^\s]+/g)].map(([url]) => new URL(url));

  it('sends the addressed notice with valid recipient-bound decide links and deduplicates a replay', async () => {
    const userId = await recipient('eligible');
    const request = input(userId, 'eligible-notice', 'capability/with?characters');
    await deliverApprovalEmail(storage, request);
    expect(capture.options).toHaveLength(1);
    expect(capture.options[0]).toMatchObject({ host: '127.0.0.1', port: 587, requireTLS: true, auth: { user: 'tenant-smtp-user' } });
    expect(capture.messages).toHaveLength(1);
    expect(capture.messages[0]).toMatchObject({ from: 'reviews@notices.example', to: 'eligible@notices.example', subject: 'Approve the release' });
    expect(capture.messages[0]?.text).toContain('A release is waiting.');
    const decide = links(capture.messages[0]!).filter((url) => url.pathname.endsWith('/interrupt-action'));
    expect(decide).toHaveLength(2);
    expect(decide.map((url) => url.searchParams.get('action')).sort()).toEqual(['approve', 'reject']);
    for (const url of decide) {
      expect(url.origin).toBe('https://notices.example');
      const token = url.searchParams.get('token')!;
      const voter = url.searchParams.get('voter')!;
      const signature = url.searchParams.get('sig')!;
      expect(token).toBe(request.interruptToken);
      expect(voter).toBe(userId);
      expect(verifyVoterBinding(token, voter, signature)).toBe(true);
      expect(verifyVoterBinding(token, 'other-member', signature)).toBe(false);
      expect(verifyVoterBinding('other-token', voter, signature)).toBe(false);
    }
    expect(await priorSend(`${tenantId}:notify-email:eligible-notice:${userId}`)).toMatchObject({ messageId: 'notice-1', provider: 'smtp' });
    await deliverApprovalEmail(storage, request);
    expect(capture.options).toHaveLength(1);
    expect(capture.messages).toHaveLength(1);
  });

  it('offboarded recipients receive only an authenticated inbox link, with no capability token', async () => {
    const userId = await recipient('offboarded');
    const member = await createMember({ tenantId, orgId: tenantId, subject: userId, displayName: userId });
    await deleteMember(member.memberId);
    await deliverApprovalEmail(storage, input(userId, 'offboarded-notice', 'never-expose-this-token'));
    expect(capture.messages).toHaveLength(1);
    expect(links(capture.messages[0]!)).toEqual([new URL('https://notices.example/inbox')]);
    expect(capture.messages[0]?.text).not.toContain('never-expose-this-token');
  });

  it('approval-store notices are link-out only even for a current opted-in member', async () => {
    const userId = await recipient('reviewer');
    await deliverApprovalEmail(storage, input(userId, 'review-notice'));
    expect(capture.messages).toHaveLength(1);
    expect(links(capture.messages[0]!)).toEqual([new URL('https://notices.example/inbox')]);
  });

  it('disabled, erased and hard-held recipients never reach SMTP or reserve a send', async () => {
    const disabled = await recipient('disabled', false);
    const erased = await recipient('erased');
    const held = await recipient('held');
    await deleteSubject(tenantId, 'erased@notices.example');
    await addSuppression(tenantId, 'held@notices.example', 'complaint', 'test', 'provider');
    for (const userId of [disabled, erased, held]) {
      await deliverApprovalEmail(storage, input(userId, `refused-${userId}`, 'refused-capability'));
      expect(await priorSend(`${tenantId}:notify-email:refused-${userId}:${userId}`)).toBeNull();
    }
    expect(capture.options).toHaveLength(0);
    expect(capture.messages).toHaveLength(0);
  });

  it('a workspace whose only email account is Postmark still gets the notice (ADR 0994 D1)', async () => {
    // It was hard-wired to `smtp`, so this workspace got nothing.
    const pmTenant = 'approval-notice-postmark';
    const calls: Array<Record<string, unknown>> = [];
    const pm = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push(JSON.parse(raw || '{}') as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ MessageID: 'pm-notice-1', ErrorCode: 0, Message: 'OK' }));
      });
    });
    await new Promise<void>((r) => pm.listen(0, '127.0.0.1', r));
    const savedBase = process.env.OPENWOP_POSTMARK_API_BASE;
    process.env.OPENWOP_POSTMARK_API_BASE = `http://127.0.0.1:${(pm.address() as AddressInfo).port}`;
    try {
      await createSecretConnection({ tenantId: pmTenant, provider: 'postmark', kind: 'api_key', scope: 'workspace', secret: 'PM-NOTICE' });
      await createMember({ tenantId: pmTenant, orgId: pmTenant, subject: 'pm-user', displayName: 'pm-user' });
      await setEmailApprovalPref({ tenantId: pmTenant, userId: 'pm-user', email: 'pm-user@notices.example', enabled: true });
      await deliverApprovalEmail(storage, { tenantId: pmTenant, recipientUserId: 'pm-user', notificationId: 'pm-notice', title: 'Approve', message: 'Waiting.' });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ To: 'pm-user@notices.example', MessageStream: 'outbound' });
      expect(capture.messages).toHaveLength(0); // never the SMTP lane
    } finally {
      if (savedBase === undefined) delete process.env.OPENWOP_POSTMARK_API_BASE; else process.env.OPENWOP_POSTMARK_API_BASE = savedBase;
      await new Promise<void>((r) => pm.close(() => r()));
    }
  });
});
