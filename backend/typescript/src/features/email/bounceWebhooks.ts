/**
 * Email bounce/complaint webhook ingestion (ADR 0241 — the ADR 0218 §Deferred
 * follow-on). A dedicated, signature-gated public endpoint receives a provider's
 * event webhook and adds hard-bounced / complained addresses to the tenant
 * suppression list (ADR 0217 reasons `bounced`/`complaint`, already modeled).
 *
 * NOT the connections inbound-webhook seam: that fires a WORKFLOW per event and
 * is Slack/Discord/Telegram-gated. A bounce is a SUPPRESSION sink. We reuse the
 * seam's SECURITY POSTURE — public endpoint, the provider signature IS the
 * credential, the verification secret host-side + KMS-enveloped via
 * `byok/secretResolver`, tenant resolved from the stored config (never the
 * request) — via core `byok`, not the Slack module.
 *
 * Providers: sendgrid (ECDSA-signed Event Webhook) + postmark (HTTP Basic). Only
 * HARD bounces + complaints suppress; soft/deferred/transient are ignored
 * (suppressing a transient failure would wrongly kill deliverability).
 */
import { randomUUID, createPublicKey, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { setSecret, resolveSecret, removeSecret } from '../../byok/secretResolver.js';
import { registerCredentialRefConsumer } from '../../host/credentialRefRegistry.js';
import { createLogger } from '../../observability/logger.js';
import { addSuppression, normalizeEmail } from '../crm/suppressionService.js';

const log = createLogger('email.bounceWebhooks');

export type BounceProvider = 'sendgrid' | 'postmark';
export function isBounceProvider(v: string): v is BounceProvider {
  return v === 'sendgrid' || v === 'postmark';
}

/** The most events a single signed batch may carry — bounds work on the public
 *  endpoint (an oversized batch is rejected, not truncated, so nothing silently
 *  drops). */
const MAX_BATCH_EVENTS = 1000;
/** SendGrid replay window over its webhook timestamp (seconds). */
const SENDGRID_REPLAY_WINDOW_MS = 10 * 60_000;

export interface EmailWebhookConfig {
  webhookId: string;
  tenantId: string;
  orgId: string;
  provider: BounceProvider;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const store = new DurableCollection<EmailWebhookConfig>('email:webhook-config', (c) => c.webhookId, undefined, (c) => c.tenantId);
const secretRef = (webhookId: string): string => `email-webhook:${webhookId}`;

// ── Soft-bounce escalation (ADR 0249) ────────────────────────────────────────
// A HARD bounce is unambiguous → suppress immediately (above). A SOFT bounce
// (SendGrid `deferred`, Postmark `SoftBounce`/`Transient`) is transient — one is
// noise. But N CONSECUTIVE soft bounces with no intervening success is a real
// undeliverability signal, so we escalate to suppression at a threshold. The
// streak is per (tenant, address); any success signal (`delivered`/`open`/`click`)
// or a hard suppression RESETS it. Counting is CAS-guarded for concurrent
// deliveries; provider event-id replay-dedup is DEFERRED — a replayed batch only
// over-counts, which suppresses a failing address EARLIER (conservative for a
// heuristic), never a false positive on a healthy one.
interface SoftBounceCount { key: string; tenantId: string; email: string; consecutive: number; updatedAt: string }
const softCounts = new DurableCollection<SoftBounceCount>('email:soft-bounce-count', (c) => c.key, undefined, (c) => c.tenantId);
declarePiiFields('email.soft-bounce-count', ['email'], { maskGloballyByFieldName: false }); // ADR 0655 D9 (EM-18)
// ADR 0655 D9 (EM-17) — a soft-bounce streak is only meaningful while recent; age it out.
registerRetentionPurger({
  feature: 'email:soft-bounce-count',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('email:soft-bounce-count', await softCounts.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.updatedAt, id: r.key }),
      (id) => softCounts.delete(id));
  },
});
const softKey = (tenantId: string, email: string): string => `${tenantId}:${email}`;

/** Consecutive-soft-bounce suppression threshold (env-configurable, default 5,
 *  clamped ≥1 — 0/negative/NaN would suppress on the first soft bounce, defeating
 *  the "transient failures are noise" rationale). */
function softBounceThreshold(): number {
  const raw = Number(process.env.OPENWOP_EMAIL_SOFT_BOUNCE_THRESHOLD);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
}

