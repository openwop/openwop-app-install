/**
 * Inbound provider webhooks (ADR 0024 §6 / Phase C). A provider that PUSHES
 * events (Slack Events API today) delivers them to a per-connection public URL;
 * the host verifies the provider signature, then rides the EXISTING RFC 0083
 * trigger bridge — keyed by `connectionId` — to start a per-tenant workflow run.
 * An inbound integration is therefore a *subscription*, not a new ingestion
 * subsystem (the ADR's design rule).
 *
 * SECURITY POSTURE
 *   - The public ingest endpoint (`/connections-inbound/:connectionId`) carries
 *     NO host credential — the provider signature IS the credential (the same
 *     posture as the published-site / share-link public surfaces). Tenant comes
 *     from the stored inbound config, never the request.
 *   - The signing secret is host-side, KMS-enveloped via the BYOK envelope under
 *     `connection-inbound:<connectionId>` — never returned on any response.
 *   - Signature verification is constant-time (`timingSafeEqual`) and rejects a
 *     stale timestamp (replay window) BEFORE doing any work.
 *   - Configuring inbound is admin/owner-gated at the route boundary (the same
 *     `authorizeManage` guard as revoke/test); only the resulting public ingest
 *     is unauthenticated.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { setSecret, resolveSecret, removeSecret } from '../../byok/secretResolver.js';
import { createLogger } from '../../observability/logger.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { deliver, registerSubscription, setSubscriptionState, makeDedupKey } from '../../host/triggerBridgeService.js';
import { getConnection } from './connectionsService.js';

const log = createLogger('connections.inbound');

/** Providers whose push-event signature scheme this host can verify. Slack is the
 *  realistic Events-API pusher; others fall through to `unsupported`. */
export type InboundProvider = 'slack';

/** Slack rejects (and we reject) a callback whose timestamp is older than this —
 *  the standard replay window. */
const SLACK_REPLAY_WINDOW_MS = 5 * 60_000;

