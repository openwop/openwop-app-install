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

import { createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { setSecret, resolveSecret, removeSecret } from '../../byok/secretResolver.js';
import { registerCredentialRefConsumer } from '../../host/credentialRefRegistry.js';
import { createLogger } from '../../observability/logger.js';
import { startWorkflowRun } from '../../host/runStarter.js';
import { deliver, registerSubscription, rekeySubscription, setSubscriptionState, makeDedupKey, hostDerivedSubscriptionId, type SubscriptionSource } from '../../host/triggerBridgeService.js';
import { getConnection } from './connectionsService.js';
import type { Storage } from '../../storage/storage.js';
import type { HostAdapterSuite } from '../../host/index.js';
import { resolveAndResume } from '../../routes/interrupts.js';
import { pairConnection } from './messagingOutbound.js';
import {
  ingestExternalEvent,
  streamCdcIngestionEnabled,
  type ChangeIngressInput,
  type StreamIngressInput,
} from '../../host/triggerIngestionService.js';

/** Deps the inbound handler needs — the FULL host suite (resume needs more of it than a
 *  run-start does; a full `HostAdapterSuite` also satisfies `startWorkflowRun`'s Pick). */
interface InboundDeps { storage: Storage; hostSuite: HostAdapterSuite }

/** Per-connection conversational session (ADR 0175 Phase 3): the run an inbound stream is
 *  currently "in", so a follow-up message RESUMES it instead of starting a new run. */
interface ConnectionSession { connectionId: string; activeRunId: string; updatedAt: string }
const sessions = new DurableCollection<ConnectionSession>('connections:inbound-session', (s) => s.connectionId);
const TERMINAL_RUN = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'completed']);
const nowIso = (): string => new Date().toISOString();

const log = createLogger('connections.inbound');

/** Providers whose push-event signature scheme this host can verify. Slack (HMAC),
 *  Discord (Ed25519), and Telegram (secret-token) — the Messaging Gateway trio
 *  (ADR 0175). Each is a signature-verified webhook source; the platform is
 *  host-private metadata, NOT a wire `TriggerEvent.source` (which stays `webhook`). */
export type InboundProvider = 'slack' | 'discord' | 'telegram' | 'whatsapp-twilio' | 'whatsapp-cloud' | 'zoom-webinar';

/** RFC 0127 / ADR 0286 — the streaming/CDC INGRESS provider. A broker (Kafka/Kinesis/
 *  Pub-Sub/EventBridge) or a warehouse CDC feed PUSHES a signed message/row here; the
 *  host verifies the push signature (host-side), then dispatches to `ingestExternalEvent`
 *  → a NEW run (source `stream`/`change`), NOT `resolveAndResume` (a broker message is a
 *  fresh trigger, never a HITL reply). Ingress-only — no outbound publish. */
export const STREAM_INBOUND_PROVIDER = 'core.openwop.streams';
export function isStreamInbound(provider: string): boolean {
  return provider === STREAM_INBOUND_PROVIDER;
}
/** Providers this host can CONFIGURE inbound for: the messaging trio (resolveAndResume
 *  dispatch) OR the streaming/CDC ingress provider (ingestExternalEvent dispatch). */
export function inboundConfigurable(provider: string): boolean {
  return inboundSupported(provider) || isStreamInbound(provider);
}

/** Slack rejects (and we reject) a callback whose timestamp is older than this —
 *  the standard replay window. Discord uses the same window over its Ed25519 ts. */
const SLACK_REPLAY_WINDOW_MS = 5 * 60_000;
const DISCORD_REPLAY_WINDOW_MS = 5 * 60_000;
/** Broker-push replay window (RFC 0127). The push carries an HMAC over
 *  `${timestamp}.${rawBody}`; a push older than this is rejected before any work. */
const STREAM_REPLAY_WINDOW_MS = 5 * 60_000;

/** DER SPKI prefix for an Ed25519 public key — prepended to the raw 32-byte key so
 *  Node's `createPublicKey` accepts it (the standard Discord-verify trick). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface InboundConfig {
  connectionId: string;
  tenantId: string;
  provider: string;
  /** The workflow a verified inbound event starts. Absent for OBSERVER-ONLY
   *  providers (ADR 0404 zoom-webinar) — a feature observer processes the event
   *  instead of dispatching a workflow. */
  workflowId?: string;
  /** RFC 0127 — for the streaming/CDC ingress provider, which trigger source this
   *  connection's broker delivers (`stream` = broker message; `change` = CDC row). Fixed
   *  per connection (one topic/feed is one source); absent for the messaging providers. */
  streamSource?: 'stream' | 'change';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const store = new DurableCollection<InboundConfig>('connections:inbound', (c) => c.connectionId);
