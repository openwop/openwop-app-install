/**
 * ADR 0994 — an SMTP send failure is logged with a closed-world `failure` class
 * (`auth` | `connect` | `timeout` | `rejected` | `other`) and the ADR 0900
 * `reasonCode` beside it, so ops can tell bad credentials from a timeout.
 *
 * Why it exists: in production the only cause on the line was `reason`, which the
 * logger's PII mask hashes (`reason` is a declared PII field), so an SES auth
 * failure (wrong SMTP credentials) read as `pii_54a0e8c17e`. The log is driven
 * through the REAL sink (`createLogger` → `process.stdout.write`), and the
 * classifier is fed the error the REAL nodemailer raises against a stub that
 * answers AUTH with 535, so the code table is checked against the library rather
 * than against itself.
 *
 * Red when (sabotage-witnessed, re-measured in /grade-tests wave 80): EAUTH maps to
 * anything but `auth`, or ETIMEDOUT to anything but `timeout`; the 535 / 4xx reply-code
 * fallback changes; an inherited key (`toString`) is read as a class; the send-catch
 * stops logging `failure`/`reasonCode`, or writes a constant `reasonCode`; a timeout
 * line carries a `responseCode`; the pre-dial catch stops logging; the line carries the
 * password, the SMTP user (send or dial line) or the server's reply text.
 *
 * The SMTP user is an SES-style access-key id, not an email address: the logger hashes
 * email-shaped values anywhere on a line, so an email-shaped user would hide a leak of
 * it (wave 80 measured both leak probes vacuous with `mailer@x.com`). The property that
 * `reasonCode` is written past the PII mask by construction belongs to the logger's own
 * tests; the last case only shows that the class survives in `reasonCode` when
 * `failure` itself is masked, and it restores the PII registry after itself.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let dialThrows: Error | undefined;
vi.mock('../src/host/smtpEgress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/smtpEgress.js')>();
  return {
    ...actual,
    assertSmtpDialAllowed: async (tenantId: string, host: string, port: number) => {
      if (dialThrows) throw dialThrows;
      void tenantId;
      return { host, address: '127.0.0.1', family: 4, port };
    },
  };
});

import net from 'node:net';
import { createApp } from '../src/index.js';
import { classifySmtpFailure, sendViaSmtp } from '../src/host/smtpSend.js';
import type { SmtpTransportFactory } from '../src/host/smtpSend.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { __resetPiiRegistry, declarePiiFields, isKnownPiiFieldName, piiFieldRegistry } from '../src/host/dataClassification.js';
import type { Storage } from '../src/storage/storage.js';

const PASS = 's3cret-pw';
/** SES SMTP credentials are an IAM access-key id + a derived password (AWS's documented example id). */
const USER = 'AKIAIOSFODNN7EXAMPLE';

/** The shape nodemailer's `_formatError` builds for a 535 on AUTH. */
function eauthError(): Error {
  return Object.assign(new Error(`Invalid login: 535 Authentication Credentials Invalid for ${USER}`), {
    code: 'EAUTH',
    response: `535 Authentication Credentials Invalid for ${USER}`,
    responseCode: 535,
    command: 'AUTH PLAIN',
  });
}

function captureLines(component: string): { lines: () => Array<Record<string, unknown>>; raw: () => string } {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
  const mine = () => out.filter((l) => l.includes(`"component":"${component}"`));
  return { lines: () => mine().map((l) => JSON.parse(l) as Record<string, unknown>), raw: () => mine().join('') };
}

