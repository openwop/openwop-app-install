/**
 * Managed-provider dispatch — server-held API key, per-tenant daily
 * token cap, underlying provider identity hidden from callers.
 *
 * The operator configures a managed provider (e.g. `openwop-free`) by
 * setting `MINIMAX_API_KEY` (etc.) in the environment. On boot,
 * `bootstrapManagedProvider()` encrypts the env key with the BYOK
 * master key and writes it to the `byok_secrets` table under a
 * well-known ref (`managed:openwop-free`). Subsequent dispatches read
 * the encrypted row, decrypt in-process, and call into the standard
 * `dispatchChat()` plumbing with the actual underlying provider
 * (e.g. `minimax`) and model.
 *
 * Caller contract:
 *   - `req.userFacingProvider` is the providers.json id ('openwop-free').
 *   - `req.tenantId` is charged against the daily cap. Auth-posture deploys
 *     can require `user:*`; demo postures may allow `anon:*`.
 *   - Daily token cap: input+output combined, per (tenant, day, provider).
 *     Reset at 00:00 UTC. Configurable via
 *     `OPENWOP_MANAGED_DAILY_TOKEN_CAP` (default 50000).
 *   - Global daily ceiling (optional): input+output combined across ALL
 *     tenants, per (day, provider), via
 *     `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP` (unset/0 = disabled).
 *     This is the operator's spend backstop for login-free demo postures:
 *     the per-tenant cap alone is evadable on cookie-per-visitor deploys
 *     (each fresh cookie jar is a fresh anon tenant), so a public demo
 *     SHOULD set the global ceiling. Tracked under the reserved
 *     `managed:global` usage bucket (not a real tenant).
 *
 * Result rewriting:
 *   - The returned `provider` / `model` are the user-facing ids, NOT
 *     the underlying provider. Event log, audit log, and FE outputs
 *     therefore stay free of the underlying provider name.
 *
 * Not wired to: aiProvidersHost invocation-log cache, policy resolver,
 * or per-call OTel span (managed dispatch is ad-hoc chat, not replay-
 * deterministic workflow run). The chat-responder node calls this
 * module directly when it sees the managed credentialRef prefix.
 */

import { resolve as resolvePath } from 'node:path';
import {
  decrypt,
  encrypt,
  loadMasterKey,
  type EncryptedRecord,
} from '../byok/encryption.js';
import { createLogger } from '../observability/logger.js';
import { managedUsageBucket, isReservedUsageBucket, usageBucketMatchersForTenant } from './managedUsageScope.js';
import { registerSubjectEraser } from '../host/subjectErasure.js';
import type { Storage } from '../storage/storage.js';
import { managedAnonSignInRequired } from '../host/deployPosture.js';
import { managedBalanceAvailable, managedBalanceDraw } from '../host/managedBalanceHook.js';
import { createHash } from 'node:crypto';
import { listManagedProviderIds } from './catalog.js';
import { dispatchChat, type ChatMessage, type ContentPart, type ProviderId } from './dispatch.js';
import { dispatchMiniMaxToolsRound } from './dispatchProviderTools.js';
import type { ToolDef, ToolUseBlock } from './dispatchAnthropicTools.js';

const log = createLogger('providers.managed');

export const MANAGED_REF_PREFIX = 'managed:';
/** The well-known default managed credential ref (`managed:openwop-free`) — the one
 *  canonical managed provider the host configures. Use this instead of re-deriving the
 *  literal at call sites (the host-side in-service dispatch pattern: cms/translate, KB
 *  media→text). */
export const MANAGED_FREE_REF = `${MANAGED_REF_PREFIX}openwop-free`;

/** Canonical typeId for the sample chat-responder node. Exported here
 *  (rather than left as a literal at the node-module declaration site)
 *  so it can be a single source of truth across (a) the node-module
 *  registration in `bootstrap/nodes.ts`, (b) the
 *  `MANAGED_DEFAULTING_TYPE_IDS` set below, and (c) the run-create
 *  preflight in `routes/runs.ts`. Renaming the typeId in only one
 *  place would silently break the preflight; routing it through one
 *  constant makes the rename atomic. */
export const CHAT_RESPONDER_TYPE_ID = 'vendor.openwop-app.chat-responder';