/** CAS-increment the streak; returns the new consecutive count. Retries on
 *  contention so concurrent deliveries never lose an increment. */
async function bumpSoftBounce(tenantId: string, email: string, at: string): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await softCounts.get(softKey(tenantId, email));
    const next: SoftBounceCount = { key: softKey(tenantId, email), tenantId, email, consecutive: (cur?.consecutive ?? 0) + 1, updatedAt: at };
    if (await softCounts.compareAndSwap(cur ?? null, next)) return next.consecutive;
  }
  throw new Error('soft-bounce counter contention');
}

/** Clear the streak (a success or a hard suppression supersedes it). */
async function resetSoftBounce(tenantId: string, email: string): Promise<void> {
  const cur = await softCounts.get(softKey(tenantId, email));
  if (cur) await softCounts.delete(cur.key).catch(() => {});
}

/** Configure (or rotate) a bounce webhook for a tenant+provider. Mints an opaque
 *  webhookId on first create; the verification secret is KMS-enveloped. */
export async function setWebhookConfig(input: {
  tenantId: string; orgId: string; provider: BounceProvider; verificationSecret: string; webhookId?: string;
}): Promise<EmailWebhookConfig> {
  const existing = input.webhookId ? await store.get(input.webhookId) : undefined;
  const owned = existing && existing.tenantId === input.tenantId ? existing : undefined;
  const webhookId = owned?.webhookId ?? `ewh:${randomUUID()}`;
  const now = new Date().toISOString();
  const config: EmailWebhookConfig = {
    webhookId, tenantId: input.tenantId, orgId: input.orgId, provider: input.provider,
    enabled: true, createdAt: owned?.createdAt ?? now, updatedAt: now,
  };
  // ADR 0655 D9 (EM-28) — the ROW first, then the secret: a secret written before a put
  // that failed was an orphan no removal path could reach. If the secret write fails,
  // the row is removed again so a config never exists without its verifier.
  await store.put(config);
  try { await setSecret(secretRef(webhookId), input.verificationSecret, { tenantId: input.tenantId }); }
  catch (e) { await store.delete(webhookId).catch(() => undefined); throw e; }
  return config;
}

// ADR 0499 — `email-webhook:<id>` is the bounce-webhook VERIFICATION secret.
// Deleting it makes every inbound bounce fail verification, so the tenant simply
// stops learning about bounces — a silent deliverability regression.
registerCredentialRefConsumer({
  id: 'email:webhook-verification',
  async describe(tenantId, ref) {
    if (!ref.startsWith('email-webhook:')) return [];
    const row = await store.get(ref.slice('email-webhook:'.length));
    return row && row.tenantId === tenantId
      ? [`email bounce webhook (${row.provider})`]
      : [];
  },
});

export async function listWebhookConfigs(tenantId: string, orgId: string): Promise<EmailWebhookConfig[]> {
  const all = await store.listForTenantIndexed(tenantId);
  return all.filter((c) => c.orgId === orgId);
}

export async function removeWebhookConfig(tenantId: string, webhookId: string): Promise<boolean> {
  const existing = await store.get(webhookId);
  if (!existing || existing.tenantId !== tenantId) return false;
  await removeSecret(secretRef(webhookId), { tenantId }).catch(() => undefined);
  return store.delete(webhookId);
}

// ── Per-provider verification ────────────────────────────────────────────────

/** DER SPKI prefix so Node's createPublicKey accepts a raw base64 EC key isn't
 *  needed for SendGrid — SendGrid's Verification Key IS already a DER SPKI EC
 *  public key, base64-encoded. */