describe('classifySmtpFailure (ADR 0994)', () => {
  const table: Array<[string, string]> = [
    ['EAUTH', 'auth'], ['ENOAUTH', 'auth'], ['EOAUTH2', 'auth'],
    ['ECONNECTION', 'connect'], ['ESOCKET', 'connect'], ['EDNS', 'connect'], ['ETLS', 'connect'], ['EPROXY', 'connect'],
    ['ECONNREFUSED', 'connect'], ['ECONNRESET', 'connect'], ['ENOTFOUND', 'connect'], ['EHOSTUNREACH', 'connect'], ['ENETUNREACH', 'connect'],
    ['ETIMEDOUT', 'timeout'],
    ['EENVELOPE', 'rejected'], ['EMESSAGE', 'rejected'], ['EMAXRECIPIENTS', 'rejected'], ['EREQUIRETLS', 'rejected'],
  ];
  it.each(table)('%s → %s', (code, cls) => {
    expect(classifySmtpFailure(Object.assign(new Error('x'), { code }))).toBe(cls);
  });

  it('falls back to the SMTP reply code when the code is unknown or absent', () => {
    expect(classifySmtpFailure({ responseCode: 535 })).toBe('auth');
    expect(classifySmtpFailure({ code: 'EPROTOCOL', responseCode: 530 })).toBe('auth');
    expect(classifySmtpFailure({ responseCode: 550 })).toBe('rejected');
    expect(classifySmtpFailure({ responseCode: 451 })).toBe('rejected');
  });

  it('anything unrecognised is other, never a value read from the error', () => {
    for (const e of [new Error('boom'), { code: 'EPROTOCOL' }, { code: 'toString' }, { code: 42 }, { responseCode: 250 }, null, undefined, 'EAUTH']) {
      expect(classifySmtpFailure(e)).toBe('other');
    }
  });

  it('the REAL nodemailer error for a 535 on AUTH classifies as auth', async () => {
    const server = net.createServer((sock) => {
      sock.write('220 stub ESMTP\r\n');
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const verb = buf.slice(0, i).split(' ')[0]!.toUpperCase(); buf = buf.slice(i + 2);
          if (verb === 'EHLO') sock.write('250-stub\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (verb === 'AUTH') sock.write('535 5.7.8 Authentication Credentials Invalid\r\n');
          else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('502 no\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const { default: nodemailer } = await import('nodemailer');
    const t = nodemailer.createTransport({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, secure: false, ignoreTLS: true, auth: { user: 'u', pass: 'p' }, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000 });
    try {
      const err = await t.sendMail({ from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't' }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeDefined();
      expect(classifySmtpFailure(err)).toBe('auth');
    } finally {
      t.close();
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe('sendViaSmtp failure logging (ADR 0994)', () => {
  let storage: Storage;
  const deps = () => ({ storage, tenantId: 'tsmtpfc', runId: 'run-smtpfc', actingUserId: 'u1', orgId: 'tsmtpfc' });
  const args = { from: 'a@x.com', to: ['b@y.com'], subject: 'hi', text: 'body', provider: 'smtp' as const };
  const throwing = (err: Error): SmtpTransportFactory => () => ({ async sendMail() { throw err; } });

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    await createSecretConnection({
      tenantId: 'tsmtpfc', provider: 'smtp', kind: 'basic', scope: 'user', userId: 'u1',
      secret: JSON.stringify({ host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false, user: USER, pass: PASS }),
    });
  }, 120_000);
  afterEach(() => { dialThrows = undefined; vi.restoreAllMocks(); });
  afterAll(() => { dialThrows = undefined; });

  it('an EAUTH send failure logs failure:auth + reasonCode + responseCode, and no secret, user or reply text', async () => {
    const cap = captureLines('connections.email.smtp');
    const out = await sendViaSmtp(deps(), { ...args, idempotencyKey: 'k-auth' }, 'tsmtpfc:k-auth', throwing(eauthError()));
    expect(out).toEqual({ sent: false, provider: 'smtp', error: 'email_request_failed' });
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'smtp send failed', level: 'warn', failure: 'auth', reasonCode: 'smtp_auth', responseCode: 535, port: 587 });
    expect('response' in lines[0]!).toBe(false);
    const raw = cap.raw();
    expect(raw).not.toContain(PASS);
    expect(raw).not.toContain(USER);
    expect(raw).not.toContain('Credentials Invalid');
  });

  it('a timeout logs failure:timeout (and no responseCode when the server sent none)', async () => {
    const cap = captureLines('connections.email.smtp');
    await sendViaSmtp(deps(), args, 'tsmtpfc:k-to', throwing(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })));
    const [line] = cap.lines();
    expect(line).toMatchObject({ failure: 'timeout', reasonCode: 'smtp_timeout' });
    expect('responseCode' in line!).toBe(false);
  });

  it('a non-egress pre-dial throw logs failure:connect and keeps the email_request_failed code', async () => {
    dialThrows = new Error(`rules read failed for ${USER}`);
    const cap = captureLines('connections.email.smtp');
    const out = await sendViaSmtp(deps(), args, 'tsmtpfc:k-dial', throwing(eauthError()));
    expect(out).toEqual({ sent: false, provider: 'smtp', error: 'email_request_failed' });
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'smtp dial failed', failure: 'connect', reasonCode: 'smtp_connect' });
    expect(cap.raw()).not.toContain(USER);
  });

  // If `failure` is ever declared PII, the class is still readable through
  // `reasonCode`, which the logger writes verbatim. Declarations are process-global,
  // so the registry is snapshotted and restored exactly (entities, fields and the
  // global field-name set): the other cases assert `failure` in the clear.
  it('with `failure` declared PII, reasonCode still carries the class', async () => {
    const snap = [...piiFieldRegistry()].map(([entity, fields]) => [entity, [...fields]] as const);
    const globals = new Set(snap.flatMap(([, fields]) => fields).filter(isKnownPiiFieldName));
    expect(isKnownPiiFieldName('failure')).toBe(false);
    try {
      declarePiiFields('smtp.failure.probe', ['failure']);
      const cap = captureLines('connections.email.smtp');
      await sendViaSmtp(deps(), args, 'tsmtpfc:k-pii', throwing(eauthError()));
      const [line] = cap.lines();
      expect(String(line!.failure)).toMatch(/^pii_[0-9a-f]{10}$/);
      expect(line!.reasonCode).toBe('smtp_auth');
    } finally {
      __resetPiiRegistry();
      for (const [entity, fields] of snap) {
        for (const f of fields) declarePiiFields(entity, [f], { maskGloballyByFieldName: globals.has(f) });
      }
    }
    expect(isKnownPiiFieldName('failure')).toBe(false);
  });
});
