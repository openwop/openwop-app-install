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

const log = createLogger('connections.notification');

export type NotificationAdapterDeps = BrokeredEgressDeps;

export interface NotificationPushArgs {
  provider?: string;
  deviceToken: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
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
    },
  };
}
