/**
 * ADR 0201 Phase 3 — the raw-SMTP transport branch for `ctx.email.send`.
 *
 * Kept OUT of `emailAdapter.ts` so the `nodemailer` (TCP) dependency is isolated
 * to this one module and the HTTP send path stays broker-only. The transactional
 * adapter dispatches here when `provider === 'smtp'`; this shares the SAME
 * `email:sent` idempotency ledger and `stampConnectionUse`-on-success as the HTTP
 * providers (the caller checks the ledger BEFORE calling us; we record on accept).
 *
 * Security spine (ADR 0201):
 *   - the dial target comes ONLY from the connection's sealed `{host,port,...}`
 *     blob (an agent/config can never supply a host);
 *   - `assertSmtpDialAllowed` (the TCP-egress firewall) runs BEFORE any socket —
 *     port allowlist + tenant ADR 0187 policy + rebind-safe SSRF validation — and
 *     returns a PINNED IP we dial directly (no re-resolution → no rebind TOCTOU);
 *   - `secure:false` (587/2525) forces STARTTLS (`requireTLS`) so credentials
 *     never cross the wire in the clear;
 *   - the password is never logged and never placed on any result/error boundary.
 * Never throws — a denied dial / bad config / send failure returns a structured
 * `{ sent:false, error }` (the adapter's graceful posture).
 */

import nodemailer from 'nodemailer';
import type { EmailAdapterDeps, EmailSendArgs, EmailSendResult } from './emailAdapter.js';
import { assertSmtpDialAllowed } from './smtpEgress.js';
import { resolveConnectionCredential } from '../features/connections/connectionsService.js';
import { stampConnectionUse } from './connectionInjection.js';
import { recordSend } from './emailSentLedger.js';
import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';

const log = createLogger('connections.email.smtp');

/** The sealed connection secret for an `smtp` provider: the dial target + auth.
 *  host/port are not secret, but sealing them with the password (one BYOK
 *  envelope, the oauth2 token-blob precedent) is free defense-in-depth and needs
 *  no `Connection`-schema field. */
interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

function parseSmtpConfig(secret: string): SmtpConfig | null {
  let raw: unknown;
  try { raw = JSON.parse(secret); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const host = typeof o.host === 'string' ? o.host.trim() : '';
  const port = typeof o.port === 'number' ? o.port : Number(o.port);
  const user = typeof o.user === 'string' ? o.user : '';
  const pass = typeof o.pass === 'string' ? o.pass : '';
  if (!host || !Number.isInteger(port) || !user || !pass) return null;
  return { host, port, secure: o.secure !== false, user, pass };
}

/** The dial options handed to the transport — a compatible subset of nodemailer's
 *  `SMTPTransport.Options`, declared as our own type so tests need no nodemailer
 *  types and there is no `as`-cast at the seam. */
export interface SmtpDialOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  /** TLS SNI / cert name. TOP-LEVEL on purpose — nodemailer reads
   *  `options.servername` (smtp-connection/index.js), not `tls.servername`, to set
   *  the SNI + `checkServerIdentity` name when we dial a pinned IP. */
  servername?: string;
}
export interface SmtpMessage {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}
/** Minimal transporter shape — lets tests inject a fake instead of a socket. */
export interface SmtpTransport { sendMail(msg: SmtpMessage): Promise<{ messageId?: string }>; }
export type SmtpTransportFactory = (opts: SmtpDialOptions) => SmtpTransport;

const defaultTransportFactory: SmtpTransportFactory = (opts) => {
  const transporter = nodemailer.createTransport(opts);
  return { sendMail: (msg) => transporter.sendMail(msg).then((info) => ({ messageId: info.messageId })) };
};

/**
 * Send `args` over SMTP as the resolved `smtp` connection. `ledgerKey` is the
 * fork-stable key the caller already checked (miss) — we `recordSend` on accept.
 * `makeTransport` is injectable for tests (default: nodemailer over TCP).
 */
export async function sendViaSmtp(
  deps: EmailAdapterDeps,
  args: EmailSendArgs,
  ledgerKey: string,
  makeTransport: SmtpTransportFactory = defaultTransportFactory,
): Promise<EmailSendResult> {
  const provider = 'smtp';
  const resolved = await resolveConnectionCredential({
    tenantId: deps.tenantId,
    provider,
    ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  });
  if (!resolved) return { sent: false, provider, error: 'email_not_connected' };

  const cfg = parseSmtpConfig(resolved.secret);
  if (!cfg) return { sent: false, provider, error: 'smtp_config_invalid' };

  // TCP-egress firewall BEFORE any socket. Denied host/port/address → graceful
  // not-sent (never a throw across the adapter boundary).
  let pinned;
  try {
    pinned = await assertSmtpDialAllowed(deps.tenantId, cfg.host, cfg.port);
  } catch (err) {
    if (err instanceof OpenwopError && err.code === 'egress_blocked') return { sent: false, provider, error: 'email_egress_blocked' };
    return { sent: false, provider, error: 'email_request_failed' };
  }

  // Dial the PINNED IP directly (no re-resolution). Keep the hostname as the TLS
  // SNI / cert name; if the operator configured an IP, there is no name to pin.
  const servername = cfg.host !== pinned.address ? cfg.host : undefined;
  const transport = makeTransport({
    host: pinned.address,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure, // 587/2525 → force STARTTLS, never plaintext auth
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    ...(servername ? { servername } : {}),
  });

  const msg: SmtpMessage = {
    from: args.from,
    to: args.to,
    subject: args.subject,
    ...(args.cc !== undefined ? { cc: args.cc } : {}),
    ...(args.bcc !== undefined ? { bcc: args.bcc } : {}),
    ...(args.text !== undefined ? { text: args.text } : {}),
    ...(args.html !== undefined ? { html: args.html } : {}),
    ...(args.replyTo ? { replyTo: args.replyTo } : {}),
  };
  let info: { messageId?: string };
  try {
    info = await transport.sendMail(msg);
  } catch (err) {
    // NEVER log the password / auth. Record only the host + a coarse reason.
    log.warn('smtp send failed', { host: cfg.host, port: cfg.port, reason: err instanceof Error ? err.name : 'error' });
    return { sent: false, provider, error: 'email_request_failed' };
  }

  const messageId = info.messageId ?? '';
  await stampConnectionUse(deps.storage, deps.runId, resolved.provenance);
  await recordSend({ key: ledgerKey, tenantId: deps.tenantId, provider, messageId, createdAt: new Date().toISOString() });
  return { sent: true, provider, messageId };
}
