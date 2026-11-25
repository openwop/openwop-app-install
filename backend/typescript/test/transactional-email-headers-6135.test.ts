/**
 * #6135 — the transactional seam carries a sender display name, a Reply-To and the
 * feature's own RFC 8058 opt-out link, and e-sign invites ride that seam instead of
 * the console stub.
 *
 *  - `fromName` / `replyTo` with a control character (CR/LF above all), a display name
 *    or a list are refused, typed, at BOTH doors: the seam (`invalid_header`, the
 *    transport never called) and the adapter (`email_header_invalid`, no provider
 *    request), so a caller that skips the seam is still refused;
 *  - each provider gets the name in its own shape (SendGrid `from.name`, Postmark a
 *    quoted `"Name" <addr>`, SMTP an address object);
 *  - `listUnsubscribe` is accepted on the deployment's own `OPENWOP_PUBLIC_BASE_URL`
 *    origin, and still dropped on any other origin;
 *  - end to end through the email feature's real transport to a fake SendGrid, all
 *    three fields reach the provider body;
 *  - `requestSignature` reports `invitesEmailed: true` only when every invite was
 *    accepted, its mail carries the signing link, and an idempotent replay re-sends
 *    nothing (the per-signer ledger key).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { emailHeaderFieldProblem, formatFromLine } from '../src/host/emailHeaderFields.js';
import { __providerBodyForTest, listUnsubscribeHeaders } from '../src/host/emailAdapter.js';
import { sendTransactional, sendTransactionalEmail, transactionalEmailReady } from '../src/host/transactionalEmail.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { createOrg } from '../src/host/accessControlService.js';
import { setSenderAddress } from '../src/features/email/emailService.js';
import { sendBrokeredTransactionalEmail } from '../src/features/email/brokeredProvider.js';
import { requestSignature } from '../src/features/crm/signService.js';
import { SIGN_REQUEST_KIND } from '../src/features/crm/signTemplates.js';
import { createDocument, addVersion } from '../src/features/documents/documentsService.js';

const T = 't6135';
const USER = 'designer-1';
let storage: Storage;
let sg: http.Server;
let requests: Array<Record<string, unknown>> = [];
const savedBase = process.env.OPENWOP_PUBLIC_BASE_URL;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  for (const id of ['crm', 'documents']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await __resetConnectionsStore();
  sg = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(202, { 'x-message-id': `sg-${requests.length}` });
      res.end();
    });
  });
  await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;
  await createSecretConnection({ tenantId: T, provider: 'sendgrid', kind: 'api_key', secret: 'SG.key6135', scope: 'user', userId: USER });
});
afterAll(async () => {
  delete process.env.OPENWOP_SENDGRID_API_BASE;
  if (savedBase === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL; else process.env.OPENWOP_PUBLIC_BASE_URL = savedBase;
  await new Promise<void>((r) => sg.close(() => r()));
});

describe('header fields are refused, typed, when they could break a header line', () => {
  it('names the field; accepts a plain name and one bare address', () => {
    expect(emailHeaderFieldProblem({ fromName: 'Hart Studio', replyTo: 'ana@hart.test' })).toBeNull();
    expect(emailHeaderFieldProblem({})).toBeNull();
    for (const fromName of ['Hart\r\nBcc: x@evil.test', 'Hart\nStudio', 'Hart\u0000', '   ', 'x'.repeat(101)]) {
      expect(emailHeaderFieldProblem({ fromName }), JSON.stringify(fromName)).toBe('from_name_invalid');
    }
    for (const replyTo of ['ana@hart.test\r\nBcc: x@evil.test', 'Ana <ana@hart.test>', 'a@hart.test, b@hart.test', 'not-an-address', 'ana@hart']) {
      expect(emailHeaderFieldProblem({ replyTo }), replyTo).toBe('reply_to_invalid');
    }
  });

  it('the seam refuses before the transport sees it', async () => {
    // The email feature's real transport is wired (createApp); a refusal must not reach it.
    requests = [];
    const context = { tenantId: T, orgId: 'any', actingUserId: USER };
    expect(await sendTransactionalEmail({ to: 'c@client.test', subject: 's', text: 't', context, fromName: 'Hart\r\nBcc: x@evil.test' })).toEqual({ sent: false, reason: 'invalid_header' });
    expect(await sendTransactionalEmail({ to: 'c@client.test', subject: 's', text: 't', context, replyTo: 'a@b.test\nX: y' })).toEqual({ sent: false, reason: 'invalid_header' });
    expect(requests).toHaveLength(0);
  });
});

describe('each provider gets the display name in its own shape', () => {
  const args = { from: 'notices@hart.test', fromName: 'Hart "HQ" Studio', to: 'c@client.test', subject: 's', text: 't', replyTo: 'ana@hart.test' };
  it('sendgrid from.name + reply_to; postmark a quoted From line', () => {
    const sgBody = JSON.parse(__providerBodyForTest('sendgrid', args)) as { from: unknown; reply_to: unknown };
    expect(sgBody.from).toEqual({ email: 'notices@hart.test', name: 'Hart "HQ" Studio' });
    expect(sgBody.reply_to).toEqual({ email: 'ana@hart.test' });
    const pm = JSON.parse(__providerBodyForTest('postmark', args, 'transactional')) as { From: string; ReplyTo: string };
    expect(pm.From).toBe('"Hart \\"HQ\\" Studio" <notices@hart.test>');
    expect(pm.ReplyTo).toBe('ana@hart.test');
    expect(formatFromLine('a@b.test')).toBe('a@b.test');
  });
});

describe('listUnsubscribe on the deployment origin', () => {
  it('accepts any https path on OPENWOP_PUBLIC_BASE_URL, still drops another origin', () => {
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.hart.test';
    expect(listUnsubscribeHeaders({ listUnsubscribe: { url: 'https://app.hart.test/casavoga/notices/off/abc' } })).toEqual({
      'List-Unsubscribe': '<https://app.hart.test/casavoga/notices/off/abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(listUnsubscribeHeaders({ listUnsubscribe: { url: 'https://evil.test/casavoga/notices/off/abc' } })).toBeUndefined();
    expect(listUnsubscribeHeaders({ listUnsubscribe: { url: 'http://app.hart.test/off/abc' } })).toBeUndefined();
    delete process.env.OPENWOP_PUBLIC_BASE_URL;
    expect(listUnsubscribeHeaders({ listUnsubscribe: { url: 'https://app.hart.test/casavoga/notices/off/abc' } }), 'unset base ⇒ only the host path').toBeUndefined();
    expect(listUnsubscribeHeaders({ listUnsubscribe: { url: 'https://app.hart.test/public-email/u/tok' } })).toBeDefined();
  });
});

describe('end to end through the email feature transport', () => {
  it('fromName, replyTo and listUnsubscribe reach the provider; the adapter refuses CR/LF on its own', async () => {
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.hart.test';
    const org = await createOrg({ tenantId: T, createdBy: 'owner', name: 'Hart' });
    await setSenderAddress(T, org.orgId, 'notices@hart.test', 'owner');
    const context = { tenantId: T, orgId: org.orgId, actingUserId: USER };
    expect(await transactionalEmailReady(context), 'sender + connection ⇒ ready').toBe(true);
    expect(await transactionalEmailReady({ ...context, actingUserId: 'nobody' }), 'no connection ⇒ not ready').toBe(false);

    requests = [];
    const out = await sendTransactional(SIGN_REQUEST_KIND, {
      to: 'client@client.test', data: { title: 'Selections', url: 'https://app.hart.test/x' },
      context: { ...context, idempotencyKey: 'e2e-6135' },
      fromName: 'Hart Studio', replyTo: 'ana@hart.test', listUnsubscribe: { url: 'https://app.hart.test/casavoga/off/abc' },
    });
    expect(out).toEqual({ sent: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      from: { email: 'notices@hart.test', name: 'Hart Studio' },
      reply_to: { email: 'ana@hart.test' },
      headers: { 'List-Unsubscribe': '<https://app.hart.test/casavoga/off/abc>' },
    });

    // Past the seam: the adapter's own check holds.
    requests = [];
    expect(await sendBrokeredTransactionalEmail({ storage, ...context, to: 'client@client.test', subject: 's', text: 't', idempotencyKey: 'e2e-6135-bad', fromName: 'Hart\r\nBcc: x@evil.test' })).toBe(false);
    expect(requests, 'a refused header never reaches the provider').toHaveLength(0);
    delete process.env.OPENWOP_PUBLIC_BASE_URL;
  });
});

describe('e-sign invites ride the real lane', () => {
  it('invitesEmailed is true only after the sends, carries the link, and a replay re-sends nothing', async () => {
    const org = await createOrg({ tenantId: T, createdBy: 'owner', name: 'Hart Sign' });
    await setSenderAddress(T, org.orgId, 'sign@hart.test', 'owner');
    const doc = await createDocument({ tenantId: T, orgId: org.orgId, title: 'Agreement', kind: 'doc', provenance: { producedBy: { kind: 'user', id: USER } }, createdBy: USER });
    await addVersion(T, org.orgId, doc.documentId, { content: '# Agreement\n\nPlease sign.', producedBy: { kind: 'user', id: USER } });
    const input = {
      tenantId: T, orgId: org.orgId, target: { kind: 'document', id: doc.documentId },
      signers: [{ email: 'ann@client.test', name: 'Ann' }, { email: 'bob@client.test', name: 'Bob' }],
      createdBy: USER, baseUrl: 'https://app.hart.test', signRequestId: 'sign-request:sr-6135',
    };

    requests = [];
    const created = await requestSignature(input);
    expect(created.invitesEmailed).toBe(true);
    expect(requests).toHaveLength(2);
    const bodies = JSON.stringify(requests);
    expect(bodies).toContain('https://app.hart.test/sign/');
    expect(bodies).toContain('ann@client.test');
    expect(bodies).toContain('bob@client.test');

    requests = [];
    const replay = await requestSignature(input);
    expect(replay.invitesEmailed, 'the idempotent replay emails nobody and says so').toBe(false);
    expect(requests).toHaveLength(0);

    // A requester with no email Connection: the request is created, nothing is claimed.
    const none = await requestSignature({ ...input, createdBy: 'no-connection-user', signRequestId: 'sign-request:sr-6135-none' });
    expect(none.invitesEmailed).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
