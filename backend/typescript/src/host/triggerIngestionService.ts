/**
 * External-event trigger ingestion — RFC 0099 reference host wiring.
 *
 * Extends the RFC 0083 durable trigger bridge (`triggerBridgeService.ts`) so the
 * `webhook` / `email` / `form` subscription sources, which RFC 0083 only *lists*
 * in `capabilities.triggerBridge.sources[]`, actually ingest an
 * externally-originated event → normalize it to a `TriggerEvent` (§F.1) → start a
 * run carrying that envelope as `ctx.triggerData`. It reuses the §C delivery
 * model (dedup → causation → retry/dead-letter) verbatim via `deliver()` — there
 * is NO second trigger engine or parallel store here.
 *
 * Three invariants this module owns (RFC 0099 §F.4):
 *
 *   - `trigger-ingestion-ssrf`: ANY host-side fetch the ingestion path performs
 *     (webhook verification callback, email-attachment / form-file resolution)
 *     goes through the RFC 0093/0076 §B denied-range guard
 *     (`isDeniedWebhookHost` + the pinned `webhookEgressDispatcher`). The run is
 *     NEVER handed an external URL to fetch itself — attachments resolve to a
 *     host-internal `AttachmentRef.ref` here, behind the guard.
 *   - `trigger-ingestion-content-redaction`: the inbound body / headers / email
 *     content / form fields NEVER appear on a `run.*` / `trigger.*` durable event
 *     payload. They live ONLY in `ctx.triggerData` (the in-run `TriggerEvent`,
 *     cached in the run's start snapshot for replay, never event-logged). The
 *     `trigger.delivery.attempted` event stays content-free (RFC 0083 §C).
 *   - replay determinism: the `TriggerEvent` is cached in the run's
 *     `metadata.triggerData` start snapshot (RFC 0006 §C); at replay the host
 *     replays the cached envelope and never re-accepts/re-fetches the event, and
 *     a re-delivery of the same `dedupKey` within retention is a no-op returning
 *     the prior `runId`.
 *
 * @see RFCS/0099-external-event-trigger-ingestion.md §F
 * @see docs/adr/0034-external-event-trigger-ingestion.md
 * @see src/host/triggerBridgeService.ts — the RFC 0083 §B/§C durable engine reused here
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { seedRunVariables } from './variablesRuntime.js';
import { insertRunWithStartContext } from './runInsert.js';
import { fetch as undiciFetch } from 'undici';
import type { RunRecord } from '../types.js';
import type { HostAdapterSuite } from './index.js';
import type { Storage } from '../storage/storage.js';
import { executeRun } from '../executor/executor.js';
import { getEventLog } from '../executor/eventLog.js';
import { createLogger } from '../observability/logger.js';
import { resolveLaunchWorkflow } from './resolveLaunchDefinition.js';
import { resolveOne } from './featureToggles/service.js';
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';
import {
  deliver,
  getSubscription,
  makeDedupKey,
  type SubscriptionSource,
} from './triggerBridgeService.js';

const log = createLogger('host.triggerIngestion');

/** RFC 0099 §F.3 — `triggerBridge.ingestion.maxBodyBytes` cap on the inbound
 *  body (webhook body / email / form). Reuses the RFC 0076 §B response-cap
 *  discipline. Overridable by the operator. */
export const MAX_INGEST_BODY_BYTES = Number(process.env.OPENWOP_TRIGGER_INGEST_MAX_BODY_BYTES ?? 1_048_576);
/** (2026-07 vuln-scan) Cap the attachment/file URL fan-out: the array length was
 *  unbounded, so a single ingest with thousands of URLs occupied the handler for
 *  hours and amplified outbound (SSRF-guarded) fetches. Extra entries are dropped
 *  with a log line (never silently). */
export const MAX_INGEST_ATTACHMENTS = Number(process.env.OPENWOP_TRIGGER_INGEST_MAX_ATTACHMENTS ?? 20);
function capUrls<T>(urls: readonly T[] | undefined, kind: string): readonly T[] {
  const all = urls ?? [];
  if (all.length <= MAX_INGEST_ATTACHMENTS) return all;
  log.warn('trigger_ingest_attachments_capped', { kind, received: all.length, cap: MAX_INGEST_ATTACHMENTS });
  return all.slice(0, MAX_INGEST_ATTACHMENTS);
}

