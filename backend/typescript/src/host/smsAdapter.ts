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
import { contentHashOf, enforceCampaignAction, noticeAfterEffect } from './autonomyPolicy/enforce.js';
import { findCoveringGrant } from './autonomyPolicy/grants.js';
import { normalizeChannelAddress, suppressionCheck } from '../features/crm/suppressionService.js';
import { getSmsSender } from '../features/crm/smsSenders.js';

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
      // ADR 0955 D2 (J4) — the STOP guard sits at the EXIT, for every caller and every
      // purpose: a writer-side check only covers the writers someone remembered (the generic
      // `sms-send` node had none). The recipient must be E.164 (Twilio needs it anyway, and an
      // unparseable number could not be checked). The sender's client comes from the stored
      // binding of `from`; a number bound to no client is checked against EVERY scope of the
      // recipient (the conservative reading). An unreadable store refuses (CRM-4).
      const to = normalizeChannelAddress('sms', args.to);
      if (!to) return { sent: false, provider, error: 'sms_invalid_recipient' };
      const sender = await getSmsSender(deps.tenantId, args.from).catch(() => undefined);
      if (sender === undefined) return { sent: false, provider, error: 'sms_suppression_unreadable' };
      const stop = await suppressionCheck(deps.tenantId, { channel: 'sms', address: to, ...(sender?.orgId ? { senderOrgId: sender.orgId } : { anySender: true }) });
      if (stop === 'suppressed') return { sent: false, provider, error: 'sms_recipient_opted_out' };
      if (stop === 'unreadable') return { sent: false, provider, error: 'sms_suppression_unreadable' };

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

        let json: { sid?: string; status?: string; message?: string; code?: number };
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
        // Twilio 21610: the recipient replied STOP to this sender (Twilio's own opt-out
        // list). Named for what it is, not as a generic provider failure.
        if (json.code === 21610) return { sent: false, provider, error: 'sms_recipient_opted_out' };
        return { sent: false, provider, error: json.message ?? `HTTP ${r.res.status}` };
      };

      // ADR 0619 — dedup a within-run `config.retry` re-run / cross-run re-dispatch
      // against the egress ledger. Absent key ⇒ pre-ADR behaviour (unguarded).
      const key = args.idempotencyKey ? egressLedgerKey(deps.tenantId, 'sms', args.idempotencyKey) : null;
      if (key) {
        const prior = await priorSend(key);
        if (prior) return { sent: true, provider, sid: prior.providerRef };
      }
      // ADR 0942 D5 — the `sms.send` chokepoint, campaign-bound runs only (an
      // already-sent message above is not a new effect). Its class is decided on the
      // interrupt lane, so `approve` needs a covering grant: an approved autonomy
      // gate in THIS run for `sms.send` whose facts and content cover this send.
      const autonomy = await enforceCampaignAction(deps, {
        actionClass: 'sms.send', facts: { audienceSize: 1 }, contentHash: contentHashOf(args.text),
      });
      if (autonomy.kind === 'blocked') return { sent: false, provider, error: 'autonomy_blocked' };
      if (autonomy.kind === 'approve') {
        const grant = await findCoveringGrant(deps.storage, deps.runId, { actionClass: 'sms.send', facts: { audienceSize: 1 }, contentHash: contentHashOf(args.text) });
        if (!grant) return { sent: false, provider, error: 'autonomy_approval_required' };
      }
      if (key) {
        if ((await reserveSend({ key, tenantId: deps.tenantId, channel: 'sms', provider, providerRef: '', createdAt: new Date().toISOString() })) === 'duplicate') {
          const winner = await priorSend(key);
          return { sent: true, provider, sid: winner?.providerRef ?? '' };
        }
      }
      const result = await sendOnce();
      // ADR 0942 D7 — notify-after, once the message was accepted by the provider.
      if (result.sent) await noticeAfterEffect(deps.tenantId, autonomy, 'sms.send', `Sent an SMS to ${args.to.replace(/.(?=.{4})/g, '•')}.`);
      if (key) {
        if (result.sent) await recordSend({ key, tenantId: deps.tenantId, channel: 'sms', provider, providerRef: result.sid ?? '', createdAt: new Date().toISOString() });
        else await releaseSend(key); // failed send never blocks a retry (put-on-accept)
      }
      return result;
    },
  };
}
