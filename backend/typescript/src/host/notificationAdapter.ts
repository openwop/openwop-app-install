/**
 * Push-notification egress adapter — `ctx.notification.push` for the
 * `core.openwop.integration.notification-push` node (ADR 0024 §4 Phase 3 / the
 * provider model). v1 ships **Expo** (`POST /--/api/v2/push/send`, an api_key
 * Connection sent as Bearer, JSON body). Same brokered-egress spine as
 * Slack/email/SMS. No connection ⇒ graceful `{ sent:false }`, never a throw.
 */

import { createLogger } from '../observability/logger.js';
import { stampConnectionUse } from './connectionInjection.js';
import { brokeredPost, type BrokeredEgressDeps } from './brokeredEgress.js';
import { egressLedgerKey, priorSend, reserveSend, recordSend, releaseSend } from './egressSentLedger.js';

const log = createLogger('connections.notification');

export type NotificationAdapterDeps = BrokeredEgressDeps;

export interface NotificationPushArgs {
  provider?: string;
  deviceToken: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** ADR 0619 — fork-stable, `(nodeId, content)`-anchored key from the send node.
   *  When present, a within-run `config.retry` re-run or cross-run re-dispatch dedups
   *  against `egressSentLedger` instead of re-POSTing. Absent ⇒ pre-ADR behaviour. */
  idempotencyKey?: string;
}
export interface NotificationPushResult {
  sent: boolean;
  id?: string;
  provider: string;
  error?: string;
}

export interface NotificationAdapter {
  push(args: NotificationPushArgs): Promise<NotificationPushResult>;
}

/** Expo push base — overridable for tests / a proxy. */
function expoBase(): string {
  return (process.env.OPENWOP_EXPO_API_BASE ?? 'https://exp.host').replace(/\/+$/, '');
}

export function makeNotificationAdapter(deps: NotificationAdapterDeps): NotificationAdapter {
  return {
    async push(args) {
      const provider = args.provider ?? 'expo';
      if (provider !== 'expo') return { sent: false, provider, error: 'notification_provider_unsupported' };

      const sendOnce = async (): Promise<NotificationPushResult> => {
        const body = JSON.stringify({ to: args.deviceToken, title: args.title, body: args.body, ...(args.data ? { data: args.data } : {}) });
        const r = await brokeredPost(deps, { provider, url: `${expoBase()}/--/api/v2/push/send`, body });
        if (r.outcome === 'no_connection') return { sent: false, provider, error: 'notification_not_connected' };
        if (r.outcome === 'insecure_base') return { sent: false, provider, error: 'insecure_notification_base' };
        if (r.outcome === 'request_failed') return { sent: false, provider, error: r.timedOut ? 'notification_timeout' : 'notification_request_failed' };

        let json: { data?: { status?: string; id?: string; message?: string } };
        try {
          json = (await r.res.json()) as typeof json;
        } catch {
          return { sent: false, provider, error: 'notification_bad_response' };
        }
        // Expo returns 200 + `{data:{status:'ok'|'error', id, message?}}`.
        if (json.data?.status === 'ok') {
          await stampConnectionUse(deps.storage, deps.runId, r.provenance);
          return { sent: true, provider, ...(json.data.id ? { id: json.data.id } : {}) };
        }
        log.warn('expo push failed', { status: r.res.status, expoStatus: json.data?.status });
        return { sent: false, provider, error: json.data?.message ?? `HTTP ${r.res.status}` };
      };

      // ADR 0619 — dedup a within-run `config.retry` re-run / cross-run re-dispatch
      // against the egress ledger. Absent key ⇒ pre-ADR behaviour (unguarded).
      const key = args.idempotencyKey ? egressLedgerKey(deps.tenantId, 'push', args.idempotencyKey) : null;
      if (key) {
        const prior = await priorSend(key);
        if (prior) return { sent: true, provider, ...(prior.providerRef ? { id: prior.providerRef } : {}) };
        if ((await reserveSend({ key, tenantId: deps.tenantId, channel: 'push', provider, providerRef: '', createdAt: new Date().toISOString() })) === 'duplicate') {
          const winner = await priorSend(key);
          return { sent: true, provider, ...(winner?.providerRef ? { id: winner.providerRef } : {}) };
        }
      }
      const result = await sendOnce();
      if (key) {
        if (result.sent) await recordSend({ key, tenantId: deps.tenantId, channel: 'push', provider, providerRef: result.id ?? '', createdAt: new Date().toISOString() });
        else await releaseSend(key); // failed send never blocks a retry (put-on-accept)
      }
      return result;
    },
  };
}