const signingSecretRef = (connectionId: string): string => `connection-inbound:${connectionId}`;
/** The trigger-bridge subscription id for one connection's inbound stream. */
// ADR 0726 — grammar-safe (was `host:connections:<connectionId>`, unbindable on the wire).
const subscriptionIdFor = (connectionId: string): string => hostDerivedSubscriptionId('connections', connectionId).id;

/** Slack / Discord / Telegram (ADR 0175) + WhatsApp via Twilio BSP (ADR 0394);
 *  keep the check in one place. */
export function inboundSupported(provider: string): provider is InboundProvider {
  return provider === 'slack' || provider === 'discord' || provider === 'telegram' || provider === 'whatsapp-twilio' || provider === 'whatsapp-cloud' || provider === 'zoom-webinar';
}

/** ADR 0404 — providers whose inbound is OBSERVER-ONLY: a verified event is
 *  processed by a feature-registered observer (CRM activities + host events),
 *  NOT dispatched to a configured workflow. So their config carries no
 *  `workflowId` and no trigger-bridge subscription. */
export function inboundObserverOnly(provider: string): boolean {
  return provider === 'zoom-webinar';
}

// ADR 0499 — `connection-inbound:<id>` is the webhook SIGNING secret. Deleting it
// does not stop deliveries; it makes every one of them fail verification, so the
// symptom is a silent inbound outage rather than an obvious misconfiguration.
registerCredentialRefConsumer({
  id: 'connections:inbound-signing',
  async describe(tenantId, ref) {
    if (!ref.startsWith('connection-inbound:')) return [];
    const config = await getInboundConfig(tenantId, ref.slice('connection-inbound:'.length));
    return config ? [`inbound webhook signing secret for connection "${config.connectionId}"`] : [];
  },
});

export async function getInboundConfig(tenantId: string, connectionId: string): Promise<InboundConfig | null> {
  const c = await store.get(connectionId);
  return c && c.tenantId === tenantId ? c : null;
}

/** PUBLIC-webhook-side config lookup (no session tenant exists on the ingest
 *  path — the config row IS the tenant authority, exactly as handleInboundEvent
 *  resolves it). ADR 0394 P4: the Meta GET-subscription handshake needs it. */
export async function getInboundConfigForWebhook(connectionId: string): Promise<InboundConfig | null> {
  return store.get(connectionId);
}

/** The connection's inbound signing secret (ADR 0394 P4 — the Meta hub.verify_token
 *  check reuses the stored app secret; never returned to any client). */
