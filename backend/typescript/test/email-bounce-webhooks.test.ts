/**
 * Email bounce/complaint webhook ingestion (ADR 0241). Parser unit tests +
 * signature-verified service ingestion + the public receive route.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  parseSendgridEvents, parsePostmarkEvents, verifyPostmarkBasic,
  setWebhookConfig, ingestBounceWebhook, __resetBounceWebhookStore,
} from '../src/features/email/bounceWebhooks.js';
import { isSuppressed, __clearSuppressions } from '../src/features/crm/suppressionService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

// A non-signed-in tenant (no `user:`/`ws:` prefix) so byok setSecret uses the
// local-aes path — the test host has no KMS (production signed-in tenants do).
const T = 'bounce-tenant';

beforeEach(async () => { await __resetBounceWebhookStore(); await __clearSuppressions(); });

describe('ADR 0241 — event parsers (hard-only)', () => {
  it('SendGrid: suppresses bounce + spamreport, ignores deferred/open', () => {
    const out = parseSendgridEvents([
      { email: 'hard@ex.com', event: 'bounce', type: 'bounce' },
      { email: 'spam@ex.com', event: 'spamreport' },
      { email: 'soft@ex.com', event: 'deferred' },
      { email: 'opened@ex.com', event: 'open' },
      { event: 'bounce' }, // no email → skipped
    ]);
    expect(out.map((i) => `${i.email}:${i.reason}`)).toEqual(['hard@ex.com:bounced', 'spam@ex.com:complaint']);
  });

  it('Postmark: suppresses HardBounce + SpamComplaint, ignores SoftBounce', () => {
    const out = parsePostmarkEvents([
      { RecordType: 'Bounce', Type: 'HardBounce', Email: 'hard@ex.com' },
      { RecordType: 'SpamComplaint', Email: 'spam@ex.com' },
      { RecordType: 'Bounce', Type: 'SoftBounce', Email: 'soft@ex.com' },
    ]);
    expect(out.map((i) => `${i.email}:${i.reason}`)).toEqual(['hard@ex.com:bounced', 'spam@ex.com:complaint']);
  });

  it('Postmark: tolerates a single-object body', () => {
    const out = parsePostmarkEvents({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'solo@ex.com' });
    expect(out).toEqual([{ email: 'solo@ex.com', reason: 'bounced', note: 'postmark:HardBounce' }]);
  });
});

describe('ADR 0241 — Postmark Basic verification', () => {
  it('accepts the exact user:pass, rejects a mismatch / missing', () => {
    const b64 = Buffer.from('user:pass').toString('base64');
    expect(verifyPostmarkBasic({ expectedUserPass: 'user:pass', authorizationHeader: `Basic ${b64}` }).ok).toBe(true);
    expect(verifyPostmarkBasic({ expectedUserPass: 'user:pass', authorizationHeader: `Basic ${Buffer.from('user:wrong').toString('base64')}` }).ok).toBe(false);
    expect(verifyPostmarkBasic({ expectedUserPass: 'user:pass', authorizationHeader: undefined }).ok).toBe(false);
  });
});

describe('ADR 0241 — signed SendGrid ingestion (service)', () => {
  // A real EC (prime256v1) keypair — the public key (base64 DER SPKI) is the
  // stored "verification key"; we sign timestamp+body with the private key.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const verificationKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signSendgrid = (ts: string, rawBody: string): string =>
    cryptoSign('sha256', Buffer.from(ts + rawBody, 'utf8'), privateKey).toString('base64');

  it('a valid signature over a hard bounce suppresses the address; a bad signature is a no-op', async () => {
    const cfg = await setWebhookConfig({ tenantId: T, orgId: 'o1', provider: 'sendgrid', verificationSecret: verificationKey });
    const rawBody = JSON.stringify([{ email: 'bounced@ex.com', event: 'bounce', type: 'bounce' }]);
    const ts = String(Math.floor(Date.now() / 1000));

    const ok = await ingestBounceWebhook({
      webhookId: cfg.webhookId, rawBody, body: JSON.parse(rawBody),
      headers: { sendgridSignature: signSendgrid(ts, rawBody), sendgridTimestamp: ts }, now: Date.now(),
    });
    expect(ok).toEqual({ status: 'ok', suppressed: 1, escalated: 0, failed: 0 });
    expect(await isSuppressed(T, 'bounced@ex.com')).toBe(true);

    // Bad signature → unauthorized, no suppression.
    const bad = await ingestBounceWebhook({
      webhookId: cfg.webhookId, rawBody: JSON.stringify([{ email: 'evil@ex.com', event: 'bounce' }]),
      body: [{ email: 'evil@ex.com', event: 'bounce' }],
      headers: { sendgridSignature: 'AAAA', sendgridTimestamp: ts }, now: Date.now(),
    });
    expect(bad.status).toBe('unauthorized');
    expect(await isSuppressed(T, 'evil@ex.com')).toBe(false);
  });

  it('unknown webhookId → not_found', async () => {
    const r = await ingestBounceWebhook({ webhookId: 'ewh:nope', rawBody: '[]', body: [], headers: {}, now: Date.now() });
    expect(r.status).toBe('not_found');
  });

  it('replay is harmless — re-ingesting the same signed batch keeps one suppression', async () => {
    const cfg = await setWebhookConfig({ tenantId: T, orgId: 'o1', provider: 'sendgrid', verificationSecret: verificationKey });
    const rawBody = JSON.stringify([{ email: 'dup@ex.com', event: 'spamreport' }]);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { sendgridSignature: signSendgrid(ts, rawBody), sendgridTimestamp: ts };
    await ingestBounceWebhook({ webhookId: cfg.webhookId, rawBody, body: JSON.parse(rawBody), headers, now: Date.now() });
    const second = await ingestBounceWebhook({ webhookId: cfg.webhookId, rawBody, body: JSON.parse(rawBody), headers, now: Date.now() });
    expect(second.status).toBe('ok');
    expect(await isSuppressed(T, 'dup@ex.com')).toBe(true);
  });
});

describe('ADR 0241 — public receive route', () => {
  it('a Postmark HardBounce with valid Basic auth suppresses; unknown webhook 404s; bad auth 401s', async () => {
    const userPass = 'pmuser:pmpass';
    const cfg = await setWebhookConfig({ tenantId: T, orgId: 'o1', provider: 'postmark', verificationSecret: userPass });
    const url = `${BASE}/v1/host/openwop-app/public-email/events/${cfg.webhookId}`;
    const basic = `Basic ${Buffer.from(userPass).toString('base64')}`;

    const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basic }, body: JSON.stringify({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'route@ex.com' }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { suppressed: number }).suppressed).toBe(1);
    expect(await isSuppressed(T, 'route@ex.com')).toBe(true);

    const badAuth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic bad' }, body: JSON.stringify({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'x@ex.com' }) });
    expect(badAuth.status).toBe(401);

    const unknown = await fetch(`${BASE}/v1/host/openwop-app/public-email/events/ewh:nope`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basic }, body: '{}' });
    expect(unknown.status).toBe(404);
  });
});

describe('ADR 0249 — soft-bounce escalation', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const verificationKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signSendgrid = (ts: string, rawBody: string): string =>
    cryptoSign('sha256', Buffer.from(ts + rawBody, 'utf8'), privateKey).toString('base64');

  let prevThreshold: string | undefined;
  beforeAll(() => { prevThreshold = process.env.OPENWOP_EMAIL_SOFT_BOUNCE_THRESHOLD; process.env.OPENWOP_EMAIL_SOFT_BOUNCE_THRESHOLD = '3'; });
  afterAll(() => { if (prevThreshold === undefined) delete process.env.OPENWOP_EMAIL_SOFT_BOUNCE_THRESHOLD; else process.env.OPENWOP_EMAIL_SOFT_BOUNCE_THRESHOLD = prevThreshold; });

  async function send(webhookId: string, events: unknown[]): Promise<{ status: string; suppressed?: number; escalated?: number }> {
    const rawBody = JSON.stringify(events);
    const ts = String(Math.floor(Date.now() / 1000));
    return ingestBounceWebhook({ webhookId, rawBody, body: JSON.parse(rawBody), headers: { sendgridSignature: signSendgrid(ts, rawBody), sendgridTimestamp: ts }, now: Date.now() });
  }
  const soft = (email: string) => ({ email, event: 'deferred' });

  it('suppresses only after N consecutive soft bounces; a success resets the streak; a hard bounce suppresses immediately', async () => {
    const cfg = await setWebhookConfig({ tenantId: T, orgId: 'o1', provider: 'sendgrid', verificationSecret: verificationKey });

    // 2 soft (< threshold 3) → tracked, not suppressed.
    await send(cfg.webhookId, [soft('slow@ex.com')]);
    const r2 = await send(cfg.webhookId, [soft('slow@ex.com')]);
    expect(r2).toEqual({ status: 'ok', suppressed: 0, escalated: 0, failed: 0 });
    expect(await isSuppressed(T, 'slow@ex.com')).toBe(false);

    // 3rd consecutive soft → escalates to suppression.
    const r3 = await send(cfg.webhookId, [soft('slow@ex.com')]);
    expect(r3).toEqual({ status: 'ok', suppressed: 1, escalated: 1, failed: 0 });
    expect(await isSuppressed(T, 'slow@ex.com')).toBe(true);

    // A `delivered` success mid-streak RESETS: 2 soft → delivered → 2 soft = streak 2, not suppressed.
    await send(cfg.webhookId, [soft('reco@ex.com')]);
    await send(cfg.webhookId, [soft('reco@ex.com')]);
    await send(cfg.webhookId, [{ email: 'reco@ex.com', event: 'delivered' }]);
    await send(cfg.webhookId, [soft('reco@ex.com')]);
    const reco = await send(cfg.webhookId, [soft('reco@ex.com')]);
    expect(reco.status).toBe('ok');
    expect(await isSuppressed(T, 'reco@ex.com')).toBe(false);

    // A hard bounce suppresses immediately, regardless of any soft streak.
    const hard = await send(cfg.webhookId, [{ email: 'dead@ex.com', event: 'bounce' }]);
    expect(hard).toEqual({ status: 'ok', suppressed: 1, escalated: 0, failed: 0 });
    expect(await isSuppressed(T, 'dead@ex.com')).toBe(true);
  });

  it('a success BEFORE a soft in the same batch resets first (order-processed streak)', async () => {
    const cfg = await setWebhookConfig({ tenantId: T, orgId: 'o1', provider: 'sendgrid', verificationSecret: verificationKey });
    await send(cfg.webhookId, [soft('mix@ex.com')]);
    await send(cfg.webhookId, [soft('mix@ex.com')]); // streak 2 — one more soft alone would escalate
    // delivered(reset 0) → deferred(1): the leading success clears the streak, so
    // the trailing soft lands at 1 (< 3) and does NOT escalate.
    const r = await send(cfg.webhookId, [{ email: 'mix@ex.com', event: 'delivered' }, soft('mix@ex.com')]);
    expect(r.escalated).toBe(0);
    expect(await isSuppressed(T, 'mix@ex.com')).toBe(false);
  });
});