/** RFC 0099 §F.3 — the externally-ingested sources this host wires + ADVERTISES.
 *  Deliberately does NOT include `stream`/`change` (RFC 0127): those stay off the
 *  advertised set until RFC 0127 is Accepted (CDP-1c standing guardrail). */
export const EXTERNAL_INGESTION_SOURCES = ['webhook', 'email', 'form'] as const;
export type ExternalIngestionSource = (typeof EXTERNAL_INGESTION_SOURCES)[number];

/** RFC 0127 (Draft) — streaming/CDC sources. Flag-gated + NOT advertised until the RFC
 *  is Accepted; the ingest PATH accepts them (for the reference-host witness) only when
 *  `OPENWOP_TRIGGER_STREAM_CDC_ENABLED=true`, but `EXTERNAL_INGESTION_SOURCES` (which
 *  feeds `capabilities.triggerBridge.sources[]`/`ingestion`) never grows — advertise
 *  only what an Accepted RFC covers. */
export const STREAM_CDC_SOURCES = ['stream', 'change'] as const;
export type StreamCdcSource = (typeof STREAM_CDC_SOURCES)[number];

/** RFC 0127 gate — default OFF (honest-off; the advert stays webhook/email/form). */
export function streamCdcIngestionEnabled(): boolean {
  return process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED === 'true';
}

export function isExternalIngestionSource(s: string): s is ExternalIngestionSource {
  return (EXTERNAL_INGESTION_SOURCES as readonly string[]).includes(s);
}

/** A source the ingest path will ACCEPT (advertised set, plus the flag-gated 0127 sources).
 *  Type-guards to `SubscriptionSource` — every accepted value is one (a subset), so the true
 *  branch may register a subscription without a cast. */
export function isAcceptedIngestionSource(s: string): s is SubscriptionSource {
  return isExternalIngestionSource(s) || (streamCdcIngestionEnabled() && (STREAM_CDC_SOURCES as readonly string[]).includes(s));
}

/**
 * Whether external-event ingestion is wired + advertised on this host (RFC 0099
 * §F.3 honesty gate). The path IS wired in this build, so it defaults ON, but an
 * operator can fail it closed (`OPENWOP_TRIGGER_INGESTION_ENABLED=false`) — e.g.
 * a white-label install that hasn't fronted the ingest seam with a real
 * webhook/email/form gateway. When off, `POST /v1/trigger-subscriptions` +
 * `.../ingest` return `501` and the `triggerBridge.ingestion` capability sub-block
 * is NOT advertised (so a consumer never reads a claim the host won't honor).
 */
export function triggerIngestionEnabled(): boolean {
  return process.env.OPENWOP_TRIGGER_INGESTION_ENABLED !== 'false';
}

// ---------------------------------------------------------------------------
// RFC 0099 §F.1 — the `TriggerEvent` envelope (in-run `ctx.triggerData`).
// ---------------------------------------------------------------------------

export interface AttachmentRef {
  /** A host-internal opaque handle — NEVER a raw external URL the run fetches
   *  itself (RFC 0099 §F.1 / §F.4). */
  ref: string;
  filename?: string;
  mediaType?: string;
  bytes?: number;
}

export interface WebhookEvent {
  method?: 'POST' | 'PUT' | 'PATCH';
  /** Host-curated allowlist ONLY — credential-bearing headers are stripped (SR-1). */
  headers?: Record<string, string>;
  body?: unknown;
}

export interface EmailEvent {
  from?: string;
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: AttachmentRef[];
}

export interface FormEvent {
  fields?: Record<string, unknown>;
  files?: AttachmentRef[];
}

/** RFC 0127 — a message consumed from a streaming broker. The broker `partition`/`offset`
 *  MAY be carried for at-least-once dedup keying; `message` is the host-local body (lands
 *  in `run.metadata.triggerData`, never an event payload — SR-1, same as webhook `body`). */
export interface StreamEvent {
  topic?: string;
  partition?: number;
  offset?: string;
  /** Broker message key (partitioning/compaction) — CDP-1b seam contract. */
  key?: string;
  message?: unknown;
}

