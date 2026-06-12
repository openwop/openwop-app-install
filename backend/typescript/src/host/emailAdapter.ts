/**
 * Email egress adapter — `ctx.email.send` for the
 * `core.openwop.integration.email-send` node (ADR 0024 §4 Phase 3 / the
 * email-provider model). Email providers are **api_key Connections** (not OAuth):
 * the host resolves the run's acting human's connection for the node's
 * `config.provider` and calls that provider's REST send API with the key as a
 * Bearer token — the same brokered-egress spine as Slack.
 *
 * v1 ships **SendGrid** (`POST /v3/mail/send`, `Authorization: Bearer <api_key>`,
 * 202-on-accept) as the concrete reference; SES / Mailgun / Postmark / raw SMTP
 * are future provider manifests + a branch here. No connection ⇒ a graceful
 * `{ sent:false }` (the node reports `sent:false`), never a throw.
 */

import { createLogger } from '../observability/logger.js';
import { stampConnectionUse } from './connectionInjection.js';
import { brokeredPost, type BrokeredEgressDeps } from './brokeredEgress.js';

const log = createLogger('connections.email');

export type EmailAdapterDeps = BrokeredEgressDeps;

/** Args the integration pack passes to `ctx.email.send`. */
export interface EmailSendArgs {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  /** The email provider to send through (node `config.provider`). */
  provider?: string;
  fallbackOnFailure?: boolean;
  idempotencyKey?: string;
}
export interface EmailSendResult {
  sent: boolean;
  messageId?: string;
  provider: string;
  error?: string;
}

export interface EmailAdapter {
  send(args: EmailSendArgs): Promise<EmailSendResult>;
}

/** SendGrid base — overridable for tests / a SendGrid-compatible proxy. */
function sendgridBase(): string {
  return (process.env.OPENWOP_SENDGRID_API_BASE ?? 'https://api.sendgrid.com').replace(/\/+$/, '');
}

const toAddrs = (v: string | string[] | undefined): Array<{ email: string }> =>
  (Array.isArray(v) ? v : v ? [v] : []).map((email) => ({ email }));

/** Build the SendGrid v3 mail/send body from the node args. */
function sendgridBody(args: EmailSendArgs): Record<string, unknown> {
  const content: Array<{ type: string; value: string }> = [];
  if (args.text !== undefined) content.push({ type: 'text/plain', value: args.text });
  if (args.html !== undefined) content.push({ type: 'text/html', value: args.html });
  if (content.length === 0) content.push({ type: 'text/plain', value: '' });
  const personalization: Record<string, unknown> = { to: toAddrs(args.to) };
  if (args.cc !== undefined) personalization.cc = toAddrs(args.cc);
  if (args.bcc !== undefined) personalization.bcc = toAddrs(args.bcc);
  return {
    personalizations: [personalization],
    from: { email: args.from },
    ...(args.replyTo ? { reply_to: { email: args.replyTo } } : {}),
    subject: args.subject,
    content,
  };
}

export function makeEmailAdapter(deps: EmailAdapterDeps): EmailAdapter {
  return {
    async send(args) {
      // Defaults to 'sendgrid' when the node sets no `config.provider` — the only
      // provider wired in v1. A multi-provider deployment would set it explicitly
      // (or the host could read a default-provider env).
      const provider = args.provider ?? 'sendgrid';
      // v1 supports SendGrid concretely; other providers are a future manifest +
      // a branch here (the model generalizes — they're all api_key Connections).
      if (provider !== 'sendgrid') {
        return { sent: false, provider, error: 'email_provider_unsupported' };
      }

      const r = await brokeredPost(deps, { provider, url: `${sendgridBase()}/v3/mail/send`, body: JSON.stringify(sendgridBody(args)) });
      if (r.outcome === 'no_connection') return { sent: false, provider, error: 'email_not_connected' };
      if (r.outcome === 'insecure_base') return { sent: false, provider, error: 'insecure_email_base' };
      if (r.outcome === 'request_failed') return { sent: false, provider, error: r.timedOut ? 'email_timeout' : 'email_request_failed' };

      // SendGrid accepts with 202 + an empty body + an `X-Message-Id` header.
      if (r.res.status === 202) {
        await stampConnectionUse(deps.storage, deps.runId, r.provenance); // stamp on success only
        const messageId = r.res.headers.get('x-message-id') ?? '';
        await r.res.body?.cancel().catch(() => undefined); // release the keep-alive connection
        return { sent: true, provider, messageId };
      }
      // Surface SendGrid's structured error; fall back to the status code.
      let detail = `HTTP ${r.res.status}`;
      try {
        const j = (await r.res.json()) as { errors?: Array<{ message?: string }> };
        if (j.errors?.[0]?.message) detail = j.errors[0].message;
      } catch {
        /* non-JSON error body */
      }
      log.warn('sendgrid mail/send failed', { status: r.res.status });
      return { sent: false, provider, error: detail };
    },
  };
}