export interface InboundConfig {
  connectionId: string;
  tenantId: string;
  provider: string;
  /** The workflow a verified inbound event starts. */
  workflowId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const store = new DurableCollection<InboundConfig>('connections:inbound', (c) => c.connectionId);
const signingSecretRef = (connectionId: string): string => `connection-inbound:${connectionId}`;
/** The trigger-bridge subscription id for one connection's inbound stream. */
const subscriptionIdFor = (connectionId: string): string => `host:connections:${connectionId}`;

/** Only Slack is wired today; keep the check in one place. */
export function inboundSupported(provider: string): provider is InboundProvider {
  return provider === 'slack';
}

export async function getInboundConfig(tenantId: string, connectionId: string): Promise<InboundConfig | null> {
  const c = await store.get(connectionId);
  return c && c.tenantId === tenantId ? c : null;
}

/**
 * Configure (or re-configure) inbound delivery for a connection: persist the
 * signing secret KMS-enveloped, store the non-secret config, and register the
 * trigger-bridge subscription. Idempotent — re-calling rotates the secret +
 * updates the workflow.
 */
export async function setInboundConfig(input: {
  tenantId: string;
  connectionId: string;
  provider: string;
  workflowId: string;
  signingSecret: string;
}): Promise<InboundConfig> {
  const existing = await store.get(input.connectionId);
  const config: InboundConfig = {
    connectionId: input.connectionId,
    tenantId: input.tenantId,
    provider: input.provider,
    workflowId: input.workflowId,
    enabled: true,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await setSecret(signingSecretRef(input.connectionId), input.signingSecret, { tenantId: input.tenantId });
  await store.put(config);
  await registerSubscription({
    subscriptionId: subscriptionIdFor(input.connectionId),
    tenantId: input.tenantId,
    source: 'webhook',
    label: `inbound:${input.provider}:${input.connectionId}`,
  });
  return config;
}

export async function removeInboundConfig(tenantId: string, connectionId: string): Promise<boolean> {
  const existing = await getInboundConfig(tenantId, connectionId);
  if (!existing) return false;
  await removeSecret(signingSecretRef(connectionId), { tenantId }).catch(() => undefined);
  // Pause the trigger-bridge subscription so it stops accepting deliveries —
  // leaves the delivery history queryable rather than hard-deleting it.
  await setSubscriptionState(subscriptionIdFor(connectionId), 'paused').catch(() => undefined);
  return store.delete(connectionId);
}

/** Verify a Slack request signature (`v0=<hmac>` over `v0:${ts}:${rawBody}`),
 *  constant-time, with the replay-window check. Returns a typed reason on
 *  failure so the caller can choose the status without leaking detail. */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  now: number;
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'stale' | 'bad_signature' } {
  const { timestampHeader, signatureHeader } = input;
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'missing_headers' };
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(input.now - ts * 1000) > SLACK_REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'stale' };
  }
  const expected = `v0=${createHmac('sha256', input.signingSecret).update(`v0:${timestampHeader}:${input.rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

export type InboundOutcome =
  | { status: 'challenge'; challenge: string }
  | { status: 'accepted'; runId: string | null; deduped: boolean }
  | { status: 'ignored' }
  | { status: 'not_found' }
  | { status: 'unauthorized' };

/**
 * Handle one verified inbound provider callback (Slack today). Resolves the
 * connection's inbound config + signing secret, verifies the signature, answers
 * Slack's `url_verification` handshake, dedups on the provider event id, and
 * fires the configured workflow through the trigger bridge. Pure of Express —
 * the route adapter maps the outcome to a status code.
 */
export async function handleInboundEvent(
  deps: StartRunDeps,
  input: {
    connectionId: string;
    rawBody: string;
    body: Record<string, unknown>;
    headers: { timestamp?: string; signature?: string };
    now: number;
  },
): Promise<InboundOutcome> {
  const config = await store.get(input.connectionId);
  // Not-configured (or disabled) is indistinguishable from not-found on purpose —
  // an inbound URL for an unconfigured connection reveals nothing.
  if (!config || !config.enabled) return { status: 'not_found' };
  if (!inboundSupported(config.provider)) return { status: 'not_found' };
  // The connection itself must still exist (revoking it kills inbound too).
  if (!(await getConnection(config.tenantId, input.connectionId))) return { status: 'not_found' };

  const signingSecret = await resolveSecret(signingSecretRef(input.connectionId), { tenantId: config.tenantId });
  if (signingSecret === null) {
    log.warn('inbound signing secret unavailable', { connectionId: input.connectionId });
    return { status: 'unauthorized' };
  }

  const verdict = verifySlackSignature({
    signingSecret,
    timestampHeader: input.headers.timestamp,
    signatureHeader: input.headers.signature,
    rawBody: input.rawBody,
    now: input.now,
  });
  if (!verdict.ok) {
    log.warn('inbound signature rejected', { connectionId: input.connectionId, reason: verdict.reason });
    return { status: 'unauthorized' };
  }

  // Slack's one-time endpoint-verification handshake (signed like any event).
  if (input.body.type === 'url_verification') {
    const challenge = typeof input.body.challenge === 'string' ? input.body.challenge : '';
    return { status: 'challenge', challenge };
  }
  // Only actual event callbacks fire a run; ack anything else (e.g. retries of a
  // type we don't act on) so the provider stops redelivering.
  if (input.body.type !== 'event_callback') return { status: 'ignored' };

  // Dedup on Slack's event id (stable across its retries); fall back to a body
  // hash so a malformed-but-signed event still can't double-fire within the window.
  const eventId = typeof input.body.event_id === 'string' ? input.body.event_id : undefined;
  const dedupKey = makeDedupKey(input.connectionId, eventId ?? `sha:${createHmac('sha256', signingSecret).update(input.rawBody).digest('hex')}`);

  const result = await deliver({
    subscriptionId: subscriptionIdFor(input.connectionId),
    dedupKey,
    fire: async (deliveryId) => {
      const runId = await startWorkflowRun(deps, {
        tenantId: config.tenantId,
        workflowId: config.workflowId,
        metadata: {
          inbound: {
            connectionId: input.connectionId,
            provider: config.provider,
            deliveryId,
            ...(eventId ? { eventId } : {}),
          },
        },
        inputs: { event: input.body.event ?? null },
      });
      // The bridge needs a non-empty id; a null (workflow not found) becomes a
      // sentinel so dedup still records the attempt rather than throwing.
      return runId ?? `nofire:${deliveryId}`;
    },
  });
  const runId = result.runId && !result.runId.startsWith('nofire:') ? result.runId : null;
  return { status: 'accepted', runId, deduped: result.outcome === 'deduped' || result.outcome === 'skipped' };
}

export async function __resetInboundStore(): Promise<void> {
  await store.__clear();
}
