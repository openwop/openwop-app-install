/**
 * ADR 0994 — transactional email prefers Postmark, campaigns prefer SES (over SMTP),
 * Postmark campaign mail rides the Broadcast stream, and SES bounces/complaints
 * arrive as SNS-signed notifications pinned to the operator's topic.
 *
 * The SNS signature in these tests is built from AWS's documented canonical form
 * written out HERE, not from `snsStringToSign`, so a wrong canonical string in the
 * module cannot agree with itself.
 *
 * Sabotage-witnessed: dropping the TopicArn pin, the timestamp window or the
 * `sns.<region>.amazonaws.com` host check; confirming a subscription before
 * verification; classifying a Transient bounce as hard; reverting the Postmark
 * stream to a constant 'outbound'; reverting the purpose preference; and reverting
 * the body parser's `text/plain` type each turn a case red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  setWebhookConfig, ingestBounceWebhook, parseSesEvent, __resetBounceWebhookStore, __setSnsTransportForTest,
} from '../src/features/email/bounceWebhooks.js';
import { verifySnsMessage, isSnsUrl, __clearSnsCertCache } from '../src/features/email/snsVerify.js';
import { isSuppressed, __clearSuppressions } from '../src/features/crm/suppressionService.js';
import { emailSendProviders, resolveEmailProvider, __providerBodyForTest } from '../src/host/emailAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  __setSnsTransportForTest(null);
  await new Promise<void>((res) => server.close(() => res()));
});

// A non-signed-in tenant so byok setSecret uses the local path (no KMS in tests).
const T = 'ses-tenant';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:ses-bounces';
const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

let confirmed: string[] = [];
let certFetches = 0;
beforeEach(async () => {
  await __resetBounceWebhookStore();
  await __clearSuppressions();
  __clearSnsCertCache();
  confirmed = [];
  certFetches = 0;
  __setSnsTransportForTest({
    fetchCert: async (url) => { certFetches += 1; if (url !== CERT_URL) throw new Error('unexpected cert url'); return PEM; },
    confirm: async (url) => { confirmed.push(url); },
  });
});

/** AWS's documented canonical form, written independently of the module. */
function canonical(m: Record<string, string>): string {
  const keys = m.Type === 'Notification'
    ? ['Message', 'MessageId', ...('Subject' in m ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${m[k]}\n`).join('');
}
function signed(fields: Record<string, string>, opts: { version?: '1' | '2'; topic?: string; at?: Date; certUrl?: string } = {}): Record<string, string> {
  const m: Record<string, string> = {
    MessageId: `msg-${Math.random().toString(36).slice(2)}`,
    TopicArn: opts.topic ?? TOPIC,
    Timestamp: (opts.at ?? new Date()).toISOString(),
    SignatureVersion: opts.version ?? '1',
    SigningCertURL: opts.certUrl ?? CERT_URL,
    ...fields,
  };
  const s = createSign(m.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
  s.update(canonical(m), 'utf8');
  return { ...m, Signature: s.sign(privateKey, 'base64') };
}
const notification = (event: unknown, opts?: Parameters<typeof signed>[1]) =>
  signed({ Type: 'Notification', Message: JSON.stringify(event) }, opts);
const bounce = (email: string, bounceType: string) => ({
  notificationType: 'Bounce', bounce: { bounceType, bounceSubType: 'General', bouncedRecipients: [{ emailAddress: email }] },
});

async function sesConfig(): Promise<string> {
  const cfg = await setWebhookConfig({ tenantId: T, orgId: T, provider: 'ses', verificationSecret: TOPIC });
  return cfg.webhookId;
}
const ingest = (webhookId: string, body: unknown) =>
  ingestBounceWebhook({ webhookId, rawBody: JSON.stringify(body), body, headers: {}, now: Date.now() });

describe('ADR 0994 D4 — SNS verification', () => {
  it('accepts a correctly signed notification, SignatureVersion 1 and 2', async () => {
    for (const version of ['1', '2'] as const) {
      __clearSnsCertCache();
      const v = await verifySnsMessage({ body: notification(bounce('a@ex.com', 'Permanent'), { version }), expectedTopicArn: TOPIC, now: Date.now(), fetchCert: async () => PEM });
      expect(v.ok, version).toBe(true);
    }
  });

  it('refuses a message for another topic, a stale one, and a tampered one', async () => {
    const fetchCert = async () => PEM;
    expect(await verifySnsMessage({ body: notification({}, { topic: 'arn:aws:sns:us-east-1:999:other' }), expectedTopicArn: TOPIC, now: Date.now(), fetchCert })).toEqual({ ok: false, reason: 'wrong_topic' });
    expect(await verifySnsMessage({ body: notification({}, { at: new Date(Date.now() - 2 * 3600_000) }), expectedTopicArn: TOPIC, now: Date.now(), fetchCert })).toEqual({ ok: false, reason: 'stale' });
    const tampered = { ...notification(bounce('a@ex.com', 'Transient')), Message: JSON.stringify(bounce('victim@ex.com', 'Permanent')) };
    expect(await verifySnsMessage({ body: tampered, expectedTopicArn: TOPIC, now: Date.now(), fetchCert })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('only trusts certificates and subscribe URLs on sns.<region>.amazonaws.com over https', () => {
    expect(isSnsUrl(CERT_URL, { pem: true })).toBe(true);
    for (const bad of [
      'http://sns.us-east-1.amazonaws.com/x.pem',
      'https://sns.us-east-1.amazonaws.com.evil.example/x.pem',
      'https://evil.example/sns.us-east-1.amazonaws.com/x.pem',
      'https://user@sns.us-east-1.amazonaws.com/x.pem',
      'https://sns.us-east-1.amazonaws.com:8443/x.pem',
      'https://sns.us-east-1.amazonaws.com/x.txt',
    ]) expect(isSnsUrl(bad, { pem: true }), bad).toBe(false);
  });

  it('never fetches a certificate from a non-SNS URL', async () => {
    const v = await verifySnsMessage({ body: notification({}, { certUrl: 'https://evil.example/cert.pem' }), expectedTopicArn: TOPIC, now: Date.now(), fetchCert: async () => { certFetches += 1; return PEM; } });
    expect(v).toEqual({ ok: false, reason: 'bad_cert_url' });
    expect(certFetches).toBe(0);
  });
});

describe('ADR 0994 D4 — SES events', () => {
  it('classifies Permanent and complaints as suppressions; Transient is not', () => {
    expect(parseSesEvent(bounce('hard@ex.com', 'Permanent'))).toEqual([{ email: 'hard@ex.com', reason: 'bounced', note: 'ses:Permanent:General' }]);
    expect(parseSesEvent(bounce('soft@ex.com', 'Transient'))).toEqual([]);
    expect(parseSesEvent({ eventType: 'Complaint', complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'c@ex.com' }] } }))
      .toEqual([{ email: 'c@ex.com', reason: 'complaint', note: 'ses:Complaint:abuse' }]);
  });

  it('a signed Permanent bounce suppresses; an unsigned one does nothing', async () => {
    const id = await sesConfig();
    expect(await ingest(id, notification(bounce('Hard@Ex.com', 'Permanent')))).toMatchObject({ status: 'ok', suppressed: 1, failed: 0 });
    expect(await isSuppressed(T, 'hard@ex.com')).toBe(true);

    const forged = { ...notification(bounce('x@ex.com', 'Permanent')), Signature: Buffer.from('nope').toString('base64') };
    expect(await ingest(id, forged)).toEqual({ status: 'unauthorized' });
    expect(await isSuppressed(T, 'x@ex.com')).toBe(false);
  });

  it('confirms a subscription for the pinned topic only, after verification', async () => {
    const id = await sesConfig();
    const sub = (topic: string, url = 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t') =>
      signed({ Type: 'SubscriptionConfirmation', Message: 'confirm', SubscribeURL: url, Token: 't' }, { topic });

    expect(await ingest(id, sub('arn:aws:sns:us-east-1:999:other'))).toEqual({ status: 'unauthorized' });
    expect(await ingest(id, sub(TOPIC, 'https://evil.example/confirm'))).toEqual({ status: 'unauthorized' });
    expect(confirmed).toEqual([]);

    expect(await ingest(id, sub(TOPIC))).toMatchObject({ status: 'ok', failed: 0 });
    expect(confirmed).toEqual(['https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t']);
  });

  it('a failed subscription confirmation answers 503 so SNS redelivers it', async () => {
    const id = await sesConfig();
    __setSnsTransportForTest({ fetchCert: async () => PEM, confirm: async () => { throw new Error('sns down'); } });
    const res = await fetch(`${BASE}/host/openwop-app/public-email/events/${id}`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=UTF-8' },
      body: JSON.stringify(signed({ Type: 'SubscriptionConfirmation', Message: 'confirm', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t', Token: 't' })),
    });
    expect(res.status).toBe(503);
  });

  it('the public route accepts SNS text/plain posts', async () => {
    const id = await sesConfig();
    const res = await fetch(`${BASE}/host/openwop-app/public-email/events/${id}`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=UTF-8' },
      body: JSON.stringify(notification(bounce('route@ex.com', 'Permanent'))),
    });
    expect(res.status).toBe(200);
    expect(await isSuppressed(T, 'route@ex.com')).toBe(true);
  });
});

describe('ADR 0994 D1/D2 — provider preference and the Postmark stream', () => {
  const ENV = ['OPENWOP_EMAIL_TRANSACTIONAL_PROVIDER', 'OPENWOP_EMAIL_MARKETING_PROVIDER', 'OPENWOP_EMAIL_DEFAULT_PROVIDER', 'OPENWOP_POSTMARK_BROADCAST_STREAM'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    await __resetConnectionsStore();
  });
  afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('each purpose leads with its own preference; unset keeps today\'s order', () => {
    expect(emailSendProviders('transactional')[0]).toBe('sendgrid');
    process.env.OPENWOP_EMAIL_TRANSACTIONAL_PROVIDER = 'postmark';
    process.env.OPENWOP_EMAIL_MARKETING_PROVIDER = 'smtp';
    expect(emailSendProviders('transactional')[0]).toBe('postmark');
    expect(emailSendProviders('marketing')[0]).toBe('smtp');
    process.env.OPENWOP_EMAIL_MARKETING_PROVIDER = 'not-a-provider';
    expect(emailSendProviders('marketing')[0]).toBe('sendgrid');
  });

  it('a workspace with Postmark and SES picks each by purpose; with one account, uses it for both', async () => {
    process.env.OPENWOP_EMAIL_TRANSACTIONAL_PROVIDER = 'postmark';
    process.env.OPENWOP_EMAIL_MARKETING_PROVIDER = 'smtp';
    await createSecretConnection({ tenantId: 'wsA', provider: 'postmark', kind: 'api_key', secret: 'pm-token', scope: 'workspace' });
    await createSecretConnection({ tenantId: 'wsA', provider: 'smtp', kind: 'basic', secret: JSON.stringify({ host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false, user: 'u', pass: 'p' }), scope: 'workspace' });
    expect(await resolveEmailProvider({ tenantId: 'wsA', purpose: 'transactional' })).toBe('postmark');
    expect(await resolveEmailProvider({ tenantId: 'wsA', purpose: 'marketing' })).toBe('smtp');

    await createSecretConnection({ tenantId: 'wsB', provider: 'postmark', kind: 'api_key', secret: 'pm-token', scope: 'workspace' });
    expect(await resolveEmailProvider({ tenantId: 'wsB', purpose: 'marketing' })).toBe('postmark');
    expect(await resolveEmailProvider({ tenantId: 'wsNone', purpose: 'transactional' })).toBeNull();
  });

  it('Postmark sends transactional mail on outbound and campaign mail on the Broadcast stream', () => {
    const args = { from: 'a@b.c', to: 'x@y.z', subject: 's', text: 't' };
    expect(JSON.parse(__providerBodyForTest('postmark', args, 'transactional')).MessageStream).toBe('outbound');
    expect(JSON.parse(__providerBodyForTest('postmark', args, 'marketing')).MessageStream).toBe('broadcast');
    process.env.OPENWOP_POSTMARK_BROADCAST_STREAM = 'newsletters';
    expect(JSON.parse(__providerBodyForTest('postmark', args, 'marketing')).MessageStream).toBe('newsletters');
  });
});
