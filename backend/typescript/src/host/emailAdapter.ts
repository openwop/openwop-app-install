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

import { createHash } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import { stampConnectionUse } from './connectionInjection.js';
import { brokeredPost, type AuthScheme, type BrokeredEgressDeps } from './brokeredEgress.js';
import { priorSend, recordSend, reserveSend, releaseSend } from './emailSentLedger.js';
import { sendViaSmtp } from './smtpSend.js';
import { consultRecipientEgressGuard, type EgressPurpose } from './recipientEgressGuard.js';

// ADR 0655 D8 — a ledger reservation older than this is a crashed send, not an
// in-flight one; it is released on read so the retry can reach the provider.
function reservationStaleMs(): number { const n = Number(process.env.OPENWOP_EMAIL_RESERVATION_STALE_S ?? 300); return Number.isFinite(n) && n > 0 ? n * 1000 : 300_000; }
const LOSER_REREAD_WAIT_MS = 250;

const log = createLogger('connections.email');

/**
 * Idempotency / sent-ledger (ADR 0193 Phase 1) — mirrors the `ads:dispatch`
 * pattern (`adsAdapter.ts`): a send is a non-idempotent side effect, so a
 * replay / `:fork` / retry MUST NOT re-send. The canonical `email-send`
 * integration node derives a fork-stable `idempotencyKey` from
 * `(nodeId, recipients, subject, body)` — no runId (WF-EM-6), so a `:fork`
 * (new runId) derives the SAME key and we dedup on it (tenant-prefixed for
 * defence-in-depth). SendGrid/Postmark have no native idempotency, so this
 * host ledger is the guard.
 *
 * Retention: one row per accepted send, keyed by the fork-stable idempotency
 * key — bounded per (run, node), unbounded in aggregate (same accepted posture
 * as `ads:dispatch`, which also has no sweep). The retention sweep
 * (`sweepExpiredEmailSent`, `OPENWOP_EMAIL_LEDGER_TTL_DAYS`) EXISTS and runs on the
 * webhook-worker tick — EM-26 corrected the line here that called it a follow-up.
 */
/** Tenant-prefixed, fork-stable ledger key. Prefer the node-supplied
 *  `idempotencyKey` (fork-stable, `(nodeId, content)`-anchored — WF-EM-6); else
 *  derive a run-scoped content key so a re-dispatch dedups but a genuinely-new
 *  send is not wrongly suppressed. NB: the fallback IS run-scoped (has `deps.runId`)
 *  and is only reached for callers that supply no key — the email-send node always
 *  supplies one, so its dedup is fork-stable via the node key, not this fallback. */
function ledgerKey(deps: EmailAdapterDeps, provider: string, args: EmailSendArgs): string {
  const base = args.idempotencyKey
    ?? createHash('sha256')
      .update(JSON.stringify([deps.runId, provider, normalizeAddrs(args.to), args.subject, hashBody(args)]))
      .digest('hex');
  return `${deps.tenantId}:${base}`;
}
const normalizeAddrs = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim().toLowerCase()).sort();
const hashBody = (args: EmailSendArgs): string =>
  createHash('sha256').update(`${args.text ?? ''}\u0000${args.html ?? ''}`).digest('hex').slice(0, 16);

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
  /** ADR 0655 D1 — what this message IS. The adapter default for an ABSENT value is
   *  `'marketing'` (the only fail-closed choice — review B2); every caller declares. */
  purpose?: EgressPurpose;
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

/** Postmark base — overridable for tests / a Postmark-compatible proxy. */
function postmarkBase(): string {
  return (process.env.OPENWOP_POSTMARK_API_BASE ?? 'https://api.postmarkapp.com').replace(/\/+$/, '');
}
const toCsv = (v: string | string[] | undefined): string | undefined =>
  v === undefined ? undefined : (Array.isArray(v) ? v.join(',') : v);
/** Postmark `POST /email` body (a different shape than SendGrid's v3). */
function postmarkBody(args: EmailSendArgs): Record<string, unknown> {
  return {
    From: args.from,
    To: toCsv(args.to),
    ...(args.cc !== undefined ? { Cc: toCsv(args.cc) } : {}),
    ...(args.bcc !== undefined ? { Bcc: toCsv(args.bcc) } : {}),
    Subject: args.subject,
    ...(args.text !== undefined ? { TextBody: args.text } : {}),
    ...(args.html !== undefined ? { HtmlBody: args.html } : {}),
    ...(args.replyTo ? { ReplyTo: args.replyTo } : {}),
    MessageStream: 'outbound',
  };
}

