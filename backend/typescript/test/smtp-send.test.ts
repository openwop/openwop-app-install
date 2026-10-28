/**
 * ADR 0201 — SMTP transport (`smtpSend.ts`) + the `emailAdapter` dispatch to it.
 * Proves: the sealed `{host,port,secure,user,pass}` blob is resolved and the creds
 * are handed to the transport; the pinned IP is dialed with STARTTLS forced on 587;
 * a missing connection / bad blob fail-close gracefully; and the SHARED `email:sent`
 * ledger dedups a replay (no second transport call). A fake transporter is injected
 * so no socket is opened.
 *
 * The sealed blob names a HOSTNAME (`mail.smtp.test`) that the mocked resolver
 * maps to 127.0.0.1, so "dials the pinned IP" can tell `host: pinned.address`
 * from `host: cfg.host`, and the SNI `servername` branch is reached. With the
 * old `host: '127.0.0.1'` blob the two were equal and swapping them stayed green
 * (8fw3g1-smtps-pin, round-1 vacuous).
 *
 * What breaks it (sabotage-witnessed, /grade-tests wave 61, 8fw3g1-smtps-*):
 * requireTLS on 587, the pinned-IP dial + SNI, the malformed-blob refusal, the
 * shared-ledger dedup, smtp dispatch + the configured default.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Only `mail.smtp.test` is faked; every other lookup reaches the real resolver.
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  // `dns.lookup` is an overload set; the wrapper forwards whatever it was given,
  // so it is typed as the original (the one cast in this file, on the mock).
  const lookup = ((host: string, ...rest: unknown[]): void => {
    const cb = rest[rest.length - 1] as (e: Error | null, a: unknown) => void;
    if (host === 'mail.smtp.test') { cb(null, [{ address: '127.0.0.1', family: 4 }]); return; }
    Reflect.apply(actual.lookup, actual, [host, ...rest]);
  }) as typeof actual.lookup;
  return { ...actual, lookup, default: { ...actual, lookup } };
});
import net from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { sendViaSmtp } from '../src/host/smtpSend.js';
import type { SmtpTransportFactory, SmtpDialOptions, SmtpMessage } from '../src/host/smtpSend.js';
import { makeEmailAdapter, emailSendProviders } from '../src/host/emailAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

const blob = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ host: 'mail.smtp.test', port: 587, secure: false, user: 'mailer@x.com', pass: 's3cret-pw', ...over });

describe('SMTP transport + adapter dispatch (ADR 0201)', () => {
  it('the REAL nodemailer transport accepts our SmtpDialOptions subset (v10 runtime pin — no dial)', async () => {
    // Dependency-bump pin (nodemailer 6→9→10): createTransport validates options
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

  // nodemailer 9→10 (a major, on the live send path): the REAL transport against
  // a local plaintext SMTP stub, so the protocol exchange is exercised without a
  // real server. The stub advertises AUTH and (optionally) never STARTTLS, and
  // records every command it receives.
  async function smtpStub(opts: { starttls: boolean }): Promise<{ port: number; seen: string[]; data: string[]; close: () => Promise<void> }> {
    const seen: string[] = [];
    const data: string[] = [];
    const server = net.createServer((sock) => {
      let inData = false;
      let buf = '';
      sock.write('220 stub ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') { inData = false; sock.write('250 2.0.0 queued as stub-1\r\n'); } else data.push(line);
            continue;
          }
          seen.push(line);
          const verb = line.split(' ')[0]!.toUpperCase();
          if (verb === 'EHLO') sock.write(`250-stub${opts.starttls ? '\r\n250-STARTTLS' : ''}\r\n250 AUTH PLAIN LOGIN\r\n`);
          else if (verb === 'AUTH') sock.write('235 2.7.0 ok\r\n');
          else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 ok\r\n');
          else if (verb === 'DATA') { inData = true; sock.write('354 go\r\n'); }
          else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('502 no\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    return { port: (server.address() as net.AddressInfo).port, seen, data, close: () => new Promise<void>((res) => server.close(() => res())) };
  }

  it('v10 REAL transport: requireTLS (our 587 posture) refuses a server with no STARTTLS — no AUTH, no MAIL is ever sent', async () => {
    const { default: nodemailer } = await import('nodemailer');
    const stub = await smtpStub({ starttls: false });
    try {
      const opts: SmtpDialOptions = { host: '127.0.0.1', port: stub.port, secure: false, requireTLS: true, auth: { user: 'u', pass: 'p' }, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000 };
      const t = nodemailer.createTransport(opts);
      await expect(t.sendMail({ from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't' })).rejects.toThrow();
      expect(stub.seen.some((l) => /^AUTH\b/i.test(l)), `credentials crossed a plaintext link: ${stub.seen.join(' | ')}`).toBe(false);
      expect(stub.seen.some((l) => /^MAIL\b/i.test(l))).toBe(false);
      t.close();
    } finally { await stub.close(); }
  });

  it('v10 REAL transport: AUTH + our full message shape reach the server (cc/bcc envelope, replyTo, html, messageId)', async () => {
    // Plaintext + requireTLS:false ONLY because a local stub has no certificate;
    // sendViaSmtp never builds this (it forces requireTLS on secure:false). What is
    // under test is v10's AUTH exchange and message composition on our SmtpMessage.
    const { default: nodemailer } = await import('nodemailer');
    const stub = await smtpStub({ starttls: false });
    try {
      const t = nodemailer.createTransport({ host: '127.0.0.1', port: stub.port, secure: false, requireTLS: false, ignoreTLS: true, auth: { user: 'mailer@x.com', pass: 's3cret-pw' }, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000 });
      const msg: SmtpMessage = { from: 'a@x.com', to: ['b@y.com'], cc: 'c@y.com', bcc: ['d@y.com'], subject: 'hello v10', text: 'plain body', html: '<p>html body</p>', replyTo: 'r@x.com' };
      const info = await t.sendMail(msg);
      expect(typeof info.messageId).toBe('string');
      expect(stub.seen.some((l) => /^AUTH (PLAIN|LOGIN)/i.test(l))).toBe(true);
      const rcpts = stub.seen.filter((l) => /^RCPT TO:/i.test(l)).join(' ');
      for (const r of ['b@y.com', 'c@y.com', 'd@y.com']) expect(rcpts).toContain(r);
      const body = stub.data.join('\n');
      expect(body).toMatch(/^Subject: hello v10$/m);
      expect(body).toMatch(/^Reply-To: r@x\.com$/m);
      expect(body).not.toMatch(/^Bcc:/m); // bcc is envelope-only
      expect(body).toContain('plain body');
      expect(body).toContain('<p>html body</p>');
      t.close();
    } finally { await stub.close(); }
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

  let savedAllowPrivate: string | undefined;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    savedAllowPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // reach the 127.0.0.1 dial target in tests
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    await createSecretConnection({ tenantId: 'tsmtp', provider: 'smtp', kind: 'basic', secret: blob(), scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-smtp', workflowId: 'w', tenantId: 'tsmtp', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  });
  afterAll(() => {
    if (savedAllowPrivate === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = savedAllowPrivate;
  });

  it('resolves the sealed blob, forces STARTTLS on 587, dials the pinned IP, sends, stamps + records', async () => {
    sendCount = 0;
    const out = await sendViaSmtp(deps(), { ...args, idempotencyKey: 'k-send' }, 'tsmtp:k-send', fake);
    expect(out).toEqual({ sent: true, provider: 'smtp', messageId: 'smtp-msg-1' });
    // dial security: pinned IP as host, STARTTLS forced (secure:false → requireTLS), creds passed.
    expect(lastOpts).toMatchObject({ host: '127.0.0.1', port: 587, secure: false, requireTLS: true, auth: { user: 'mailer@x.com', pass: 's3cret-pw' } });
    // TLS still verifies against the NAME the operator configured, not the IP.
    expect(lastOpts?.servername).toBe('mail.smtp.test');
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
    const saved = process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER;
    try {
      process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER = 'smtp';
      expect(emailSendProviders()[0]).toBe('smtp');
    } finally {
      if (saved === undefined) delete process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER; else process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER = saved;
    }
  });
});