/** Node typeIds whose chat-class dispatch defaults to `managed:openwop-free`
 *  when neither `config.credentialRef` nor `inputs.credentialRef` is set.
 *  See the precedence chain in `bootstrap/nodes.ts` (the chat-responder
 *  body's credentialRef resolution). The run-create preflight in
 *  `routes/runs.ts` consumes this set to reject an anon caller whose
 *  workflow contains such a node *implicitly* on managed (the workflow
 *  author hasn't pinned an explicit ref). Co-located with
 *  `MANAGED_REF_PREFIX` so the two "this is the managed path" signals
 *  can't drift as future chat-class nodes land. */
export const MANAGED_DEFAULTING_TYPE_IDS: ReadonlySet<string> = new Set([
  CHAT_RESPONDER_TYPE_ID,
]);

/** Brand-NEUTRAL fallback grounding prompt for the managed tier. Kept generic
 *  on purpose so a white-label deployment never leaks a product name it didn't
 *  configure (mirrors myndhyve's neutral `FALLBACK_GENERIC_ROLE`). Supply your
 *  own grounding — e.g. the OpenWOP reference deploy's assistant blurb — via
 *  the `OPENWOP_MANAGED_SYSTEM_PROMPT` env var; that is the brand-authoring
 *  surface, not this constant. Kept short so it doesn't dominate the context
 *  window for every turn. */
const FALLBACK_SYSTEM_PROMPT =
  'You are a helpful AI assistant. ' +
  'Keep answers concise (2-4 sentences for most questions). ' +
  "When you don't actually know something, say so plainly rather than guessing.";

interface ManagedTarget {
  /** Underlying provider the dispatcher actually calls. Never leaks past this module. */
  provider: ProviderId;
  /** Underlying model id. */
  model: string;
  /** Storage ref under which the encrypted server-held key lives. */
  storageRef: string;
  /** Env var read at bootstrap to seed the storage row. */
  envKeyName: string;
  /** Per-tenant per-day cap (input + output tokens combined). */
  dailyTokenCap: number;
  /** System prompt prepended when the caller didn't supply one. Resolves to
   *  `OPENWOP_MANAGED_SYSTEM_PROMPT` if set, else the brand-neutral fallback. */
  defaultSystemPrompt: string;
}

/**
 * Build the managed-target map fresh on each call so env-var changes
 * (in tests or after a config push) take effect without restarting
 * the process. The hot path runs this once per dispatch — negligible
 * cost vs. an upstream LLM call.
 */