/** RFC 0127 — a change-data-capture row. `op` is REQUIRED (insert/update/delete); the CDC
 *  `before`/`after` row images are the host-local body (SR-1-redacted like the others):
 *  insert→after, update→before+after, delete→before. */
export interface ChangeEvent {
  op: 'insert' | 'update' | 'delete';
  table?: string;
  changelogId?: string;
  before?: unknown;
  after?: unknown;
}

export interface TriggerEvent {
  source: ExternalIngestionSource | StreamCdcSource;
  subscriptionId: string;
  /** Stable per-delivery id; equals the `causationId` stamped on `run.started`. */
  deliveryId: string;
  /** The host-opaque dedup key (present iff `dedupEnabled`). */
  dedupKey?: string;
  receivedAt: string;
  /** Whether the host verified source authenticity before delivery. */
  verified?: boolean;
  /** Always `untrusted` — inbound external content fed to an LLM node MUST be
   *  wrapped per `threat-model-prompt-injection.md`. */
  contentTrust: 'untrusted';
  webhook?: WebhookEvent;
  email?: EmailEvent;
  form?: FormEvent;
  stream?: StreamEvent;
  change?: ChangeEvent;
}

/** RFC 0099 §F.1 — credential-bearing headers a host MUST NOT pass through
 *  (SR-1). Matched case-insensitively. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie']);

/** Curate the inbound webhook headers to a non-credential allowlist (§F.1). */
function curateHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Bound the inbound body by `maxBodyBytes` (§F.3). A string/JSON body over the
 *  cap is rejected (the caller dead-letters); object bodies are measured by
 *  their JSON encoding. */
export function bodyWithinCap(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  const encoded = typeof body === 'string' ? body : JSON.stringify(body);
  return Buffer.byteLength(encoded, 'utf8') <= MAX_INGEST_BODY_BYTES;
}

// ---------------------------------------------------------------------------
// RFC 0099 §F.4 — SSRF-guarded host-side fetch (attachment / verification).
// ---------------------------------------------------------------------------

/** Raised when an ingestion-path fetch targets a denied (private/loopback/
 *  link-local/metadata) host — the `trigger-ingestion-ssrf` invariant. */
export class TriggerIngestionSsrfError extends Error {
  readonly code = 'OPENWOP_TRIGGER_INGESTION_SSRF';
  constructor(host: string) {
    super(`trigger ingestion fetch denied: ${host} is a private/loopback/link-local range (RFC 0099 §F.4 / RFC 0093 §A.1)`);
    this.name = 'TriggerIngestionSsrfError';
  }
}

/**
 * Host-mediated, SSRF-guarded resolution of an external attachment/file URL to
 * a host-internal `AttachmentRef`. Returns `null` (the attachment is DROPPED,
 * the run still starts) when the URL is denied or the fetch fails — never
 * throws into the run, and NEVER hands the URL to the run (§F.1 / §F.4).
 *
 * The actual byte-store is best-effort: we record an opaque internal ref +
 * metadata (a production host writes the bytes through `host.blobStorage`). The
 * point this enforces is that the SSRF guard sits in ONE place and the run only
 * ever sees an internal `ref`.
 */