function verifySendgridSignature(input: {
  publicKeyBase64: string; signatureBase64: string | undefined; timestamp: string | undefined; rawBody: string; now: number;
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'stale' | 'bad_signature' } {
  if (!input.signatureBase64 || !input.timestamp) return { ok: false, reason: 'missing_headers' };
  const tsNum = Number(input.timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(input.now - tsNum * 1000) > SENDGRID_REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'stale' };
  }
  try {
    const key = createPublicKey({ key: Buffer.from(input.publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    const signed = Buffer.from(input.timestamp + input.rawBody, 'utf8');
    const ok = cryptoVerify('sha256', signed, key, Buffer.from(input.signatureBase64, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

/** Postmark webhooks are secured with HTTP Basic auth (the operator sets a
 *  user:pass on the webhook URL); the stored secret is the expected `user:pass`.
 *  Constant-time compare of the decoded credential. */
export function verifyPostmarkBasic(input: {
  expectedUserPass: string; authorizationHeader: string | undefined;
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'bad_signature' } {
  const h = input.authorizationHeader;
  if (!h || !/^basic /i.test(h)) return { ok: false, reason: 'missing_headers' };
  const provided = Buffer.from(h.replace(/^basic /i, '').trim(), 'base64').toString('utf8');
  const a = Buffer.from(provided);
  const b = Buffer.from(input.expectedUserPass);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

// ── Per-provider event parsing → suppression intents ─────────────────────────

export interface SuppressIntent { email: string; reason: 'bounced' | 'complaint'; note: string }

/** A classified provider event. `suppress` = hard bounce/complaint (immediate);
 *  `soft` = a transient failure that feeds the ADR 0249 escalation streak;
 *  `success` = a positive signal (`delivered`/`open`/`click`) that RESETS the
 *  streak. Everything else the provider posts is ignored. */
export type BounceSignal =
  | { email: string; kind: 'suppress'; reason: 'bounced' | 'complaint'; note: string }
  | { email: string; kind: 'soft'; note: string }
  | { email: string; kind: 'success' };

const onlySuppress = (s: BounceSignal): s is Extract<BounceSignal, { kind: 'suppress' }> => s.kind === 'suppress';

/** SendGrid posts a JSON ARRAY of events. Hard `bounce` + `spamreport` suppress;
 *  `deferred` is a soft signal (escalates); `delivered`/`open`/`click` reset. */
function classifySendgridEvents(body: unknown): BounceSignal[] {
  const events = Array.isArray(body) ? body : [];
  const out: BounceSignal[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const email = typeof e.email === 'string' ? e.email : '';
    if (!email) continue;
    const event = typeof e.event === 'string' ? e.event : '';
    if (event === 'bounce') {
      // SendGrid `bounce` = a HARD bounce (soft retries are `deferred`). A
      // `type` of `blocked` is a softer signal we still suppress on (repeated
      // block == undeliverable), but NOT `deferred`.
      out.push({ email, kind: 'suppress', reason: 'bounced', note: `sendgrid:bounce${typeof e.type === 'string' ? `:${e.type}` : ''}` });
    } else if (event === 'spamreport') {
      out.push({ email, kind: 'suppress', reason: 'complaint', note: 'sendgrid:spamreport' });
    } else if (event === 'deferred') {
      out.push({ email, kind: 'soft', note: 'sendgrid:deferred' });
    } else if (event === 'delivered' || event === 'open' || event === 'click') {
      out.push({ email, kind: 'success' });
    }
  }
  return out;
}

/** Postmark posts a single event object (we also tolerate an array). HardBounce +
 *  SpamComplaint suppress; SoftBounce/Transient escalate; Delivery/Open/Click reset. */
function classifyPostmarkEvents(body: unknown): BounceSignal[] {
  const events = Array.isArray(body) ? body : [body];
  const out: BounceSignal[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const email = typeof e.Email === 'string' ? e.Email : (typeof e.Recipient === 'string' ? e.Recipient : '');
    if (!email) continue;
    const recordType = typeof e.RecordType === 'string' ? e.RecordType : '';
    const type = typeof e.Type === 'string' ? e.Type : '';
    if (recordType === 'SpamComplaint' || type === 'SpamComplaint') {
      out.push({ email, kind: 'suppress', reason: 'complaint', note: 'postmark:SpamComplaint' });
    } else if (recordType === 'Bounce' && type === 'HardBounce') {
      out.push({ email, kind: 'suppress', reason: 'bounced', note: 'postmark:HardBounce' });
    } else if (recordType === 'Bounce' && (type === 'SoftBounce' || type === 'Transient')) {
      out.push({ email, kind: 'soft', note: `postmark:${type}` });
    } else if (recordType === 'Delivery' || recordType === 'Open' || recordType === 'Click') {
      out.push({ email, kind: 'success' });
    }
  }
  return out;
}

/** The hard-suppress subset — preserved for callers/tests that only care about
 *  immediate suppression intents. */
export function parseSendgridEvents(body: unknown): SuppressIntent[] {
  return classifySendgridEvents(body).filter(onlySuppress).map(({ email, reason, note }) => ({ email, reason, note }));
}
export function parsePostmarkEvents(body: unknown): SuppressIntent[] {
  return classifyPostmarkEvents(body).filter(onlySuppress).map(({ email, reason, note }) => ({ email, reason, note }));
}

export type IngestOutcome =
  | { status: 'not_found' }
  | { status: 'unauthorized' }
  | { status: 'too_large' }
  | { status: 'ok'; suppressed: number; escalated: number; failed: number };

/**
 * Ingest one provider webhook delivery: resolve the config by opaque webhookId,
 * verify the provider signature BEFORE any parsing, cap the batch, classify, and
 * act: hard bounces + complaints suppress immediately; soft bounces feed the
 * ADR 0249 consecutive-streak escalation (suppress at threshold); success signals
 * reset the streak. Pure of Express — the route maps the outcome to a status code.
 * Hard suppression is an idempotent upsert (a replayed signed batch re-suppresses
 * harmlessly); soft counting is CAS-guarded and only over-counts on replay (see
 * the escalation note above), never a false positive.
 */
export async function ingestBounceWebhook(input: {
  webhookId: string; rawBody: string; body: unknown;
  headers: { sendgridSignature?: string; sendgridTimestamp?: string; authorization?: string };
  now: number;
}): Promise<IngestOutcome> {
  const config = await store.get(input.webhookId);
  if (!config || !config.enabled) return { status: 'not_found' }; // unknown/disabled → indistinguishable
  const secret = await resolveSecret(secretRef(input.webhookId), { tenantId: config.tenantId });
  if (secret === null) { log.warn('bounce webhook secret unavailable', { webhookId: input.webhookId }); return { status: 'unauthorized' }; }

  // Verify BEFORE parsing (bad/absent signature → no work).
  // ADR 0655 D7 (EMWF-15) — EXHAUSTIVE dispatch: a third `BounceProvider` member is a
  // compile error here, not a silent fall-through to Postmark's HTTP-Basic check.
  switch (config.provider) {
    case 'sendgrid': {
      const v = verifySendgridSignature({ publicKeyBase64: secret, signatureBase64: input.headers.sendgridSignature, timestamp: input.headers.sendgridTimestamp, rawBody: input.rawBody, now: input.now });
      if (!v.ok) { log.warn('bounce webhook rejected', { webhookId: input.webhookId, provider: 'sendgrid', reason: v.reason }); return { status: 'unauthorized' }; }
      break;
    }
    case 'postmark': {
      const v = verifyPostmarkBasic({ expectedUserPass: secret, authorizationHeader: input.headers.authorization });
      if (!v.ok) { log.warn('bounce webhook rejected', { webhookId: input.webhookId, provider: 'postmark', reason: v.reason }); return { status: 'unauthorized' }; }
      break;
    }
    default: {
      const never: never = config.provider;
      log.warn('bounce webhook rejected', { webhookId: input.webhookId, provider: String(never), reason: 'unknown_provider' });
      return { status: 'unauthorized' };
    }
  }

  // Cap the batch to bound work on the public endpoint.
  if (Array.isArray(input.body) && input.body.length > MAX_BATCH_EVENTS) return { status: 'too_large' };

  const signals = config.provider === 'sendgrid' ? classifySendgridEvents(input.body) : classifyPostmarkEvents(input.body);
  const threshold = softBounceThreshold();
  const at = new Date(input.now).toISOString();
  let suppressed = 0;
  let escalated = 0;
  let failed = 0;
  for (const sig of signals) {
    const email = normalizeEmail(sig.email);
    if (!email || !email.includes('@')) continue;
    try {
      if (sig.kind === 'suppress') {
        await addSuppression(config.tenantId, email, sig.reason, `webhook:${config.provider}`, sig.note);
        await resetSoftBounce(config.tenantId, email); // a hard signal supersedes the soft streak
        suppressed += 1;
      } else if (sig.kind === 'success') {
        await resetSoftBounce(config.tenantId, email);
      } else {
        const n = await bumpSoftBounce(config.tenantId, email, at);
        if (n >= threshold) {
          await addSuppression(config.tenantId, email, 'bounced', `webhook:${config.provider}:soft-escalation`, `${sig.note} (n=${n}/${threshold})`);
          await resetSoftBounce(config.tenantId, email); // streak consumed — a re-add after re-engagement starts fresh
          suppressed += 1;
          escalated += 1;
        }
      }
    } catch (e) {
      // ADR 0655 D9 (EM-8) — a suppression write that did not land is COUNTED, so the
      // route can answer 5xx and the provider redelivers (idempotent for hard signals).
      failed += 1;
      log.warn('bounce signal processing failed', { webhookId: input.webhookId, kind: sig.kind, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { status: 'ok', suppressed, escalated, failed };
}

export async function __resetBounceWebhookStore(): Promise<void> { await store.__clear(); await softCounts.__clear(); }

/**
 * EM-3 — GDPR data-subject erasure for `email:soft-bounce-count`.
 *
 * This store had NO eraser, NO retention purger and NO `registerKvAgeOut`, while
 * holding the recipient's raw address in BOTH the row and the key
 * (`${tenantId}:${email}`). The ADR 0464 gate could not see it either: its
 * signal regexes were `^\s*`-anchored and `SoftBounceCount` is a ONE-LINE
 * interface, so the `email` field sat mid-line and matched nothing (EM-4a).
 *
 * DELETE, not anonymize: the row is a transient heuristic counter, not a record
 * of a refusal. The durable refusal is the `crm:suppression` row a threshold
 * escalation writes, which `crm/erasure.ts` deliberately RETAINS (redacted) —
 * so erasing the streak cannot make anyone mailable again.
 *
 * Idempotent (a point delete of a key derived from the subject).
 *
 * ── RESIDUAL, stated because the first version of this docblock claimed a
 *    resolver that does not exist (review HIGH-3). ──────────────────────────
 *
 * This eraser only bites on an EMAIL-shaped subject key, and **no shipped DSAR
 * entry point supplies one today**:
 *   - `consent/consentService.ts` `deleteSubject` passes a contactId;
 *   - `features/users/routes.ts` passes a userId.
 * The ADR 0381 identity expansion (`eraseSubject` → `resolveSubjectKeys`) does
 * not close that gap either: the ONLY registered resolver,
 * `features/crm/erasure.ts` `resolveCrmSubjectKeys`, is ONE-DIRECTIONAL — it
 * maps an email/phone-shaped key TO a contactId and returns `[]` for anything
 * else. Nothing resolves contactId → email. So on every entry point the product
 * actually ships, this function is a no-op. An earlier version of this docblock
 * asserted the opposite — that a contactId-shaped key reached this store via a
 * CRM identity resolver — and that was FALSE in the direction that mattered.
 *
 * It is left registered rather than removed because the address space is real:
 * an operator-initiated erasure keyed by the address (the shape a mail-provider
 * DSAR arrives in) does reach it, and the coverage gate records the residual
 * explicitly — `PARTIAL_COVERAGE['email:soft-bounce-count']` in
 * `test/subject-erasure-feature-stores.test.ts`, the same third state
 * `forms:submission` occupies. The cure is a contactId→email resolver, which is
 * a CRM-owned identity-graph decision with blast radius across every registered
 * eraser, not an email-lane change.
 */
export async function deleteSubjectBounceCounts(tenantId: string, subjectKey: string): Promise<{ removed: number; failed: number }> {
  if (!tenantId || !subjectKey) return { removed: 0, failed: 0 };
  // Keyed by address, so an address-shaped subject key is a POINT read; a
  // contactId-shaped key matches nothing (see the RESIDUAL note above — that is
  // currently EVERY shipped caller, not a rare edge).
  const row = await softCounts.get(softKey(tenantId, subjectKey.toLowerCase())).catch(() => undefined);
  if (!row) return { removed: 0, failed: 0 };
  try { await softCounts.delete(row.key); return { removed: 1, failed: 0 }; }
  catch (e) {
    log.error('soft_bounce_count_erase_failed', { tenantId, error: e instanceof Error ? e.message : String(e) });
    return { removed: 0, failed: 1 };
  }
}

/** Test-only seam for the EM-3 erasure suite: the ingest path requires a signed
 *  provider webhook, so a coverage test cannot otherwise put a row in the store
 *  it is asserting about — and a test that seeds nothing would pass vacuously. */
export async function __seedSoftBounceForTest(tenantId: string, email: string, consecutive: number): Promise<void> {
  await softCounts.put({ key: softKey(tenantId, email.toLowerCase()), tenantId, email: email.toLowerCase(), consecutive, updatedAt: new Date().toISOString() });
}
/** Test-only reader for the same store. */
export async function __readSoftBounceForTest(tenantId: string, email: string): Promise<number | null> {
  const row = await softCounts.get(softKey(tenantId, email.toLowerCase()));
  return row ? row.consecutive : null;
}