export async function resolveInboundSigningSecret(connectionId: string, tenantId: string): Promise<string | null> {
  return resolveSecret(signingSecretRef(connectionId), { tenantId });
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
  /** Absent for OBSERVER-ONLY providers (ADR 0404 zoom-webinar). */
  workflowId?: string;
  signingSecret: string;
  /** RFC 0127 — the trigger source for a streaming/CDC ingress connection (default
   *  `stream`); ignored for the messaging providers (which always ride `webhook`). */
  streamSource?: 'stream' | 'change';
}): Promise<InboundConfig> {
  const existing = await store.get(input.connectionId);
  const streamProvider = isStreamInbound(input.provider);
  const observerOnly = inboundObserverOnly(input.provider);
  const streamSource: 'stream' | 'change' = input.streamSource ?? 'stream';
  const config: InboundConfig = {
    connectionId: input.connectionId,
    tenantId: input.tenantId,
    provider: input.provider,
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(streamProvider ? { streamSource } : {}),
    enabled: true,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await setSecret(signingSecretRef(input.connectionId), input.signingSecret, { tenantId: input.tenantId });
  await store.put(config);
  // OBSERVER-ONLY providers (zoom-webinar) fire no workflow, so they register no
  // trigger-bridge subscription — the verified event is handed to a feature
  // observer inside handleInboundEvent. The messaging trio register a `webhook`
  // subscription (no workflowId — handleInboundEvent fires the run itself); a
  // streaming/CDC connection registers a `stream`/`change` subscription bound to
  // its workflow so `ingestExternalEvent` (the single ingest owner) starts the run.
  if (!observerOnly) {
    // ADR 0726 — a row registered under the legacy colon spelling moves to the
    // grammar-safe id on first use (the migration-21 pattern; never fatal).
    const legacy = hostDerivedSubscriptionId('connections', input.connectionId);
    await rekeySubscription(legacy.legacyId, legacy.id).catch(() => undefined);
    await registerSubscription({
      subscriptionId: subscriptionIdFor(input.connectionId),
      tenantId: input.tenantId,
      source: streamProvider ? (streamSource as SubscriptionSource) : 'webhook',
      label: `inbound:${input.provider}:${input.connectionId}`,
      ...(streamProvider && input.workflowId
        ? { workflowId: input.workflowId, verificationMode: 'none' as const, dedupEnabled: true }
        : {}),
    });
  }
  return config;
}

/**
 * ADR 0285 — the connections feature's OWN revoke consumer: when the underlying
 * credential is revoked, DISABLE the inbound config (never delete — the
 * user-authored provider/workflow binding survives, visibly broken, and
 * re-connecting is a resume). The trigger-bridge subscription pauses so
 * deliveries stop; the signing secret stays (it is inbound-specific, not the
 * revoked credential). Idempotent.
 */
export async function disableInboundForRevokedConnection(tenantId: string, connectionId: string): Promise<boolean> {
  const existing = await getInboundConfig(tenantId, connectionId);
  if (!existing || !existing.enabled) return false;
  await store.put({ ...existing, enabled: false, updatedAt: new Date().toISOString() });
  await setSubscriptionState(subscriptionIdFor(connectionId), 'paused').catch(() => undefined);
  return true;
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

/** Verify a Discord interaction signature: Ed25519 over `timestamp + rawBody`, the
 *  connection's "signing secret" being the Discord app's PUBLIC KEY (hex). Constant-
 *  time by construction (Ed25519 verify); rejects a stale timestamp first. */
export function verifyDiscordSignature(input: {
  publicKeyHex: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  now: number;
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'stale' | 'bad_signature' } {
  const { timestampHeader, signatureHeader } = input;
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'missing_headers' };
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(input.now - ts * 1000) > DISCORD_REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'stale' };
  }
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    const ok = cryptoVerify(null, Buffer.from(`${timestampHeader}${input.rawBody}`, 'utf8'), key, Buffer.from(signatureHeader, 'hex'));
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

/** Verify a Telegram webhook: the bot API secret token header must match the stored
 *  secret, constant-time. Telegram has no signature/timestamp — the secret token IS
 *  the credential (configured via `setWebhook`). */
export function verifyTelegramSecret(input: { expected: string; provided: string | undefined }): { ok: true } | { ok: false; reason: 'missing_headers' | 'bad_signature' } {
  if (!input.provided) return { ok: false, reason: 'missing_headers' };
  const a = Buffer.from(input.expected);
  const b = Buffer.from(input.provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/**
 * ADR 0394 — per-provider VERIFIED-inbound observers (dependency inversion, the
 * `onConnectionRevoked` pattern): a feature that needs to see verified inbound
 * events for its provider (the whatsapp 24h-window ledger) registers here from
 * its own package; connections never imports a feature. Best-effort — an
 * observer failure never blocks the dispatch.
 */
export interface VerifiedInboundEvent { tenantId: string; connectionId: string; body: Record<string, unknown>; now: number }
const inboundObservers = new Map<string, Array<(event: VerifiedInboundEvent) => Promise<void>>>();
/** ADR 0422 P2 seam upgrade — MULTIPLE observers per provider (append). The
 *  original single-slot Map silently clobbered an earlier registrant when a
 *  second feature observed the same provider (whatsapp window-ledger vs the
 *  service-desk intake). Observers stay non-blocking + fail-soft, run in
 *  registration order; re-registering the SAME fn is a no-op (idempotent boot). */
export function registerInboundObserver(provider: InboundProvider, fn: (event: VerifiedInboundEvent) => Promise<void>): void {
  const list = inboundObservers.get(provider) ?? [];
  if (!list.includes(fn)) list.push(fn);
  inboundObservers.set(provider, list);
}
async function notifyInboundObserver(provider: string, event: VerifiedInboundEvent): Promise<void> {
  const list = inboundObservers.get(provider) ?? [];
  for (const fn of list) {
    await fn(event).catch((err: unknown) => {
      log.warn('inbound observer failed', { provider, error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/**
 * ADR 0394 Phase 2 — per-provider DISPATCH gates (same inversion as the
 * observers, but blocking): a feature may refuse to fire the configured
 * workflow for a verified inbound event (the WhatsApp no-training-attestation
 * gate — message data must not reach a model path the tenant has not attested
 * for). A gate error fails CLOSED (deny). The delivery is still acked to the
 * provider (a 2xx) so it is not retried into a wall.
 */
const inboundGates = new Map<string, (event: VerifiedInboundEvent) => Promise<{ allow: true } | { allow: false; reason: string }>>();
export function registerInboundGate(provider: InboundProvider, fn: (event: VerifiedInboundEvent) => Promise<{ allow: true } | { allow: false; reason: string }>): void {
  inboundGates.set(provider, fn);
}
async function checkInboundGate(provider: string, event: VerifiedInboundEvent): Promise<{ allow: true } | { allow: false; reason: string }> {
  const fn = inboundGates.get(provider);
  if (!fn) return { allow: true };
  try {
    return await fn(event);
  } catch (err) {
    log.warn('inbound gate failed — denying (fail-closed)', { provider, error: err instanceof Error ? err.message : String(err) });
    return { allow: false, reason: 'gate_error' };
  }
}

/**
 * Verify a Twilio webhook signature (ADR 0394 — WhatsApp BSP): base64(HMAC-SHA1(
 * authToken, url + concat(sortedParamKeys.map(k => k + value)))) — Twilio's documented
 * scheme for `application/x-www-form-urlencoded` deliveries. The signing secret is the
 * connection's Twilio auth token (the private half of `AccountSid:AuthToken`).
 * Constant-time compare; Twilio sends no timestamp, so replay is bounded by the
 * MessageSid dedup downstream, not a window here.
 */
export function verifyTwilioSignature(input: {
  authToken: string;
  /** The full public URL Twilio signed (scheme + host + path + query). */
  url: string;
  /** The parsed form params (the urlencoded body). */
  params: Record<string, unknown>;
  signatureHeader: string | undefined;
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'bad_signature' } {
  if (!input.signatureHeader) return { ok: false, reason: 'missing_headers' };
  const data = input.url + Object.keys(input.params).sort().map((k) => `${k}${String(input.params[k] ?? '')}`).join('');
  const expected = createHmac('sha1', input.authToken).update(data, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signatureHeader);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/**
 * Verify a Meta Cloud API webhook signature (ADR 0394 Phase 4):
 * `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(appSecret, rawBody)>` — the
 * standard Meta scheme over the EXACT raw bytes. Constant-time; no timestamp
 * (replay bounded by message-id dedup downstream).
 */
export function verifyMetaCloudSignature(input: {
  appSecret: string;
  rawBody: string;
  signatureHeader: string | undefined;
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'bad_signature' } {
  if (!input.signatureHeader?.startsWith('sha256=')) return { ok: false, reason: 'missing_headers' };
  const expected = createHmac('sha256', input.appSecret).update(input.rawBody, 'utf8').digest('hex');
  const provided = input.signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/** Verify a broker/CDC push signature (RFC 0127): HMAC-SHA256 over `${ts}.${rawBody}`,
 *  `sha256=<hex>` or bare hex, constant-time, with the replay-window check. This is the
 *  push-ingress credential (a Pub/Sub push front, an EventBridge API-destination HMAC, or
 *  a Kafka→HTTP bridge) — verified host-side against the per-connection signing secret. */
export function verifyStreamSignature(input: {
  signingSecret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  now: number;
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'stale' | 'bad_signature' } {
  const { timestampHeader, signatureHeader } = input;
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'missing_headers' };
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(input.now - ts * 1000) > STREAM_REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'stale' };
  }
  const expected = createHmac('sha256', input.signingSecret).update(`${timestampHeader}.${input.rawBody}`).digest('hex');
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice('sha256='.length) : signatureHeader;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/** RFC 0127 — map a verified broker/CDC push body onto the typed per-source ingress the
 *  single ingest owner (`ingestExternalEvent`) consumes. The message/row body lands only
 *  in `run.metadata.triggerData` (SR-1). Returns null on an invalid CDC `op`. */
function buildStreamIngress(source: 'stream' | 'change', body: Record<string, unknown>): StreamIngressInput | ChangeIngressInput | null {
  if (source === 'stream') {
    const s = (body.stream ?? {}) as Record<string, unknown>;
    return {
      source: 'stream',
      ...(typeof s.topic === 'string' ? { topic: s.topic } : {}),
      ...(typeof s.partition === 'number' ? { partition: s.partition } : {}),
      ...(typeof s.offset === 'string' ? { offset: s.offset } : {}),
      ...(typeof s.key === 'string' ? { key: s.key } : {}),
      ...(s.message !== undefined ? { message: s.message } : {}),
    };
  }
  const c = (body.change ?? {}) as Record<string, unknown>;
  if (c.op !== 'insert' && c.op !== 'update' && c.op !== 'delete') return null;
  return {
    source: 'change',
    op: c.op,
    ...(typeof c.table === 'string' ? { table: c.table } : {}),
    ...(typeof c.changelogId === 'string' ? { changelogId: c.changelogId } : {}),
    ...(c.before !== undefined ? { before: c.before } : {}),
    ...(c.after !== undefined ? { after: c.after } : {}),
  };
}

export type InboundOutcome =
  | { status: 'challenge'; challenge: string }
  | { status: 'respond'; json: unknown }
  | { status: 'accepted'; runId: string | null; deduped: boolean }
  | { status: 'ignored' }
  | { status: 'not_found' }
  | { status: 'rejected'; reason?: string }
  | { status: 'unauthorized' };

/**
 * Host-local slash-command reply (ADR 0175 Phase 2). `/help`, `/status`, `/pair`
 * answer synchronously with NO run and NO outbound call; every other command (incl.
 * `/run`) returns `null` to fall through and fire the configured workflow through the
 * trigger bridge. Pure — no side effects — so it's replay-irrelevant (a synchronous
 * reply, not a run).
 */
export function slashReply(command: string, config: InboundConfig): string | null {
  switch (command) {
    case 'help':
      return 'Commands: `/help` (this message) · `/status` (connection state) · `/pair` (link this channel) · `/run` (start the configured workflow).';
    case 'status':
      return config.enabled
        ? `Connected — inbound is active and routes to workflow \`${config.workflowId}\`.`
        : 'Inbound is configured but currently paused.';
    case 'pair':
      return 'This channel is already linked to this workspace connection. Use `/run` to start the configured workflow.';
    default:
      return null; // /run + app-defined commands fire the workflow
  }
}

/** All provider signature/secret headers the ingest route may carry (lowercased). */
export interface InboundHeaders {
  timestamp?: string;        // slack: x-slack-request-timestamp
  signature?: string;        // slack: x-slack-signature
  discordSignature?: string; // x-signature-ed25519
  discordTimestamp?: string; // x-signature-timestamp
  telegramToken?: string;    // x-telegram-bot-api-secret-token
  streamSignature?: string;  // rfc0127 broker push: x-openwop-stream-signature
  streamTimestamp?: string;  // rfc0127 broker push: x-openwop-stream-timestamp
  twilioSignature?: string;  // adr 0394 whatsapp-twilio: x-twilio-signature
  signature256?: string;     // adr 0394 whatsapp-cloud (meta): x-hub-signature-256
  zoomSignature?: string;    // adr 0404 zoom-webinar: x-zm-signature
  zoomTimestamp?: string;    // adr 0404 zoom-webinar: x-zm-request-timestamp
}

/**
 * Handle one verified inbound provider callback (Slack today). Resolves the
 * connection's inbound config + signing secret, verifies the signature, answers
 * Slack's `url_verification` handshake, dedups on the provider event id, and
 * fires the configured workflow through the trigger bridge. Pure of Express —
 * the route adapter maps the outcome to a status code.
 */
export async function handleInboundEvent(
  deps: InboundDeps,
  input: {
    connectionId: string;
    rawBody: string;
    body: Record<string, unknown>;
    headers: InboundHeaders;
    now: number;
    /** The full public URL of this delivery (ADR 0394 — Twilio signs URL+params,
     *  not the raw body). Absent for providers that sign the body. */
    requestUrl?: string;
  },
): Promise<InboundOutcome> {
  const config = await store.get(input.connectionId);
  // Not-configured (or disabled) is indistinguishable from not-found on purpose —
  // an inbound URL for an unconfigured connection reveals nothing.
  if (!config || !config.enabled) return { status: 'not_found' };
  if (!inboundConfigurable(config.provider)) return { status: 'not_found' };
  // The connection itself must still exist (revoking it kills inbound too).
  if (!(await getConnection(config.tenantId, input.connectionId))) return { status: 'not_found' };

  const signingSecret = await resolveSecret(signingSecretRef(input.connectionId), { tenantId: config.tenantId });
  if (signingSecret === null) {
    log.warn('inbound signing secret unavailable', { connectionId: input.connectionId });
    return { status: 'unauthorized' };
  }

  // ── RFC 0127 / ADR 0286 — streaming/CDC ingress. A signed broker/CDC push is a fresh
  //    TRIGGER, so it dispatches to `ingestExternalEvent` (the single ingest owner) → a
  //    NEW run, NOT resolveAndResume. Verified host-side against the push signing secret;
  //    dedup + causation + the content-free `trigger.delivery.attempted` all come from the
  //    reused §C delivery path inside `ingestExternalEvent`. ──
  if (isStreamInbound(config.provider)) {
    // Flag-off ⇒ the source is neither wired nor advertised; refuse rather than half-honor.
    if (!streamCdcIngestionEnabled()) return { status: 'not_found' };
    const verdict = verifyStreamSignature({
      signingSecret,
      timestampHeader: input.headers.streamTimestamp,
      signatureHeader: input.headers.streamSignature,
      rawBody: input.rawBody,
      now: input.now,
    });
    if (!verdict.ok) {
      log.warn('inbound signature rejected', { connectionId: input.connectionId, provider: 'streams', reason: verdict.reason });
      return { status: 'unauthorized' };
    }
    const source = config.streamSource ?? 'stream';
    const ingress = buildStreamIngress(source, input.body);
    if (!ingress) return { status: 'rejected', reason: 'invalid_payload' };
    await rekeySubscription(hostDerivedSubscriptionId('connections', input.connectionId).legacyId, subscriptionIdFor(input.connectionId)).catch(() => undefined);
    const result = await ingestExternalEvent(deps, subscriptionIdFor(input.connectionId), ingress);
    switch (result.outcome) {
      case 'delivered':
        return { status: 'accepted', runId: result.runId ?? null, deduped: false };
      case 'deduped':
        return { status: 'accepted', runId: result.runId ?? null, deduped: true };
      case 'skipped':
        return { status: 'not_found' };
      default: // rejected | dead-lettered
        return { status: 'rejected', ...(result.reason ? { reason: result.reason } : {}) };
    }
  }

  // ── Per-provider verification + handshake (the platform-specific leg; everything
  //    below normalizes to the same trigger-bridge dispatch). ──
  let eventId: string | undefined;
  let normalizedEvent: unknown;
  if (config.provider === 'discord') {
    const verdict = verifyDiscordSignature({ publicKeyHex: signingSecret, timestampHeader: input.headers.discordTimestamp, signatureHeader: input.headers.discordSignature, rawBody: input.rawBody, now: input.now });
    if (!verdict.ok) { log.warn('inbound signature rejected', { connectionId: input.connectionId, provider: 'discord', reason: verdict.reason }); return { status: 'unauthorized' }; }
    // Discord PING (type 1) → PONG (type 1); interactions (type ≥ 2) fire a run.
    if (input.body.type === 1) return { status: 'respond', json: { type: 1 } };
    // Phase 2 (ADR 0175) — host-local slash commands reply SYNCHRONOUSLY in the webhook
    // response (no outbound call). /help + /status need no run; other commands fall
    // through to fire the configured workflow (/run and app-defined commands).
    if (input.body.type === 2) {
      const data = (input.body.data ?? {}) as { name?: unknown };
      const cmd = typeof data.name === 'string' ? data.name.toLowerCase() : '';
      // `/pair` links this channel to the connection so async run results route back
      // (ADR 0175 outbound follow-on). Best-effort — a pairing failure still replies.
      if (cmd === 'pair' && typeof input.body.channel_id === 'string') {
        await pairConnection(input.connectionId, 'discord', input.body.channel_id).catch(() => undefined);
      }
      const reply = slashReply(cmd, config);
      if (reply !== null) return { status: 'respond', json: { type: 4, data: { content: reply, flags: 64 } } }; // 64 = ephemeral
    }
    eventId = typeof input.body.id === 'string' ? input.body.id : undefined;
    normalizedEvent = input.body;
  } else if (config.provider === 'telegram') {
    const verdict = verifyTelegramSecret({ expected: signingSecret, provided: input.headers.telegramToken });
    if (!verdict.ok) { log.warn('inbound signature rejected', { connectionId: input.connectionId, provider: 'telegram', reason: verdict.reason }); return { status: 'unauthorized' }; }
    // Every Telegram update fires; dedup on update_id (stable across redelivery).
    eventId = typeof input.body.update_id === 'number' ? `tg:${input.body.update_id}` : undefined;
    normalizedEvent = input.body;
  } else if (config.provider === 'whatsapp-twilio') {
    // ADR 0394 — Twilio signs URL + sorted form params (not the raw body); the
    // signing secret is the Twilio auth token. Without the delivery URL the
    // signature cannot be verified — fail closed.
    if (!input.requestUrl) { log.warn('inbound signature rejected', { connectionId: input.connectionId, provider: 'whatsapp-twilio', reason: 'missing_request_url' }); return { status: 'unauthorized' }; }
    const verdict = verifyTwilioSignature({ authToken: signingSecret, url: input.requestUrl, params: input.body, signatureHeader: input.headers.twilioSignature });
    if (!verdict.ok) { log.warn('inbound signature rejected', { connectionId: input.connectionId, provider: 'whatsapp-twilio', reason: verdict.reason }); return { status: 'unauthorized' }; }
    // Only real inbound messages fire (status callbacks ride MessageStatus and are acked).
    if (typeof input.body.MessageStatus === 'string' && typeof input.body.Body !== 'string') return { status: 'ignored' };
    // Dedup on the provider MessageSid (stable across Twilio's retries).
    eventId = typeof input.body.MessageSid === 'string' ? `wa:${input.body.MessageSid}` : undefined;
    normalizedEvent = input.body;
    // The 24h customer-service window opens/renews on every verified inbound —
    // observed by the whatsapp feature via the observer hook (dependency
    // inversion: connections never imports a feature). Best-effort.
    await notifyInboundObserver(config.provider, { tenantId: config.tenantId, connectionId: input.connectionId, body: input.body, now: input.now });
    // Phase 2 — the dispatch gate (fail-closed): a verified message a feature
    // refuses to dispatch (e.g. the no-training attestation is missing) is
    // acked and dropped, never fired into an AI workflow.
    const gate = await checkInboundGate(config.provider, { tenantId: config.tenantId, connectionId: input.connectionId, body: input.body, now: input.now });
    if (!gate.allow) {
      log.info('inbound dispatch gated', { connectionId: input.connectionId, provider: config.provider, reason: gate.reason });
      return { status: 'ignored' };
    }
  } else if (config.provider === 'whatsapp-cloud') {
    // ADR 0394 Phase 4 — Meta Cloud API direct: sha256 HMAC over the raw body
    // (the signing secret is the Meta APP SECRET). JSON deliveries, so the
    // standard json parser + rawBody capture apply.
    const verdict = verifyMetaCloudSignature({ appSecret: signingSecret, rawBody: input.rawBody, signatureHeader: input.headers.signature256 });
    if (!verdict.ok) { log.warn('inbound signature rejected', { connectionId: input.connectionId, provider: 'whatsapp-cloud', reason: verdict.reason }); return { status: 'unauthorized' }; }
    // Cloud envelope: entry[].changes[].value.messages[] — status-only deliveries
    // (no messages) are acked without a run.
    const firstMessage = (() => {
      const entry = Array.isArray(input.body.entry) ? (input.body.entry as Record<string, unknown>[]) : [];
      for (const e of entry) {
        const changes = Array.isArray(e.changes) ? (e.changes as Record<string, unknown>[]) : [];
        for (const c of changes) {
          const value = (c.value ?? {}) as Record<string, unknown>;
          const messages = Array.isArray(value.messages) ? (value.messages as Record<string, unknown>[]) : [];
          if (messages.length > 0) return messages[0]!;
        }
      }
      return null;
    })();
    if (!firstMessage) return { status: 'ignored' };
    eventId = typeof firstMessage.id === 'string' ? `wa:${firstMessage.id}` : undefined;
    normalizedEvent = input.body;
    await notifyInboundObserver(config.provider, { tenantId: config.tenantId, connectionId: input.connectionId, body: input.body, now: input.now });
    const cloudGate = await checkInboundGate(config.provider, { tenantId: config.tenantId, connectionId: input.connectionId, body: input.body, now: input.now });
    if (!cloudGate.allow) {
      log.info('inbound dispatch gated', { connectionId: input.connectionId, provider: config.provider, reason: cloudGate.reason });
      return { status: 'ignored' };
    }
  } else if (config.provider === 'zoom-webinar') {
    // ADR 0404 — Zoom webhook signature is Slack-shaped: `x-zm-signature: v0=<hex
    // HMAC-SHA256(secret, v0:${ts}:${rawBody})>` + `x-zm-request-timestamp`.
    const verdict = verifySlackSignature({ signingSecret, timestampHeader: input.headers.zoomTimestamp, signatureHeader: input.headers.zoomSignature, rawBody: input.rawBody, now: input.now });
    if (!verdict.ok) { log.warn('inbound signature rejected', { connectionId: input.connectionId, provider: 'zoom-webinar', reason: verdict.reason }); return { status: 'unauthorized' }; }
    // Zoom endpoint URL-validation handshake: echo plainToken + its HMAC.
    if (input.body.event === 'endpoint.url_validation') {
      const payload = (input.body.payload ?? {}) as { plainToken?: unknown };
      const plainToken = typeof payload.plainToken === 'string' ? payload.plainToken : '';
      const encryptedToken = createHmac('sha256', signingSecret).update(plainToken).digest('hex');
      return { status: 'respond', json: { plainToken, encryptedToken } };
    }
    // A verified webinar event is OBSERVER-ONLY — the webinars feature's observer
    // processes it into (idempotent, deterministic-id) CRM activities + host
    // events; no workflow fires. Idempotency is guaranteed by the activity ids
    // (getActivity check), so a Zoom retry is a safe no-op. Best-effort.
    await notifyInboundObserver(config.provider, { tenantId: config.tenantId, connectionId: input.connectionId, body: input.body, now: input.now });
    return { status: 'accepted', runId: null, deduped: false };
  } else {
    // Slack (HMAC).
    const verdict = verifySlackSignature({ signingSecret, timestampHeader: input.headers.timestamp, signatureHeader: input.headers.signature, rawBody: input.rawBody, now: input.now });
    if (!verdict.ok) { log.warn('inbound signature rejected', { connectionId: input.connectionId, provider: 'slack', reason: verdict.reason }); return { status: 'unauthorized' }; }
    if (input.body.type === 'url_verification') {
      const challenge = typeof input.body.challenge === 'string' ? input.body.challenge : '';
      return { status: 'challenge', challenge };
    }
    if (input.body.type !== 'event_callback') return { status: 'ignored' };
    eventId = typeof input.body.event_id === 'string' ? input.body.event_id : undefined;
    normalizedEvent = input.body.event ?? null;
  }

  // Dedup on the provider event id (stable across its retries); fall back to a body
  // hash so a malformed-but-signed event still can't double-fire within the window.
  const dedupKey = makeDedupKey(input.connectionId, eventId ?? `sha:${createHmac('sha256', signingSecret).update(input.rawBody).digest('hex')}`);

  const result = await deliver({
    subscriptionId: subscriptionIdFor(input.connectionId),
    dedupKey,
    fire: async (deliveryId) => {
      // Phase 3 — conversational resume: if this connection has an active run that is
      // still open AND waiting on an interrupt, feed the message INTO it (resolve +
      // resume) rather than starting a new run. Inside the dedup wrapper, so a
      // redelivered message never double-resumes.
      const resume = await pickResumeInterrupt(deps.storage, input.connectionId);
      if (resume) {
        await resolveAndResume(deps.storage, deps.hostSuite, resume.interruptId, { message: normalizedEvent ?? null, source: config.provider }, { capabilityToken: true });
        await sessions.put({ connectionId: input.connectionId, activeRunId: resume.runId, updatedAt: nowIso() });
        return resume.runId; // resumed the in-flight conversation
      }
      let runId: string | null;
      try {
        runId = await startWorkflowRun(deps, {
          tenantId: config.tenantId,
          // Only workflow-dispatch providers reach this block (observer-only + stream
          // providers return earlier); their config always carries a workflowId.
          workflowId: config.workflowId ?? '',
          metadata: {
            inbound: {
              connectionId: input.connectionId,
              provider: config.provider,
              deliveryId,
              ...(eventId ? { eventId } : {}),
            },
          },
          inputs: { event: normalizedEvent ?? null },
        });
      } catch (err) {
        // ADR 0482 grade-fix H1 — a hard-capped budget now THROWS a 429 from
        // startWorkflowRun. This lane's contract is the `nofire:` null-sentinel
        // (dedup records the attempt, the delivery is cleanly ACCEPTED); letting
        // the 429 escape would 500 the webhook and trigger a provider RETRY
        // STORM until the budget resets. Decline gracefully instead.
        if (err instanceof OpenwopError && (err.details as { reason?: string } | undefined)?.reason === 'workflow_budget_exhausted') {
          return `nofire:${deliveryId}`;
        }
        throw err;
      }
      // Record the new run as the connection's active conversation so a follow-up
      // message resumes it (Phase 3).
      if (runId) await sessions.put({ connectionId: input.connectionId, activeRunId: runId, updatedAt: nowIso() });
      // The bridge needs a non-empty id; a null (workflow not found) becomes a
      // sentinel so dedup still records the attempt rather than throwing.
      return runId ?? `nofire:${deliveryId}`;
    },
  });
  const runId = result.runId && !result.runId.startsWith('nofire:') ? result.runId : null;
  return { status: 'accepted', runId, deduped: result.outcome === 'deduped' || result.outcome === 'skipped' };
}

/**
 * Phase-3 resume DECISION (pure of `resolveAndResume`): a connection resumes its active
 * run when that run is non-terminal AND has an open interrupt awaiting input. Returns the
 * `{ runId, interruptId }` to resume, or null to start a new run. Exported for unit tests.
 */
export async function pickResumeInterrupt(storage: Storage, connectionId: string): Promise<{ runId: string; interruptId: string } | null> {
  const session = await sessions.get(connectionId);
  if (!session?.activeRunId) return null;
  const run = await storage.getRun(session.activeRunId);
  if (!run || TERMINAL_RUN.has(run.status)) return null;
  const open = await storage.listOpenInterrupts(session.activeRunId);
  if (open.length === 0) return null;
  return { runId: session.activeRunId, interruptId: open[0]!.interruptId };
}

/** Test-only: seed a connection's active-run session (ADR 0175 Phase 3). */
export async function __setInboundSessionForTest(connectionId: string, activeRunId: string): Promise<void> {
  await sessions.put({ connectionId, activeRunId, updatedAt: nowIso() });
}

/**
 * Delete the inbound-session pointer for a connection (ADR 0590 teardown +
 * revoke cleanup). The `connections:inbound-session` row keys by `connectionId`
 * and carries NO tenant, so it is teardown-reachable only through its parent
 * connection — deleted here when the connection is revoked (so it never orphans)
 * and by the connections tenant-purge hook (feature.ts) at account deletion.
 */
export async function purgeInboundSession(connectionId: string): Promise<boolean> {
  return sessions.delete(connectionId);
}

export async function __resetInboundStore(): Promise<void> {
  await store.__clear();
  await sessions.__clear();
}
