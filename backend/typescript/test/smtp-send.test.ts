/**
 * ADR 0201 — SMTP transport (`smtpSend.ts`) + the `emailAdapter` dispatch to it.
 * Proves: the sealed `{host,port,secure,user,pass}` blob is resolved and the creds
 * are handed to the transport; the pinned IP is dialed with STARTTLS forced on 587;
 * a missing connection / bad blob fail-close gracefully; and the SHARED `email:sent`
 * ledger dedups a replay (no second transport call). A fake transporter is injected
 * so no socket is opened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { sendViaSmtp } from '../src/host/smtpSend.js';
import type { SmtpTransportFactory, SmtpDialOptions, SmtpMessage } from '../src/host/smtpSend.js';
import { makeEmailAdapter, emailSendProviders } from '../src/host/emailAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

const blob = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ host: '127.0.0.1', port: 587, secure: false, user: 'mailer@x.com', pass: 's3cret-pw', ...over });

describe('SMTP transport + adapter dispatch (ADR 0201)', () => {
  it('the REAL nodemailer transport accepts our SmtpDialOptions subset (v9 runtime pin — no dial)', async () => {
    // Dependency-bump pin (nodemailer 6→9): createTransport validates options
    // at construction without opening a socket; sendMail is never called.
    const { default: nodemailer } = await import('nodemailer');
    const opts: SmtpDialOptions = {
      host: '198.51.100.10', // TEST-NET-2 — never dialed
      port: 465,
      secure: true,
      requireTLS: true,
      auth: { user: 'u', pass: 'p' },
      connectionTimeout: 1000,
      greetingTimeout: 1000,
      socketTimeout: 1000,
      servername: 'smtp.example.com',
    };
    const transporter = nodemailer.createTransport(opts);
    expect(typeof transporter.sendMail).toBe('function');
    // The top-level servername survives into the transport options (the
    // smtpEgress pinned-IP SNI pattern — smtpSend.ts's load-bearing comment).
    expect((transporter.options as { servername?: string }).servername).toBe('smtp.example.com');
    transporter.close();
  });

  let storage: Storage;
  const deps = () => ({ storage, tenantId: 'tsmtp', runId: 'run-smtp', actingUserId: 'u1', orgId: 'tsmtp' });
  const args = { from: 'a@x.com', to: ['b@y.com'], subject: 'hi', text: 'body', provider: 'smtp' as const };

  // Injected transport — captures the opts + mail, never opens a socket.
  let lastOpts: SmtpDialOptions | undefined;
  let lastMail: SmtpMessage | undefined;
  let sendCount = 0;
  const fake: SmtpTransportFactory = (opts) => {
    lastOpts = opts;
    return { async sendMail(msg) { lastMail = msg; sendCount++; return { messageId: 'smtp-msg-1' }; } };
  };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // reach the 127.0.0.1 dial target in tests
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    await createSecretConnection({ tenantId: 'tsmtp', provider: 'smtp', kind: 'basic', secret: blob(), scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-smtp', workflowId: 'w', tenantId: 'tsmtp', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });
  afterAll(() => { delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; });

  it('resolves the sealed blob, forces STARTTLS on 587, dials the pinned IP, sends, stamps + records', async () => {
    sendCount = 0;
    const out = await sendViaSmtp(deps(), { ...args, idempotencyKey: 'k-send' }, 'tsmtp:k-send', fake);
    expect(out).toEqual({ sent: true, provider: 'smtp', messageId: 'smtp-msg-1' });
    // dial security: pinned IP as host, STARTTLS forced (secure:false → requireTLS), creds passed.
    expect(lastOpts).toMatchObject({ host: '127.0.0.1', port: 587, secure: false, requireTLS: true, auth: { user: 'mailer@x.com', pass: 's3cret-pw' } });
    expect(lastMail).toMatchObject({ from: 'a@x.com', to: ['b@y.com'], subject: 'hi', text: 'body' });
    // provenance stamped on the run
    const meta = (await storage.getRun('run-smtp'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'smtp')).toBe(true);
  });

  it('SHARED ledger dedups a replay — the adapter returns the prior send WITHOUT a second transport call', async () => {
    // Seed the ledger via the transport, then the adapter (real factory) must dedup
    // on the same fork-stable key and never dial.
    sendCount = 0;
    await sendViaSmtp(deps(), { ...args, idempotencyKey: 'k-dedup' }, 'tsmtp:k-dedup', fake);
    expect(sendCount).toBe(1);
    const out = await makeEmailAdapter(deps()).send({ ...args, idempotencyKey: 'k-dedup' });
    expect(out).toMatchObject({ sent: true, provider: 'smtp', messageId: 'smtp-msg-1' });
    expect(sendCount).toBe(1); // no second send — deduped before any dial
  });

  it('fail-closed: no connection → email_not_connected (proves adapter DISPATCHES to smtp, not "unsupported")', async () => {
    const out = await makeEmailAdapter({ storage, tenantId: 'tsmtp-none', runId: 'run-smtp', actingUserId: 'u1' })
      .send({ ...args });
    expect(out).toEqual({ sent: false, provider: 'smtp', error: 'email_not_connected' });
  });

  it('fail-closed: a malformed sealed blob → smtp_config_invalid (never dials)', async () => {
    await createSecretConnection({ tenantId: 'tbad', provider: 'smtp', kind: 'basic', secret: '{not json', scope: 'user', userId: 'u1' });
    sendCount = 0;
    const out = await sendViaSmtp({ storage, tenantId: 'tbad', runId: 'run-smtp', actingUserId: 'u1' }, args, 'tbad:x', fake);
    expect(out).toEqual({ sent: false, provider: 'smtp', error: 'smtp_config_invalid' });
    expect(sendCount).toBe(0);
  });

  it('emailSendProviders() includes smtp and honors it as the configured default', () => {
    expect(emailSendProviders()).toContain('smtp');
    process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER = 'smtp';
    expect(emailSendProviders()[0]).toBe('smtp');
    delete process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER;
  });
});