function getTargets(): Record<string, ManagedTarget> {
  const capRaw = Number(process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 50000;
  return {
    'openwop-free': {
      provider: 'minimax',
      model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3',
      storageRef: `${MANAGED_REF_PREFIX}openwop-free`,
      envKeyName: 'MINIMAX_API_KEY',
      dailyTokenCap: cap,
      defaultSystemPrompt: process.env.OPENWOP_MANAGED_SYSTEM_PROMPT ?? FALLBACK_SYSTEM_PROMPT,
    },
  };
}

export function isManagedCredentialRef(ref: string | undefined | null): boolean {
  return typeof ref === 'string' && ref.startsWith(MANAGED_REF_PREFIX);
}

/** Convert a managed credentialRef back to its user-facing provider id. */
export function managedProviderIdFromRef(ref: string): string {
  return ref.slice(MANAGED_REF_PREFIX.length);
}

/** The UNDERLYING dispatch provider a managed ref resolves to (e.g. `managed:openwop-free`
 *  → `'minimax'`), or null if the ref maps to no configured managed target. Lets callers
 *  reason about the managed model's capabilities (ADR 0110 media-modality check). */
export function managedUnderlyingProvider(ref: string): string | null {
  const target = getTargets()[managedProviderIdFromRef(ref)];
  return target ? target.provider : null;
}

export type ManagedErrorCode =
  | 'sign_in_required'
  | 'daily_limit_reached'
  | 'managed_unavailable'
  | 'managed_unknown';

export class ManagedProviderError extends Error {
  readonly code: ManagedErrorCode;
  constructor(code: ManagedErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ManagedProviderError';
  }
}

let storageRef: Storage | null = null;
let masterKeyPathRef: string | null = null;
const decryptCache = new Map<string, string>();

export function configureManagedProvider(input: { storage: Storage; dataDir: string }): void {
  storageRef = input.storage;
  masterKeyPathRef = resolvePath(input.dataDir, '.byok-master-key');
}

/**
 * Seed each configured managed provider's key from its env var into
 * storage on boot. Idempotent: skips when the stored cipher decrypts
 * to the same plaintext; overwrites when the env value changed; logs
 * + skips when the env var is unset (provider becomes unavailable
 * until the operator sets it).
 */
/**
 * ADR 0693 §4 — DSAR eraser for the per-subject free-tier buckets.
 *
 * WHY THIS EXISTS AT ALL. Before ADR 0693 a managed-usage row keyed a TENANT and
 * was operator accounting, not personal data — which is why no eraser was ever
 * registered for this store. A per-subject bucket is a fact about a PERSON ("how
 * many tokens did they use on this day"), so the moment §2 ships, this store
 * falls under ADR 0464 and a DSAR must be able to empty it.
 *
 * It removes ONLY the reserved per-subject bucket. The tenant-level row and the
 * `managed:global` ceiling are the operator's own accounting and survive an
 * erasure — deleting them would let a DSAR silently reset a spend cap.
 *
 * The bucket is RE-DERIVED from `(tenantId, subjectKey)` rather than found by
 * scanning: the hash is one-way, and a scan of this table on a DSAR-triggered
 * path is the unbounded read ADR 0684 §6 forbids.
 */
export async function eraseSubjectManagedUsage(tenantId: string, subjectKey: string): Promise<void> {
  if (!storageRef || !tenantId || !subjectKey) return;
  const bucket = managedUsageBucket(tenantId, subjectKey);
  // A single-principal tenant returns ITSELF here, which is the operator's row
  // for that tenant — never delete it on a subject erasure.
  if (!isReservedUsageBucket(bucket)) return;
  await storageRef.deleteManagedUsageForTenant(bucket);
  // ADR 0693 phase 3 — the media bucket uses the SAME composer, so one derived
  // key clears both stores. Erasing tokens but not TTS/STT would leave a DSAR
  // half-done and the gap would be invisible: both are keyed by a hash nobody
  // can enumerate.
  await storageRef.deleteMediaUsageForTenant(bucket);
}

/** What a caller can be told about their OWN managed free-tier usage today.
 *  Deliberately carries NO bucket key — see `describeOwnManagedUsage`. */
export interface OwnManagedUsage {
  providerId: string;
  /** UTC day these figures cover. Resets at 00:00 UTC. */
  day: string;
  tokens: number;
  dailyTokenCap: number;
  /** `cap - tokens`, floored at 0. */
  remaining: number;
  /** Whether this allowance is the caller's ALONE (`subject`) or shared with
   *  everyone in the tenant (`tenant`). The honest answer to "is this mine?",
   *  and the only way a participant can tell which regime they are under. */
  scope: 'subject' | 'tenant';
}

/**
 * ADR 0693 phase 5 — the caller's OWN managed free-tier usage for today.
 *
 * WHY THIS IS A SELF-READ AND NOT AN OPERATOR VIEW, which is open question 2 of
 * that ADR and is hereby ANSWERED rather than left hanging. An operator view
 * over OTHER subjects would need a reverse map from bucket back to person: the
 * bucket is `sha256(tenantId + subject)` precisely so these rows are not a log
 * of who asked what, when (§4), and a reverse map would rebuild exactly that —
 * a SECOND personal-data surface, created to display a number, on rows a DSAR
 * must be able to empty.
 *
 * A self-read needs no map at all. The caller's subject arrives with the
 * request, so the bucket composes directly, and the person whose fairness the
 * whole ADR is about is the person who gets to see it. That is not a reduced
 * version of the operator view — it is the read that was actually missing.
 * "Per-subject usage is not observable today" was a complaint on behalf of
 * participants, and phases 0-4 gave every participant a private allowance they
 * had no way to see.
 *
 * It reads through the SAME composer as the charge and the cap check. A second
 * path to "which bucket is this" is the one thing §2 says to refuse in review,
 * and a read that disagreed with the charge would be worse than no read.
 */
export async function describeOwnManagedUsage(
  tenantId: string,
  actingSubject?: string,
  providerId = 'openwop-free',
): Promise<OwnManagedUsage | null> {
  const target = getTargets()[providerId];
  if (!target || !storageRef) return null;
  const day = todayUtc();
  const bucket = managedUsageBucket(tenantId, actingSubject);
  const usage = await storageRef.getManagedUsage(bucket, providerId, day);
  const tokens = usage.inputTokens + usage.outputTokens;
  return {
    providerId,
    day,
    tokens,
    dailyTokenCap: target.dailyTokenCap,
    remaining: Math.max(0, target.dailyTokenCap - tokens),
    // Derived from the composer's own answer, never re-decided here. If the
    // bucket is reserved it is this subject's; otherwise the charge landed on
    // the tenant and the allowance really is shared.
    scope: isReservedUsageBucket(bucket) ? 'subject' : 'tenant',
  };
}

/**
 * ADR 0697 follow-up — remove every usage row a TENANT owns, including its
 * participants' per-subject buckets, on tenant teardown.
 *
 * WHY THIS EXISTS AT ALL. `deleteAllTenantData` (ADR 0284) introspects every
 * table with a `tenant_id` column and deletes by EXACT match. ADR 0693 phases
 * 1–3 put `managed:sub:<tenant>:<hash>` in that column, so an exact match on the
 * tenant reaches its OWN rows and leaves every participant's behind — orphaned
 * under a one-way hash, in a store §4 calls subject-linked personal data. The
 * §4 eraser is no help: it re-derives a bucket from a SUBJECT, and teardown has
 * a tenant.
 *
 * ONE function rather than three lines at three call sites. The teardown callers
 * are `retentionSweepDaemon` (twice) and `routes/account.ts`; a copy at each is
 * an invariant that drifts the first time a fourth appears, and this particular
 * invariant fails SILENTLY — orphaned rows have no symptom.
 *
 * Best-effort by design: a usage-row sweep must never be the reason an account
 * deletion fails. The rows it misses are unreadable counters, and a thrown error
 * here would strand a teardown that had already removed the readable data.
 */
export async function eraseTenantOwnedUsage(
  storage: Pick<Storage, 'deleteManagedUsageForTenant' | 'deleteMediaUsageForTenant'>,
  tenantId: string,
): Promise<{ managed: number; media: number }> {
  const { exact, likePattern, likeEscape } = usageBucketMatchersForTenant(tenantId);
  const alsoLike = { pattern: likePattern, escape: likeEscape };
  let managed = 0;
  let media = 0;
  try { managed = await storage.deleteManagedUsageForTenant(exact, alsoLike); } catch { /* see above */ }
  try { media = await storage.deleteMediaUsageForTenant(exact, alsoLike); } catch { /* see above */ }
  return { managed, media };
}

export async function bootstrapManagedProvider(): Promise<void> {
  registerSubjectEraser(eraseSubjectManagedUsage);
  if (!storageRef || !masterKeyPathRef) {
    throw new Error('managedProvider not configured — call configureManagedProvider() first.');
  }
  for (const [providerId, t] of Object.entries(getTargets())) {
    const envKey = process.env[t.envKeyName];
    if (!envKey) {
      log.info('managed provider env key absent — provider unavailable until set', {
        providerId,
        envVar: t.envKeyName,
      });
      continue;
    }
    const existing = await storageRef.getEncryptedSecret(t.storageRef);
    if (existing) {
      try {
        const rec = JSON.parse(existing) as EncryptedRecord;
        const current = decrypt(rec, loadMasterKey(masterKeyPathRef));
        if (current === envKey) {
          log.info('managed provider key unchanged from env — no rotation needed', { providerId });
          continue;
        }
      } catch {
        // Stored record undecryptable — overwrite below.
      }
    }
    const masterKey = loadMasterKey(masterKeyPathRef);
    const record = encrypt(envKey, masterKey);
    await storageRef.upsertEncryptedSecret(
      t.storageRef,
      JSON.stringify(record),
      new Date().toISOString(),
    );
    decryptCache.delete(t.storageRef);
    log.info('managed provider key seeded from env', { providerId, envVar: t.envKeyName });
  }
}

async function resolveManagedKey(storageRefName: string): Promise<string | null> {
  const cached = decryptCache.get(storageRefName);
  if (cached !== undefined) return cached;
  if (!storageRef || !masterKeyPathRef) return null;
  const enc = await storageRef.getEncryptedSecret(storageRefName);
  if (!enc) return null;
  try {
    const rec = JSON.parse(enc) as EncryptedRecord;
    const pt = decrypt(rec, loadMasterKey(masterKeyPathRef));
    decryptCache.set(storageRefName, pt);
    return pt;
  } catch (err) {
    log.error('failed to decrypt managed key', {
      storageRef: storageRefName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Reserved usage-bucket id for the cross-tenant global ceiling. Not a real
 *  tenant: real ids are `anon:<sid>` / `user:<hash>` / `default`, so this
 *  namespaced value can't collide. */
export const GLOBAL_USAGE_TENANT = 'managed:global';
// ADR 0693 — the ONE composer for usage buckets. Do not inline a second one.


/** Operator spend backstop across ALL tenants per (day, provider).
 *  `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP` unset/0/non-numeric = disabled.
 *  Complements the per-tenant cap, which a cookie-per-visitor demo caller can
 *  evade by minting fresh anon tenants (PRD §7.1's "global token ceiling"). */
function globalDailyTokenCap(): number {
  const raw = Number(process.env.OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP ?? '0');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export interface ManagedDispatchRequest {
  /** providers.json id, e.g. 'openwop-free'. */
  userFacingProvider: string;
  /** Caller tenant; demo postures may be anon, auth posture requires user. */
  tenantId: string;
  /** ADR 0693 — the ACTING subject, when one exists. See ManagedToolsRoundRequest. */
  actingSubject?: string;
  messages: readonly ChatMessage[];
  maxTokens?: number;
  onDelta?: (delta: string) => void | Promise<void>;
  /** Streaming reasoning chunk (currently-open block). Phase 2 path. */
  onReasoningDelta?: (delta: string) => void | Promise<void>;
  /** Complete reasoning block. Caller emits one `agent.reasoned` event
   *  per call. Phase 1 path. */
  onReasoningBlock?: (block: string) => void | Promise<void>;
  signal?: AbortSignal;
}

/** Mirrors the relevant subset of DispatchResult. `provider` / `model`
 *  are the user-facing ids — the underlying provider is intentionally
 *  not exposed past this boundary. */
export interface ManagedDispatchResult {
  provider: string;
  model: string;
  completion: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
}

/** Shared managed-tier preamble: validate the target, enforce sign-in + the
 *  per-tenant and global daily token caps, resolve the server key, and inject
 *  the default system prompt. Throws ManagedProviderError on any gate. Used by
 *  BOTH the chat path and the tools-round path so the free-tier caps + provider
 *  hiding can't drift between them. */
async function prepareManagedDispatch(
  userFacingProvider: string,
  tenantId: string,
  reqMessages: readonly ChatMessage[],
  actingSubject?: string,
): Promise<{ target: ManagedTarget; apiKey: string; messages: readonly ChatMessage[]; date: string }> {
  const target = getTargets()[userFacingProvider];
  if (!target) throw new ManagedProviderError('managed_unknown', `No managed target configured for provider "${userFacingProvider}".`);
  if (managedAnonSignInRequired() && tenantId.startsWith('anon:')) throw new ManagedProviderError('sign_in_required', 'Sign in to use the free tier.');
  if (!storageRef) throw new ManagedProviderError('managed_unavailable', 'Free tier not configured on this server.');

  const date = todayUtc();
  // ADR 0693 — cap on the BUCKET, not the raw tenant. For a personal tenant the
  // bucket IS the tenant, so this is byte-identical to the previous behaviour;
  // for a shared workspace it is the acting participant's own allowance.
  const bucket = managedUsageBucket(tenantId, actingSubject);
  const usage = await storageRef.getManagedUsage(bucket, userFacingProvider, date);
  // ADR 0176 Phase 2 — balance BEFORE cap: a tenant with purchased prepaid credit is not
  // blocked by the free-tier daily cap (their balance covers usage). Checked via the
  // dependency-inversion hook so core never imports the billing feature.
  const prepaid = await managedBalanceAvailable(tenantId);
  if (prepaid <= 0 && usage.inputTokens + usage.outputTokens >= target.dailyTokenCap) {
    throw new ManagedProviderError('daily_limit_reached', `Daily limit reached (${target.dailyTokenCap} tokens). Resets at 00:00 UTC.`);
  }
  // Global ceiling — the operator's spend backstop across ALL tenants (checked
  // after the per-tenant cap so an over-cap caller gets the actionable message).
  const globalCap = globalDailyTokenCap();
  if (globalCap > 0) {
    const g = await storageRef.getManagedUsage(GLOBAL_USAGE_TENANT, userFacingProvider, date);
    if (g.inputTokens + g.outputTokens >= globalCap) {
      throw new ManagedProviderError('daily_limit_reached', 'The free tier is at capacity for today. Resets at 00:00 UTC — or bring your own key.');
    }
  }
  const apiKey = await resolveManagedKey(target.storageRef);
  if (!apiKey) throw new ManagedProviderError('managed_unavailable', 'Free tier is temporarily unavailable. Try again later or bring your own key.');

  // Inject the default system prompt when the caller didn't supply one (grounds
  // the model in OpenWOP context). Callers who DO supply one keep full control.
  const hasSystem = reqMessages.some((m) => m.role === 'system');
  const base = hasSystem ? reqMessages : [{ role: 'system' as const, content: target.defaultSystemPrompt }, ...reqMessages];
  // MMXC-1 / ADR 0611 — per-tenant cache-scope sentinel. The managed tier shares
  // ONE server key across ALL tenants, and MiniMax's AUTOMATIC prompt-prefix cache
  // keys by prompt content on that shared key — so two tenants sending the same
  // ≥512-token prefix would share a provider cache entry (the
  // `prompt-prefix-cache-cross-tenant-isolation` hazard RFC 0116 §43 elevates to a
  // protocol-tier invariant). A per-tenant, opaque, STABLE hash prepended to the
  // LEADING system content makes the cached-prefix bytes differ per tenant → the
  // provider cache structurally MISSES across tenants, while each tenant's OWN
  // prefix reuse (same hash) still HITS (within-tenant economy preserved). The
  // sentinel is secret-free (a hash, never the raw id), wire-invisible (never on
  // the OpenWOP wire/an event/an advert), and replay-invariant (present on every
  // call, so hit-vs-miss is unchanged). Defense-in-depth: MiniMax is not an
  // advertised `promptPrefixCache` provider, so this is the invariant's SPIRIT, not
  // its cachePrefixId letter — hence no RFC and no capability advert.
  //
  // Stamp the FIRST system message's content, NOT a second system message: the
  // Anthropic path keeps only the first system turn and the chat-responder
  // de-dupes back-to-back systems, so a separate sentinel message could be dropped
  // — a leading sentinel INSIDE the one system message survives every path. `base`
  // always carries a system message (the default is injected above when absent).
  const scope = `[cache-scope ${cacheScopeHash(tenantId)}] `;
  let stamped = false;
  const messages = base.map((m) => {
    if (stamped || m.role !== 'system') return m;
    stamped = true;
    return { ...m, content: prependCacheScope(scope, m.content) };
  });
  return { target, apiKey, messages, date };
}

/** MMXC-1 / ADR 0611 — an opaque, stable, secret-free per-tenant cache-scope
 *  discriminator: a SHA-256 slice of the tenant id. Stable per tenant (so a
 *  tenant's own prefix reuse still hits the provider cache) and opaque (the raw
 *  tenant id is never sent to the provider or written to a log via this path). */
function cacheScopeHash(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
}

/** Prepend the cache-scope sentinel to a system message's content, preserving a
 *  structured (`ContentPart[]`) body by leading it with a text part. */
function prependCacheScope(scope: string, content: string | readonly ContentPart[]): string | readonly ContentPart[] {
  if (typeof content === 'string') return scope + content;
  return [{ type: 'text', text: scope }, ...content];
}

/** Best-effort managed usage increment (per-tenant + reserved global bucket) —
 *  never fails the call on a write error (the safer skew is a free turn). */
async function recordManagedUsage(tenantId: string, userFacingProvider: string, date: string, inTok: number, outTok: number, actingSubject?: string): Promise<void> {
  if (!storageRef || (inTok <= 0 && outTok <= 0)) return;
  try {
    // ADR 0693 — charge the same bucket the cap was read from, or the two
    // disagree and a participant is capped on a total they never accrued.
    await storageRef.incrementManagedUsage(managedUsageBucket(tenantId, actingSubject), userFacingProvider, date, inTok, outTok);
    await storageRef.incrementManagedUsage(GLOBAL_USAGE_TENANT, userFacingProvider, date, inTok, outTok);
    // ADR 0176 Phase 2 — draw the consumed tokens from the tenant's prepaid balance
    // first (best-effort; no-op when billing/balance is unwired).
    await managedBalanceDraw(tenantId, inTok + outTok);
  } catch (err) {
    log.warn('failed to increment managed usage', { tenantId, provider: userFacingProvider, error: err instanceof Error ? err.message : String(err) });
  }
}

export interface ManagedToolsRoundRequest {
  userFacingProvider: string;
  tenantId: string;
  /** ADR 0693 — the ACTING subject, when one exists. Optional on purpose: the
   *  public chat widget is anonymous by design, so an absent subject is a
   *  permanent legal state that charges the tenant (today's behaviour). */
  actingSubject?: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
}
export interface ManagedToolsRoundResult {
  text: string;
  toolUses: ToolUseBlock[];
  inputTokens?: number;
  outputTokens?: number;
  /** ADR 0148 A2 (OQ#3) — tokens served from MiniMax's AUTOMATIC prefix cache
   *  this round (0/absent when the prefix was below the ≥512-token floor or the
   *  first, cache-writing round). MANAGED-path only, which never emits
   *  `provider.usage` — so on this path it is genuinely internal (the `managed_
   *  prompt_cache` log). The BYOK path surfaces its equivalent on the wire; see
   *  `DispatchResult.usage.cachedReadTokens`. */
  cachedReadTokens?: number;
}

/** ONE managed (free-tier) tool-calling round — the same caps + server key +
 *  provider hiding as `dispatchManagedChat`, but a single tool round (the
 *  observe→act loop is the caller's). The underlying provider is never exposed.
 *  Only the MiniMax-backed managed tier supports tools here. */
/** ADR 0148 A2 (OQ#3) — emit the prefix-cache split for a managed MiniMax call so
 *  the free-tier caching win is observable in prod (grep `managed_prompt_cache`).
 *  Only when the provider reported a cache read (rounds 2..N of a tool turn, and
 *  cross-turn chat reuse). Best-effort; never affects the call. */
function logManagedCache(kind: 'tools-round' | 'chat', tenantId: string, provider: string, promptTokens?: number, cachedReadTokens?: number): void {
  if (!cachedReadTokens || cachedReadTokens <= 0) return;
  const prompt = promptTokens ?? 0;
  log.info('managed_prompt_cache', {
    kind, tenantId, provider,
    promptTokens: prompt,
    cachedReadTokens,
    cacheHitRatio: prompt > 0 ? Math.round((cachedReadTokens / prompt) * 100) / 100 : 0,
  });
}

export async function dispatchManagedToolsRound(req: ManagedToolsRoundRequest): Promise<ManagedToolsRoundResult> {
  const { target, apiKey, messages, date } = await prepareManagedDispatch(req.userFacingProvider, req.tenantId, req.messages, req.actingSubject);
  if (target.provider !== 'minimax') {
    throw new ManagedProviderError('managed_unavailable', 'Tool calling is not available on this managed tier.');
  }
  const round = await dispatchMiniMaxToolsRound({
    model: target.model,
    apiKey,
    messages,
    tools: req.tools,
    ...(req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  await recordManagedUsage(req.tenantId, req.userFacingProvider, date, round.inputTokens ?? 0, round.outputTokens ?? 0, req.actingSubject);
  logManagedCache('tools-round', req.tenantId, req.userFacingProvider, round.inputTokens, round.cachedReadTokens);
  return {
    text: round.text,
    toolUses: round.toolUses,
    ...(round.inputTokens != null ? { inputTokens: round.inputTokens } : {}),
    ...(round.outputTokens != null ? { outputTokens: round.outputTokens } : {}),
    ...(round.cachedReadTokens != null ? { cachedReadTokens: round.cachedReadTokens } : {}),
  };
}

export async function dispatchManagedChat(
  req: ManagedDispatchRequest,
): Promise<ManagedDispatchResult> {
  const { target, apiKey, messages, date } = await prepareManagedDispatch(
    req.userFacingProvider, req.tenantId, req.messages, req.actingSubject,
  );

  const result = await dispatchChat({
    provider: target.provider,
    model: target.model,
    apiKey,
    messages,
    ...(req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
    ...(req.onDelta ? { onDelta: req.onDelta } : {}),
    ...(req.onReasoningDelta ? { onReasoningDelta: req.onReasoningDelta } : {}),
    ...(req.onReasoningBlock ? { onReasoningBlock: req.onReasoningBlock } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });

  await recordManagedUsage(req.tenantId, req.userFacingProvider, date, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0, req.actingSubject);
  logManagedCache('chat', req.tenantId, req.userFacingProvider, result.usage?.inputTokens, result.usage?.cachedReadTokens);

  return {
    provider: req.userFacingProvider,
    model: req.userFacingProvider,
    completion: result.completion,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
  };
}

export interface ManagedProviderStatus {
  /** providers.json id, e.g. 'openwop-free'. */
  providerId: string;
  /** True when a server-held key is seeded AND decryptable — i.e. a
   *  managed dispatch for this provider will get past `resolveManagedKey`.
   *  False is the silent-degrade failure mode: the tier is advertised to
   *  users but every call would fail with `managed_unavailable`. */
  ready: boolean;
  /** Human-readable reason when `ready` is false; empty string when ready. */
  detail: string;
}

/**
 * Readiness check for managed providers, surfaced via GET /readiness.
 *
 * For each provider advertised with `managed: true` in providers.json,
 * report whether its server-held key is actually seeded + decryptable.
 * This guards the exact failure that was previously invisible until a
 * user ran a workflow: the key was never seeded (env absent at boot, or
 * a dropped/unmounted secret on redeploy), `bootstrapManagedProvider`
 * logged a single info line and degraded quietly, and every "Try it
 * free" call failed with `managed_unavailable`. Reporting it here turns
 * that into a deploy-time signal.
 *
 * Read-only and idempotent — reuses the same decrypt path (+ cache) as
 * dispatch, so it introduces no new key exposure beyond what a normal
 * managed call already does.
 */
export async function getManagedProviderStatuses(): Promise<ManagedProviderStatus[]> {
  const targets = getTargets();
  const statuses: ManagedProviderStatus[] = [];
  for (const providerId of listManagedProviderIds()) {
    const target = targets[providerId];
    if (!target) {
      statuses.push({
        providerId,
        ready: false,
        detail:
          'advertised as managed in providers.json but no server-side dispatch target is configured',
      });
      continue;
    }
    if (!storageRef || !masterKeyPathRef) {
      statuses.push({
        providerId,
        ready: false,
        detail: 'managed-provider store not configured (configureManagedProvider was not called)',
      });
      continue;
    }
    const key = await resolveManagedKey(target.storageRef);
    statuses.push(
      key
        ? { providerId, ready: true, detail: '' }
        : {
            providerId,
            ready: false,
            detail: `no server-held key seeded — set ${target.envKeyName} and restart`,
          },
    );
  }
  return statuses;
}

/**
 * Resolve the cleartext managed key for the speech path (RFC 0105).
 *
 * The managed MiniMax credential that backs the free chat tier
 * (`managed:openwop-free`, seeded from `MINIMAX_API_KEY`) is the same
 * key the T2A speech endpoint authenticates with. Reuse the EXACT
 * resolution the chat path uses (`getTargets()` → `resolveManagedKey()`)
 * rather than re-reading the raw env var — so the speech path inherits
 * the same encrypt-at-rest / decrypt-in-process discipline and never
 * bypasses BYOK with a raw key. Returns null when no managed key is
 * seeded/decryptable (caller falls back to the deterministic stub).
 */
export async function resolveManagedSpeechKey(): Promise<string | null> {
  const target = getTargets()['openwop-free'];
  if (!target) return null;
  if (!storageRef || !masterKeyPathRef) return null;
  return resolveManagedKey(target.storageRef);
}

/** Test affordance — drop in-process caches without touching storage. */
export function _clearManagedCacheForTests(): void {
  decryptCache.clear();
}