/**
 * One transactional provider's send contract. Each is an api_key Connection
 * (RFC 0095) reached over the brokered-egress spine — the auth scheme /
 * header / body shape / accept parsing differ per provider, so the table is
 * the single place a new provider slots in (ADR 0193 Phase 1). SES is a
 * deliberate NON-fit: it authenticates with AWS SigV4 request signing, which
 * is not a static header the broker injects — a SES row needs a signer in this
 * adapter, tracked as a follow-up, not Phase 1.
 */
interface ProviderSpec {
  /** A thunk — the base URL is read at SEND time, not module load, so a test /
   *  proxy env override (OPENWOP_*_API_BASE) takes effect. */
  url: () => string;
  body: (args: EmailSendArgs) => string;
  contentType: string;
  authScheme: AuthScheme;
  authHeaderName?: string;
  /** Provider "accepted" → the message id; null when the response is a failure. */
  accept: (status: number, headers: Headers, json: unknown) => string | null;
}

const PROVIDERS: Record<string, ProviderSpec> = {
  sendgrid: {
    url: () => `${sendgridBase()}/v3/mail/send`,
    body: (a) => JSON.stringify(sendgridBody(a)),
    contentType: 'application/json',
    authScheme: 'bearer',
    // 202 + empty body + X-Message-Id header.
    accept: (status, headers) => (status === 202 ? headers.get('x-message-id') ?? '' : null),
  },
  postmark: {
    url: () => `${postmarkBase()}/email`,
    body: (a) => JSON.stringify(postmarkBody(a)),
    contentType: 'application/json',
    // Postmark's token rides a custom header, not Authorization: Bearer.
    authScheme: 'raw',
    authHeaderName: 'X-Postmark-Server-Token',
    // 200 + { MessageID, ErrorCode: 0 }.
    accept: (status, _h, json) => {
      const j = (json ?? {}) as { MessageID?: unknown; ErrorCode?: unknown };
      return status === 200 && j.ErrorCode === 0 && typeof j.MessageID === 'string' ? j.MessageID : null;
    },
  },
};

/** Host default provider (ADR 0193 open question — resolved yes): an SES-less,
 *  Postmark-only host can set `OPENWOP_EMAIL_DEFAULT_PROVIDER=postmark` so a
 *  template's `email-send` with no `config.provider` picks it, not `sendgrid`. */
/** Providers the adapter can send through. The HTTP `PROVIDERS` table PLUS the
 *  ADR 0199 `smtp` transport (which is NOT an HTTP `ProviderSpec` — it dials over
 *  TCP via `smtpSend`). */
const SMTP_PROVIDER = 'smtp';
function isKnownProvider(p: string): boolean {
  return p === SMTP_PROVIDER || Boolean(PROVIDERS[p]);
}

function defaultProvider(): string {
  const p = process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER;
  return p && isKnownProvider(p) ? p : 'sendgrid';
}

/** The providers the send table supports, HOST DEFAULT FIRST — consumers that
 *  auto-pick a provider (the campaign path resolves whichever the acting user has
 *  a Connection for) iterate in this order, so adding a row automatically widens
 *  them (ADR 0193 Phase 1). Includes the ADR 0199 `smtp` transport. */
export function emailSendProviders(): readonly string[] {
  const def = defaultProvider();
  const all = [...Object.keys(PROVIDERS), SMTP_PROVIDER];
  return [def, ...all.filter((p) => p !== def)];
}