export async function resolveAttachment(externalUrl: string, meta?: { filename?: string; mediaType?: string }): Promise<AttachmentRef | null> {
  let parsed: URL;
  try {
    parsed = new URL(externalUrl);
  } catch {
    return null;
  }
  // SSRF: reject a denied host up front, unless private egress is explicitly
  // enabled (local dev / tests). Same predicate the webhook/connector egress
  // paths use — one guard, no drift.
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(parsed.hostname)) {
    log.warn('trigger_ingest_attachment_ssrf_denied', { host: parsed.hostname });
    return null;
  }
  if (parsed.protocol !== 'https:' && !webhookPrivateEgressAllowed()) return null;
  try {
    const res = await undiciFetch(externalUrl, {
      method: 'GET',
      redirect: 'error', // no-redirect (RFC 0093 §A.2) — a 3xx is a fetch error
      dispatcher: webhookEgressDispatcher(), // pinned-resolution guard (no DNS-rebind TOCTOU)
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_INGEST_BODY_BYTES) return null;
    // Sample-grade internal handle; a production host writes `buf` to blob
    // storage and uses that key. The run only ever sees this internal ref.
    return {
      ref: `tg-att-${randomUUID()}`,
      ...(meta?.filename ? { filename: meta.filename } : {}),
      ...(meta?.mediaType ? { mediaType: meta.mediaType } : {}),
      bytes: buf.byteLength,
    };
  } catch (err) {
    log.warn('trigger_ingest_attachment_fetch_failed', { host: parsed.hostname, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// RFC 0099 §F.2 — source-authenticity verification.
// ---------------------------------------------------------------------------

/**
 * Verify a webhook delivery's HMAC-SHA256 signature against the registered
 * signing secret (the `webhooks.md` signature recipe, reused). Returns true on a
 * match. Constant-time comparison; a malformed/absent signature is `false`.
 */
export function verifyWebhookSignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Accept either the bare hex or a `sha256=<hex>` form.
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice('sha256='.length) : signatureHeader;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Normalization — per-source inbound payload → `TriggerEvent` skeleton.
// ---------------------------------------------------------------------------

export interface WebhookIngressInput {
  source: 'webhook';
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, unknown>;
  /** The raw request body, as received (used for the signature check). */
  rawBody: string;
  /** The signature header value (HMAC verification). */
  signature?: string;
  /** A stable per-delivery id the sender provides for dedup (e.g. a delivery
   *  GUID header); falls back to a hash of the body. */
  externalDeliveryId?: string;
}

export interface EmailIngressInput {
  source: 'email';
  from?: string;
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
  /** Sender authenticity verdict the inbound-email provider supplies (DMARC). */
  dmarcPass?: boolean;
  /** A stable per-message id for dedup (the SMTP Message-ID). */
  messageId?: string;
  /** External attachment URLs the host resolves through its SSRF guard. */
  attachmentUrls?: { url: string; filename?: string; mediaType?: string }[];
}

export interface FormIngressInput {
  source: 'form';
  fields?: Record<string, unknown>;
  /** Origin-check verdict (Origin/Referer + CSRF token). */
  originValid?: boolean;
  submissionId?: string;
  fileUrls?: { url: string; filename?: string; mediaType?: string }[];
}

/** RFC 0127 — a broker message to land as `source:"stream"`. Dedup seed = the broker
 *  coordinates `(topic,partition,offset)` (stable across redelivery of the SAME message). */
export interface StreamIngressInput {
  source: 'stream';
  topic?: string;
  partition?: number;
  offset?: string;
  key?: string;
  /** The consumed message body (host-local; SR-1-redacted from the wire). */
  message?: unknown;
}

/** RFC 0127 — a CDC changelog row to land as `source:"change"`. `op` REQUIRED; dedup seed =
 *  `(table,changelogId)`. `before`/`after` are the row images (insert→after, update→both,
 *  delete→before). */
export interface ChangeIngressInput {
  source: 'change';
  op: 'insert' | 'update' | 'delete';
  table?: string;
  changelogId?: string;
  before?: unknown;
  after?: unknown;
}

export type IngressInput = WebhookIngressInput | EmailIngressInput | FormIngressInput | StreamIngressInput | ChangeIngressInput;

export interface IngestDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

export interface IngestResult {
  outcome: 'delivered' | 'deduped' | 'dead-lettered' | 'skipped' | 'rejected';
  runId?: string;
  /** Set on a `rejected`/`dead-lettered` verification failure (§F.2). */
  reason?: 'signature-invalid' | 'body-too-large' | 'workflow-not-found' | 'paused' | 'feature-disabled';
}

/**
 * Ingest one externally-originated event for `subscriptionId`. The whole §F
 * leg: bound + verify → normalize to a `TriggerEvent` → resolve attachments
 * through the SSRF guard → `deliver()` (dedup/causation/retry) → start the run
 * with the envelope as `ctx.triggerData`. The inbound content NEVER touches the
 * event log (only `metadata.triggerData`, never an event payload).
 */
export async function ingestExternalEvent(deps: IngestDeps, subscriptionId: string, input: IngressInput): Promise<IngestResult> {
  const sub = await getSubscription(subscriptionId);
  if (!sub) return { outcome: 'skipped' };
  if (sub.state !== 'active') return { outcome: 'skipped', reason: 'paused' };
  // ADR 0599 §6 — OWNING-FEATURE gate, resolved PER TENANT at ingest time (the
  // twin of `scheduleDaemon`'s). Absent `featureId` ⇒ ungated (every
  // pre-existing subscription). Without it, disabling a feature for one tenant
  // left its webhook accepting events and starting runs indefinitely — the
  // tenant could not even see the config route to disarm it themselves.
  // Fail-closed: an unreadable toggle does not start someone's workflow.
  if (sub.featureId) {
    let enabled = false;
    try {
      enabled = (await resolveOne(sub.featureId, { tenantId: sub.tenantId }))?.enabled === true;
    } catch (err) {
      log.warn('trigger_ingest_feature_unresolved', {
        subscriptionId, featureId: sub.featureId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!enabled) {
      log.info('trigger_ingest_feature_disabled', { subscriptionId, featureId: sub.featureId });
      return { outcome: 'skipped', reason: 'feature-disabled' };
    }
  }
  if (!sub.workflowId) {
    // Not an external-event subscription (e.g. the Kanban `queue` subscription).
    return { outcome: 'skipped' };
  }
  if (sub.source !== (input.source as SubscriptionSource)) return { outcome: 'skipped' };
  // RFC 0127 flag gate — a stream/change event is accepted ONLY when the (default-off)
  // flag is on; otherwise the host neither ingests nor advertises it (honest-off).
  if (!isAcceptedIngestionSource(input.source)) return { outcome: 'skipped' };

  // ADR 0474 P1b — event-triggered launches are production: published-when-present.
      const wf = await resolveLaunchWorkflow(deps.hostSuite.workflowCatalog, sub.tenantId, sub.workflowId);
  if (!wf) {
    log.warn('trigger_ingest_workflow_not_found', { subscriptionId, workflowId: sub.workflowId });
    return { outcome: 'dead-lettered', reason: 'workflow-not-found' };
  }

  const mode = sub.verificationMode ?? 'required';
  const receivedAt = new Date().toISOString();

  // -- Bound + verify + normalize, per source -----------------------------
  let verified = false;
  let payload: { webhook?: WebhookEvent; email?: EmailEvent; form?: FormEvent; stream?: StreamEvent; change?: ChangeEvent } = {};
  let dedupSeed: string;

  if (input.source === 'webhook') {
    if (!bodyWithinCap(input.rawBody)) return { outcome: 'rejected', reason: 'body-too-large' };
    if (sub.secretFingerprint && input.signature !== undefined) {
      // The cleartext secret is held by the operator/sender; the host verifies
      // the HMAC against the secret it minted at registration. Sample host
      // re-derives from the per-subscription secret store (below).
      const secret = ingestSecrets.get(subscriptionId);
      verified = secret ? verifyWebhookSignature(secret, input.rawBody, input.signature) : false;
    } else if (sub.secretFingerprint) {
      verified = false; // signing expected, none supplied
    } else {
      verified = mode === 'none';
    }
    let body: unknown = input.rawBody;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      /* keep as string for non-JSON */
    }
    payload = { webhook: { method: input.method ?? 'POST', headers: curateHeaders(input.headers), body } };
    dedupSeed = input.externalDeliveryId ?? makeDedupKey('webhook', input.rawBody);
  } else if (input.source === 'email') {
    const sizeProbe = `${input.subject ?? ''}${input.text ?? ''}${input.html ?? ''}`;
    if (!bodyWithinCap(sizeProbe)) return { outcome: 'rejected', reason: 'body-too-large' };
    verified = input.dmarcPass === true;
    const attachments: AttachmentRef[] = [];
    for (const a of capUrls(input.attachmentUrls, 'email-attachment')) {
      const resolved = await resolveAttachment(a.url, { filename: a.filename, mediaType: a.mediaType });
      if (resolved) attachments.push(resolved); // a denied/failed fetch is DROPPED (§F.4 negative)
    }
    payload = {
      email: {
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.html ? { html: input.html } : {}),
        ...(attachments.length ? { attachments } : {}),
      },
    };
    dedupSeed = input.messageId ?? makeDedupKey('email', input.from ?? '', input.subject ?? '', input.text ?? '');
  } else if (input.source === 'form') {
    const sizeProbe = JSON.stringify(input.fields ?? {});
    if (!bodyWithinCap(sizeProbe)) return { outcome: 'rejected', reason: 'body-too-large' };
    verified = input.originValid === true;
    const files: AttachmentRef[] = [];
    for (const f of capUrls(input.fileUrls, 'form-file')) {
      const resolved = await resolveAttachment(f.url, { filename: f.filename, mediaType: f.mediaType });
      if (resolved) files.push(resolved);
    }
    payload = {
      form: {
        ...(input.fields ? { fields: input.fields } : {}),
        ...(files.length ? { files } : {}),
      },
    };
    dedupSeed = input.submissionId ?? makeDedupKey('form', sizeProbe);
  } else if (input.source === 'stream') {
    // RFC 0127 — the host is the broker consumer; its own authenticated consumption IS
    // the verification (no per-message signature — §4: the broker connection is a
    // credential-brokered egress, never a wire field). Dedup seed = (topic,partition,offset),
    // stable across redelivery of the SAME broker message (at-least-once).
    const sizeProbe = JSON.stringify(input.message ?? null);
    if (!bodyWithinCap(sizeProbe)) return { outcome: 'rejected', reason: 'body-too-large' };
    verified = true;
    payload = {
      stream: {
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
        ...(input.partition !== undefined ? { partition: input.partition } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.key !== undefined ? { key: input.key } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
      },
    };
    dedupSeed = makeDedupKey('stream', input.topic ?? '', String(input.partition ?? ''), input.offset ?? sizeProbe);
  } else if (input.source === 'change') {
    // RFC 0127 — a CDC changelog row. `op` is REQUIRED (validated); dedup seed =
    // (table,changelogId). Host-consumed ⇒ verified.
    if (input.op !== 'insert' && input.op !== 'update' && input.op !== 'delete') {
      return { outcome: 'rejected', reason: 'signature-invalid' };
    }
    const sizeProbe = JSON.stringify({ b: input.before ?? null, a: input.after ?? null });
    if (!bodyWithinCap(sizeProbe)) return { outcome: 'rejected', reason: 'body-too-large' };
    verified = true;
    payload = {
      change: {
        op: input.op,
        ...(input.table !== undefined ? { table: input.table } : {}),
        ...(input.changelogId !== undefined ? { changelogId: input.changelogId } : {}),
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
      },
    };
    dedupSeed = makeDedupKey('change', input.table ?? '', input.changelogId ?? sizeProbe);
  } else {
    return { outcome: 'skipped' }; // unknown source (exhaustive)
  }

  // §F.2 — a `required`-verification event that fails MUST NOT start a run; it
  // dead-letters with reason `signature-invalid`.
  if (mode === 'required' && !verified) {
    log.info('trigger_ingest_verification_failed', { subscriptionId, source: input.source });
    return { outcome: 'rejected', reason: 'signature-invalid' };
  }

  const dedupKey = sub.dedupEnabled ? makeDedupKey(subscriptionId, dedupSeed) : makeDedupKey(subscriptionId, randomUUID());

  // §C delivery — dedup → causation → start run with the envelope as
  // `ctx.triggerData`. No second engine; this is the RFC 0083 `deliver()`.
  const result = await deliver({
    subscriptionId,
    dedupKey,
    fire: async (deliveryId) => {
      const runId = randomUUID();
      const now = new Date().toISOString();
      const triggerEvent: TriggerEvent = {
        source: input.source,
        subscriptionId,
        deliveryId,
        ...(sub.dedupEnabled ? { dedupKey } : {}),
        receivedAt,
        verified,
        contentTrust: 'untrusted',
        ...payload,
      };
      // §C-3 causation — the delivery event is appended BEFORE the run so the
      // run can carry that event's id as `causationId`. Ordering is the whole
      // point: `trigger-bridge.md` §C-3 requires the link be "answerable via
      // the existing /ancestry endpoint", and an internal `dlv-…` handle
      // answers nothing — it names no addressable record. The delivery event
      // IS the delivery's durable record (§C-2 calls it "the terminal record"),
      // so its eventId is the delivery id that actually resolves. Emitting the
      // event afterwards, as this path used to, left `causationId` pointing at
      // a string that appears in no log.
      //
      // §C / §F.4 content-free: ids + opaque dedup key + attempt + outcome +
      // runId ONLY — never the inbound body/headers/fields.
      const deliveryEvent = await getEventLog().append({
        runId,
        type: 'trigger.delivery.attempted',
        payload: { subscriptionId, dedupKey, attempt: 1, outcome: 'delivered', runId },
      });
      const run: RunRecord = {
        runId,
        workflowId: sub.workflowId!,
        tenantId: sub.tenantId,
        status: 'pending',
        inputs: null,
        // §F.1 / §F.4 redaction: the envelope lives ONLY here (the in-run
        // start snapshot → ctx.triggerData), never on an event payload. RFC
        // 0006 §C caches it for deterministic replay. RFC 0020 §D marks the
        // run's trust boundary untrusted so LLM nodes wrap the content.
        metadata: { launchResolved: wf.launchResolved, triggerData: triggerEvent, trustBoundary: 'untrusted' },
        // §C-3 — delivery → run ancestry edge. The DELIVERY EVENT's id, not the
        // internal `dlv-…` handle (which stays on the envelope as
        // `triggerData.deliveryId` for correlation with `listDeliveries`).
        causationId: deliveryEvent.eventId,
        configurable: {},
        createdAt: now,
        updatedAt: now,
      };
      await insertRunWithStartContext(deps.storage, run, { definition: wf.definition });
      // ADR 0677 `ISWF-6a` — seed the variable bag. Without this the trigger lane was the
      // ONLY run-start path that never called `seedRunVariables` (the others:
      // `runStarter.ts:139`, `mcpSemantics.ts:360`, `workflowEvalRunner.ts:262`,
      // `workflow-author/routes.ts:84`), and `variablesRuntime.ts:117` is the sole creator
      // of the bag — so no bag existed at all, not even the DECLARED DEFAULTS. A chain's
      // `{{params.X}}` compiles to a variable-sourced PortValue
      // (`workflowChainPackLoader.ts:1188-1190`), so every one resolved `undefined` and a
      // trigger-started run died at node 1 on its first required param. That is why this is
      // a DEAD LANE and not merely an unpersonalised one.
      //
      // SCOPE: `{}` seeds the declared defaults only. Mapping the trigger ENVELOPE into the
      // bag is the RFC 0099 bridge (`ISWF-6b`) and is deliberately NOT done here — it is a
      // cross-cutting wire decision. Deferring both on that reason is what left a shipped,
      // reachable workflow dead for no gain.
      seedRunVariables(runId, wf.definition.variables, {});
      setImmediate(() => {
        executeRun(deps.storage, run, wf.definition, {
          policyResolver: deps.hostSuite.providerPolicyResolver,
        }).catch((err) => {
          log.error('trigger_ingest_dispatch_failed', { runId, error: err instanceof Error ? err.message : String(err) });
        });
      });
      return runId;
    },
  });

  if (result.outcome === 'delivered' && result.runId) {
    // The delivery event was appended inside `fire` (above), before the run, so
    // the run could carry its id as `causationId`. Appending it here too would
    // double-record the attempt — and §C-1's effectively-once assertion counts
    // `trigger.delivery.attempted{outcome:"delivered"}` per dedupKey.
    return { outcome: 'delivered', runId: result.runId };
  }
  if (result.outcome === 'deduped' && result.runId) {
    // Effectively-once: the prior run, no new run/event (RFC 0083 §C-1).
    return { outcome: 'deduped', runId: result.runId };
  }
  if (result.outcome === 'dead-lettered') return { outcome: 'dead-lettered' };
  return { outcome: 'skipped' };
}

// ---------------------------------------------------------------------------
// Per-subscription signing-secret store (webhook source).
// ---------------------------------------------------------------------------

/**
 * The webhook signing secret is returned to the caller ONCE at registration and
 * held here so the ingestion path can verify inbound HMAC signatures. It is
 * NEVER returned on a re-read (the subscription persists only the fingerprint).
 * Sample-grade in-memory store; a production host holds it in a secret manager.
 */
const ingestSecrets = new Map<string, string>();

export function storeIngestSecret(subscriptionId: string, secret: string): void {
  ingestSecrets.set(subscriptionId, secret);
}

/** Test-only: clear the in-memory signing-secret store. */
export function __resetIngestSecrets(): void {
  ingestSecrets.clear();
}
