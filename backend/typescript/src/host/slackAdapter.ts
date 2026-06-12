/**
 * Slack egress adapter — `ctx.slack.postMessage` for the
 * `core.openwop.integration.slack-message` node (ADR 0024 §4 Phase 3). The host
 * resolves the run's acting human's Slack Connection through the broker and calls
 * Slack `chat.postMessage` with the token — so a workflow posts to Slack AS the
 * connected user/org, never with an author-embedded secret.
 *
 * Like the http egress seam (Option C), this composes the broker rather than
 * adding I/O: the credential is host-resolved + injected, `connections:use` is
 * enforced for org connections (fail-closed), the token never lands in node
 * config / events / the run doc / a log, and every use stamps RFC 0079
 * provenance on `run.metadata.connectionUse[]`. No Slack connection ⇒ a graceful
 * `{ ok:false }` (the node reports `posted:false`), never a throw.
 */

import { createLogger } from '../observability/logger.js';
import { stampConnectionUse } from './connectionInjection.js';
import { brokeredPost, type BrokeredEgressDeps } from './brokeredEgress.js';

const log = createLogger('connections.slack');

/** Slack API base — overridable for tests / a Slack-compatible proxy. */
function chatPostMessageBase(): string {
  return (process.env.OPENWOP_SLACK_API_BASE ?? 'https://slack.com').replace(/\/+$/, '');
}

export type SlackAdapterDeps = BrokeredEgressDeps;

/** Args the integration pack passes to `ctx.slack.postMessage`. */
export interface SlackPostArgs {
  channel: string;
  text: string;
  blocks?: unknown;
  threadTs?: string;
  broadcast?: boolean;
  workspace?: string;
  asUser?: boolean;
  idempotencyKey?: string;
}
export interface SlackPostResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export interface SlackAdapter {
  postMessage(args: SlackPostArgs): Promise<SlackPostResult>;
}

export function makeSlackAdapter(deps: SlackAdapterDeps): SlackAdapter {
  return {
    async postMessage(args) {
      // `workspace` / `asUser` are accepted by the node but NOT honored: the
      // connection key is UNIQUE(tenant,user,org,provider), so a user has exactly
      // one `slack` connection (nothing for `workspace` to disambiguate), and the
      // post identity is fixed by whichever token that connection holds. Both
      // become meaningful only if multi-workspace connections land later.
      const body: Record<string, unknown> = { channel: args.channel, text: args.text };
      if (args.blocks !== undefined) body.blocks = args.blocks;
      if (args.threadTs !== undefined) body.thread_ts = args.threadTs;
      if (args.broadcast !== undefined) body.reply_broadcast = args.broadcast;

      const r = await brokeredPost(deps, { provider: 'slack', url: `${chatPostMessageBase()}/api/chat.postMessage`, body: JSON.stringify(body) });
      if (r.outcome === 'no_connection') return { ok: false, error: 'slack_not_connected' };
      if (r.outcome === 'insecure_base') return { ok: false, error: 'insecure_slack_base' };
      if (r.outcome === 'request_failed') return { ok: false, error: r.timedOut ? 'slack_timeout' : 'slack_request_failed' };

      // Slack returns HTTP 200 with `{ok:false, error}` on failure.
      let json: { ok?: boolean; ts?: string; channel?: string; error?: string };
      try {
        json = (await r.res.json()) as typeof json;
      } catch {
        return { ok: false, error: 'slack_bad_response' };
      }
      if (json.ok) {
        await stampConnectionUse(deps.storage, deps.runId, r.provenance); // stamp on success only
        return { ok: true, ...(json.ts ? { ts: json.ts } : {}), ...(json.channel ? { channel: json.channel } : {}) };
      }
      log.warn('slack chat.postMessage failed', { error: json.error });
      return { ok: false, error: json.error ?? 'slack_post_failed' };
    },
  };
}