export function makeEmailAdapter(deps: EmailAdapterDeps): EmailAdapter {
  return {
    async send(args) {
      const provider = args.provider ?? defaultProvider();
      if (!isKnownProvider(provider)) return { sent: false, provider, error: 'email_provider_unsupported' };

      // ADR 0193 Phase 1 — dedup BEFORE the provider call (HTTP or SMTP): a replay
      // / :fork / retry of the same node returns the recorded send, never a second
      // email.
      const key = ledgerKey(deps, provider, args);
      const prior = await priorSend(key);
      if (prior) {
        // ADR 0655 D8 — a reservation (empty messageId) is IN-FLIGHT, not sent. It
        // used to read as a delivery: a crash between reserve and accept left it for
        // the ledger TTL and "Continue sending" reported the contact delivered
        // without a provider call, terminally. Stale reservations are released so
        // the retry reaches the provider; fresh ones answer retryable in-flight.
        if (prior.messageId !== '') return { sent: true, provider, messageId: prior.messageId };
        const age = Date.now() - Date.parse(prior.createdAt);
        if (!(age >= 0 && age < reservationStaleMs())) { await releaseSend(key); }
        else return { sent: false, provider, error: 'email_send_in_flight' };
      }

      // ADR 0655 D1 — the egress floor, at the ONE owner every lane shares. After the
      // ledger short-circuit (a prior send is a recorded fact) and BEFORE the
      // reservation (a refusal must never hold one). All-or-nothing per message.
      const purpose: EgressPurpose = args.purpose ?? 'marketing';
      const addresses = [...normalizeAddrs(args.to), ...normalizeAddrs(args.cc), ...normalizeAddrs(args.bcc)];
      const verdict = await consultRecipientEgressGuard({ channel: 'email', tenantId: deps.tenantId, addresses, purpose });
      if (!verdict.ok) {
        log.info('email_egress_refused', { tenantId: deps.tenantId, purpose, code: verdict.code, refused: verdict.refused, recipients: addresses.length });
        return { sent: false, provider, error: verdict.code };
      }

      // DEF-3 — cross-instance guard: node execution is sequential per run, but a
      // ROUTE-driven send (org invites) can race the same key across instances /
      // parallel requests. Atomically RESERVE via the ledger CAS; the loser treats
      // the winner's in-flight send as the send. Every failure path below (and in
      // sendViaSmtp's wrapper) releases the reservation so an ordinary failure
      // still retry-re-sends (the ADR 0193 put-on-accept posture).
      if ((await reserveSend({ key, tenantId: deps.tenantId, provider, messageId: '', createdAt: new Date().toISOString() })) === 'duplicate') {
        // ADR 0655 D8 — the loser used to claim the winner's RESERVATION as a send;
        // if the winner then failed and released, the loser had already written
        // 'sent'. Re-read once after a bounded wait; only an ACCEPTED row is a send.
        await new Promise((r) => setTimeout(r, LOSER_REREAD_WAIT_MS));
        const winner = await priorSend(key);
        if (winner && winner.messageId !== '') return { sent: true, provider, messageId: winner.messageId };
        return { sent: false, provider, error: 'email_send_in_flight' };
      }

      // ADR 0199 — SMTP is a TCP transport, not an HTTP `ProviderSpec`. Dispatch
      // to the isolated `smtpSend` module (shares this ledger + stampConnectionUse).
      if (provider === SMTP_PROVIDER) {
        try {
          const out = await sendViaSmtp(deps, args, key);
          if (!out.sent) await releaseSend(key);
          return out;
        } catch (err) {
          await releaseSend(key);
          throw err;
        }
      }

      const spec = PROVIDERS[provider]!;
      const r = await brokeredPost(deps, {
        provider,
        url: spec.url(),
        body: spec.body(args),
        contentType: spec.contentType,
        authScheme: spec.authScheme,
        ...(spec.authHeaderName ? { authHeaderName: spec.authHeaderName } : {}),
      });
      if (r.outcome === 'no_connection') { await releaseSend(key); return { sent: false, provider, error: 'email_not_connected' }; }
      if (r.outcome === 'insecure_base') { await releaseSend(key); return { sent: false, provider, error: 'insecure_email_base' }; }
      if (r.outcome === 'request_failed') { await releaseSend(key); return { sent: false, provider, error: r.timedOut ? 'email_timeout' : 'email_request_failed' }; }

      // Read the body once (some providers return JSON on accept, some on error).
      let json: unknown;
      try { json = await r.res.json(); } catch { /* empty/non-JSON body (SendGrid 202) */ }
      const messageId = spec.accept(r.res.status, r.res.headers, json);
      if (messageId !== null) {
        await stampConnectionUse(deps.storage, deps.runId, r.provenance); // stamp on success only
        await recordSend({ key, tenantId: deps.tenantId, provider, messageId, createdAt: new Date().toISOString() });
        return { sent: true, provider, messageId };
      }

      // Surface the provider's structured error; fall back to the status code.
      let detail = `HTTP ${r.res.status}`;
      const j = (json ?? {}) as { errors?: Array<{ message?: string }>; Message?: string };
      if (j.errors?.[0]?.message) detail = j.errors[0].message;      // SendGrid
      else if (typeof j.Message === 'string') detail = j.Message;    // Postmark
      log.warn('email send failed', { provider, status: r.res.status });
      await releaseSend(key); // failed send never blocks a retry (put-on-accept)
      return { sent: false, provider, error: detail };
    },
  };
}
