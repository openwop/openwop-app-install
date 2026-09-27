/**
 * SMS egress adapter — `ctx.messaging.sendSms` for the
 * `core.openwop.integration.sms-send` node (ADR 0024 §4 Phase 3 / the
 * email-notification provider model). v1 ships **Twilio**: an `api_key`/`basic`
 * Connection whose secret is the `AccountSid:AuthToken` pair, sent as HTTP Basic
 * to `Messages.json`. Same brokered-egress spine as Slack/email — the `basic`
 * auth scheme is the only new wrinkle.
 *
 * No connection ⇒ graceful `{ sent:false }`, never a throw.
 */

import { createLogger } from '../observability/logger.js';
import { stampConnectionUse } from './connectionInjection.js';
import { brokeredPost, type BrokeredEgressDeps } from './brokeredEgress.js';
import { egressLedgerKey, priorSend, reserveSend, recordSend, releaseSend } from './egressSentLedger.js';

const log = createLogger('connections.sms');

export type SmsAdapterDeps = BrokeredEgressDeps;

export interface SmsSendArgs {
  provider?: string;
  to: string;
  from: string;
  text: string;
  /** ADR 0619 — fork-stable, `(nodeId, content)`-anchored key from the send node.
   *  When present, a within-run `config.retry` re-run or cross-run re-dispatch dedups
   *  against `egressSentLedger` instead of re-POSTing. Absent ⇒ pre-ADR behaviour. */
  idempotencyKey?: string;
}
export interface SmsSendResult {
  sent: boolean;
  sid?: string;
  provider: string;
  error?: string;
}

export interface SmsAdapter {
  sendSms(args: SmsSendArgs): Promise<SmsSendResult>;
}

/** Twilio base — overridable for tests / a Twilio-compatible proxy. */
function twilioBase(): string {
  return (process.env.OPENWOP_TWILIO_API_BASE ?? 'https://api.twilio.com').replace(/\/+$/, '');
}

export function makeSmsAdapter(deps: SmsAdapterDeps): SmsAdapter {
  return {
    async sendSms(args) {
      const provider = args.provider ?? 'twilio';
      if (provider !== 'twilio') return { sent: false, provider, error: 'sms_provider_unsupported' };
      // ADR 0394 — a `whatsapp:`-prefixed recipient would make Twilio deliver a
      // WhatsApp message THROUGH the SMS path, bypassing the WhatsApp channel's
      // consent/24h-window/template gates. Fail closed; the whatsapp feature's
      // governed send is the only WhatsApp path.
      if (args.to.startsWith('whatsapp:') || args.from.startsWith('whatsapp:')) {
        return { sent: false, provider, error: 'sms_whatsapp_not_allowed' };
      }

      const sendOnce = async (): Promise<SmsSendResult> => {
        const body = new URLSearchParams({ To: args.to, From: args.from, Body: args.text }).toString();
        const r = await brokeredPost(deps, {
          provider,
          // Twilio's path embeds the AccountSid (the public half of the
          // `AccountSid:AuthToken` secret); the builder extracts only that half.
          url: (secret) => `${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(secret.split(':')[0])}/Messages.json`,
          body,
          contentType: 'application/x-www-form-urlencoded',
          authScheme: 'basic',
        });
        if (r.outcome === 'no_connection') return { sent: false, provider, error: 'sms_not_connected' };
        if (r.outcome === 'insecure_base') return { sent: false, provider, error: 'insecure_sms_base' };
        if (r.outcome === 'request_failed') return { sent: false, provider, error: r.timedOut ? 'sms_timeout' : 'sms_request_failed' };

        let json: { sid?: string; status?: string; message?: string };
        try {
          json = (await r.res.json()) as typeof json;
        } catch {
          return { sent: false, provider, error: 'sms_bad_response' };
        }
        // Twilio returns 201 + `{sid, status}` on accept; 4xx + `{message, code}`.
        if (r.res.status >= 200 && r.res.status < 300 && json.sid) {
          await stampConnectionUse(deps.storage, deps.runId, r.provenance);
          return { sent: true, provider, sid: json.sid };
        }
        log.warn('twilio sms send failed', { status: r.res.status });
        return { sent: false, provider, error: json.message ?? `HTTP ${r.res.status}` };
      };

      // ADR 0619 — dedup a within-run `config.retry` re-run / cross-run re-dispatch
      // against the egress ledger. Absent key ⇒ pre-ADR behaviour (unguarded).
      const key = args.idempotencyKey ? egressLedgerKey(deps.tenantId, 'sms', args.idempotencyKey) : null;
      if (key) {
        const prior = await priorSend(key);
        if (prior) return { sent: true, provider, sid: prior.providerRef };
        if ((await reserveSend({ key, tenantId: deps.tenantId, channel: 'sms', provider, providerRef: '', createdAt: new Date().toISOString() })) === 'duplicate') {
          const winner = await priorSend(key);
          return { sent: true, provider, sid: winner?.providerRef ?? '' };
        }
      }
      const result = await sendOnce();
      if (key) {
        if (result.sent) await recordSend({ key, tenantId: deps.tenantId, channel: 'sms', provider, providerRef: result.sid ?? '', createdAt: new Date().toISOString() });
        else await releaseSend(key); // failed send never blocks a retry (put-on-accept)
      }
      return result;
    },
  };
}
