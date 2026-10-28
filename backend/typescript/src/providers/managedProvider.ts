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
 *     `OPENWOP_MANAGED_DAILY_TOKEN_CAP` (default `DEFAULT_MANAGED_DAILY_TOKEN_CAP`).
 *   - Global daily ceiling (optional): input+output combined across ALL
 *     tenants, per (day, provider), via
 *     `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP` (unset/0 = disabled).
 *     This is the operator's spend backstop for login-free demo postures:
 *     the per-tenant cap alone is evadable on cookie-per-visitor deploys
 *     (each fresh cookie jar is a fresh anon tenant), so a public demo
 *     SHOULD set the global ceiling. Tracked under the reserved
 *     `managed:global` usage bucket (not a real tenant).
 *   - ADR 0821 D2 — consumption order: the free daily allowance (per-subject
 *     cap AND the optional per-tenant ceiling
 *     `OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP`) → the plan's monthly
 *     `aiCreditsMonthly` → the purchased balance. Only the part of a call past
 *     the free allowance is drawn (`host/managedCredits.ts`).
 *     `OPENWOP_BILLING_EXEMPT_TENANTS` are never refused by the free allowance
 *     and never drawn; the global ceiling still binds them.
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
import { managedBalanceAvailable } from '../host/managedBalanceHook.js';
import {
  configureManagedCredits, drawCredits, planAllowanceRemaining, recordFeatureSpend, resolveAttributionFeature,
} from '../host/managedCredits.js';
import { isBillingExemptTenant } from '../host/planLimitsSeam.js';
import { isSinglePrincipalTenant } from '../host/accessControlService.js';
import { createHash } from 'node:crypto';
import { listManagedProviderIds } from './catalog.js';
import { dispatchChat, type ChatMessage, type ContentPart, type ProviderId } from './dispatch.js';
import { dispatchGoogleToolsRound, dispatchMiniMaxToolsRound, dispatchOpenAIToolsRound } from './dispatchProviderTools.js';
import { dispatchAnthropicToolsRound, type ToolDef, type ToolUseBlock } from './dispatchAnthropicTools.js';
import { OWNED_REF_PREFIXES } from '../byok/refNamespaces.js';
import { resolveSecret } from '../byok/secretResolver.js';

const log = createLogger('providers.managed');

export const MANAGED_REF_PREFIX = OWNED_REF_PREFIXES.managed;
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
  /** Storage ref under which the env-seeded, encrypted server-held key lives. */
  storageRef: string;
  /** ADR 0990 D2 — the host-global Secrets Vault ref the operator types the key
   *  into. Read before the env row, and never another provider's. */
  vaultRef: string;
  /** Env var read at bootstrap to seed the storage row. */
  envKeyName: string;
  /** Per-tenant per-day cap (input + output tokens combined). */
  dailyTokenCap: number;
  /** ADR 0786 D6 — the weight a CACHED prompt token carries in a PREPAID balance
   *  draw (the provider's cache-read price ÷ its input price). The daily cap keeps
   *  full weight; only customer money is discounted. */
  cachedReadWeight: number;
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
/** `OPENWOP_MANAGED_CACHED_READ_WEIGHT`, clamped to [0, 1]; a missing or
 *  malformed value falls back to the target's default. */
function cachedReadWeightFromEnv(fallback: number): number {
  const raw = process.env.OPENWOP_MANAGED_CACHED_READ_WEIGHT;
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * ADR 0786 D6 — the tokens a managed call draws from a PREPAID balance. ADR 0176
 * made this a precondition of prepaid going live: a cached prompt token costs the
 * operator a fraction of an uncached one, so charging it at full weight over-bills
 * a paying customer. Cross-provider semantics differ (`dispatch.ts`): an
 * OpenAI-compatible provider's `cached_tokens` is a SUBSET of the prompt tokens,
 * Anthropic's `cache_read_input_tokens` is DISJOINT from them.
 */
export function prepaidDrawTokens(
  provider: string,
  usage: { inputTokens: number; outputTokens: number; cachedReadTokens?: number },
  cachedReadWeight: number,
): number {
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const cachedRaw = Math.max(0, usage.cachedReadTokens ?? 0);
  if (provider === 'anthropic') return Math.ceil(input + cachedRaw * cachedReadWeight + output);
  const cached = Math.min(cachedRaw, input);
  return Math.ceil(input - cached + cached * cachedReadWeight + output);
}

/**
 * ADR 0773 G-10e — the per-tenant daily allowance when the operator sets none.
 * It was 50,000, which is smaller than ONE Pair Canvas first draft (64–140k
 * prompt tokens, measured on the managed tier 2026-10-05), so graduating Pair
 * ON by default would have handed every fresh install a feature whose first use
 * hits the limit. 150,000 fits the largest measured first draft once a day.
 *
 * Kept that small on purpose: since ADR 0821 this is the FREE allowance, spent
 * before plan credits and paid balance, and it is per acting subject, so every
 * member of a workspace gets it. An operator who sells credits gives away this
 * much per member per day. At MiniMax-M3's $0.30/1M input it is at most ~$0.05
 * per subject per day; on a cookie-per-visitor demo it is per visitor, so the
 * spend backstop there remains `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP`.
 */
export const DEFAULT_MANAGED_DAILY_TOKEN_CAP = 150_000;

/** ADR 0990 D1 — the underlying providers a managed tier can run on: the four
 *  with both a chat adapter and a tools-round adapter. Chosen by the stored
 *  superadmin setting, else `OPENWOP_MANAGED_PROVIDER` (default `minimax`). */
export const MANAGED_UNDERLYING_PROVIDERS = ['minimax', 'anthropic', 'openai', 'google'] as const;
export type ManagedUnderlying = typeof MANAGED_UNDERLYING_PROVIDERS[number];

export function isManagedUnderlying(p: unknown): p is ManagedUnderlying {
  return typeof p === 'string' && (MANAGED_UNDERLYING_PROVIDERS as readonly string[]).includes(p);
}

interface ManagedProviderSpec {
  envKeyName: string;
  envModelName: string;
  defaultModel: string;
  /** The env-seeded storage row. Each provider has its OWN row: with a shared
   *  row, a switch before the new provider's key is set would send the old
   *  provider's key to the new provider's API. A missing key must read as
   *  "unavailable", never as another provider's key. */
  envStorageRef: string;
  /** Cache-read price ÷ input price, the ADR 0786 D6 prepaid-draw weight. */
  cachedReadWeight: number;
}

const PROVIDER_SPECS: Record<ManagedUnderlying, ManagedProviderSpec> = {
  // MiniMax-M3: $0.06 cache read ÷ $0.30 input per 1M = 0.2 (re-measured
  // 2026-09-29, ADR 0786 D6). The row keeps its pre-0990 name.
  minimax: { envKeyName: 'MINIMAX_API_KEY', envModelName: 'MINIMAX_MODEL', defaultModel: 'MiniMax-M3', envStorageRef: `${MANAGED_REF_PREFIX}openwop-free`, cachedReadWeight: 0.2 },
  // Anthropic cache reads are billed at 0.1x the base input price.
  anthropic: { envKeyName: 'ANTHROPIC_API_KEY', envModelName: 'ANTHROPIC_MODEL', defaultModel: 'claude-sonnet-5-5', envStorageRef: `${MANAGED_REF_PREFIX}openwop-free@anthropic`, cachedReadWeight: 0.1 },
  // OpenAI cached input is billed at 0.1x on the GPT-5 family.
  openai: { envKeyName: 'OPENAI_API_KEY', envModelName: 'OPENAI_MODEL', defaultModel: 'gpt-5.6-terra', envStorageRef: `${MANAGED_REF_PREFIX}openwop-free@openai`, cachedReadWeight: 0.1 },
  // Gemini implicit-cache reads: 0.25x is the conservative published rate.
  google: { envKeyName: 'GOOGLE_API_KEY', envModelName: 'GOOGLE_MODEL', defaultModel: 'gemini-3.8-flash', envStorageRef: `${MANAGED_REF_PREFIX}openwop-free@google`, cachedReadWeight: 0.25 },
};

/** ADR 0990 D2 — the host-global Secrets Vault ref for a provider's free-tier
 *  key. Not under `managed:`: that prefix is owned by this module (ADR 0779), so
 *  the Secrets Vault refuses to write it. */
export function managedTierVaultRef(provider: ManagedUnderlying): string {
  return `free-tier:${provider}`;
}

/** The model a provider runs when the operator names none. */
export function managedTierDefaultModel(provider: ManagedUnderlying): string {
  return PROVIDER_SPECS[provider].defaultModel;
}

/** `OPENWOP_MANAGED_PROVIDER`, or `minimax` when unset. An unknown value makes
 *  the managed tier UNAVAILABLE (logged as an error at boot) rather than
 *  falling back to MiniMax, because the operator chose the provider for its
 *  data terms and a silent fallback would break the promise they made. */
export function managedUnderlyingFromEnv(): ManagedUnderlying | null {
  const raw = (process.env.OPENWOP_MANAGED_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '') return 'minimax';
  return isManagedUnderlying(raw) ? raw : null;
}

/** ADR 0990 D1 — the superadmin's stored selection, as the feature reports it.
 *  `provider` is not narrowed: a stored value that no longer validates must
 *  reach the resolver so it can make the tier unavailable (D4). */
export interface ManagedTierSelection {
  provider: string;
  model: string;
  /** D5 — optional per-subject daily cap for this provider; null/absent = env. */
  dailyTokenCap?: number | null;
}
type ManagedTierConfigProvider = () => Promise<ManagedTierSelection | null>;
let tierConfigProvider: ManagedTierConfigProvider | null = null;
let tierMemo: { at: number; value: ManagedTierSelection | null } | null = null;
let tierRefresh: Promise<void> | null = null;
let tierRefreshStartedAt = 0;
/** A refresh older than this is treated as hung and replaced. */
const TIER_REFRESH_MAX_MS = 10_000;
/** How long one instance trusts its read of the setting. A save invalidates the
 *  saving instance at once; every other instance follows within this window. */
const TIER_MEMO_TTL_MS = 15_000;

/** ADR 0990 D1 fill-a-seam (the ADR 0318 shape) — the managed-tier-admin
 *  feature registers its reader here at boot. Core never imports the feature;
 *  unregistered ⇒ env-only, exactly as before. */
export function registerManagedTierConfigProvider(fn: ManagedTierConfigProvider | null): void {
  tierConfigProvider = fn;
  tierMemo = null;
  if (fn) void refreshManagedTierSelection(true);
}

/** Drop this instance's memo so the next dispatch re-reads the setting. */
export function invalidateManagedTierSelection(): void {
  tierMemo = null;
}

/** Re-read the stored selection when the memo is stale. A failed read keeps the
 *  last good selection (an operator's data-terms choice must not flip back to
 *  env on a store hiccup); with none, the env default serves (D1). */
export async function refreshManagedTierSelection(force = false): Promise<void> {
  if (!tierConfigProvider) return;
  if (!force && tierMemo && Date.now() - tierMemo.at < TIER_MEMO_TTL_MS) return;
  // A read that never settles must not wedge every later refresh: past the bound,
  // start a new one (the stale one's late settle cannot clear it, see below).
  if (tierRefresh && Date.now() - tierRefreshStartedAt < TIER_REFRESH_MAX_MS) return tierRefresh;
  const read = tierConfigProvider;
  tierRefreshStartedAt = Date.now();
  const attempt: Promise<void> = (async () => {
    try {
      tierMemo = { at: Date.now(), value: await read() };
    } catch (err) {
      log.warn('managed tier setting read failed — keeping the last good selection, else env', {
        error: err instanceof Error ? err.message : String(err),
        hasLastGood: tierMemo != null,
      });
      if (tierMemo) tierMemo = { ...tierMemo, at: Date.now() };
    }
  })().finally(() => { if (tierRefresh === attempt) tierRefresh = null; });
  tierRefresh = attempt;
  return attempt;
}

export type ManagedTierSource = 'setting' | 'env' | 'default';

/** ADR 0990 D1 — the ONE place the effective selection is decided: the stored
 *  setting, else env, else MiniMax. Null when env names an unknown provider. */
export function effectiveManagedTierSelection(): (ManagedTierSelection & { source: ManagedTierSource }) | null {
  const stored = tierMemo?.value;
  if (stored) return { ...stored, source: 'setting' };
  const env = managedUnderlyingFromEnv();
  if (env === null) return null;
  const spec = PROVIDER_SPECS[env];
  const envModel = process.env[spec.envModelName];
  const fromEnv = (process.env.OPENWOP_MANAGED_PROVIDER ?? '').trim() !== '' || envModel != null;
  return { provider: env, model: envModel ?? spec.defaultModel, source: fromEnv ? 'env' : 'default' };
}

function envDailyTokenCap(): number {
  const capRaw = Number(process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP);
  return Number.isFinite(capRaw) && capRaw > 0 ? capRaw : DEFAULT_MANAGED_DAILY_TOKEN_CAP;
}

function getTargets(): Record<string, ManagedTarget> {
  const selection = effectiveManagedTierSelection();
  // D4 — a stored provider that no longer validates is unavailable, never a
  // silent fallback to another provider.
  if (selection === null || !isManagedUnderlying(selection.provider)) return {};
  const provider = selection.provider;
  const spec = PROVIDER_SPECS[provider];
  const cap = selection.dailyTokenCap != null && selection.dailyTokenCap > 0 ? selection.dailyTokenCap : envDailyTokenCap();
  return {
    'openwop-free': {
      provider,
      model: selection.model,
      storageRef: spec.envStorageRef,
      vaultRef: managedTierVaultRef(provider),
      envKeyName: spec.envKeyName,
      dailyTokenCap: cap,
      cachedReadWeight: cachedReadWeightFromEnv(spec.cachedReadWeight),
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
  void refreshManagedTierSelection();
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
  configureManagedCredits({ storage: input.storage });
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
  if (managedUnderlyingFromEnv() === null) {
    log.error('OPENWOP_MANAGED_PROVIDER is not a supported managed provider — the managed tier is unavailable', {
      value: process.env.OPENWOP_MANAGED_PROVIDER,
      supported: MANAGED_UNDERLYING_PROVIDERS,
    });
  }
  // ADR 0990 — seed EVERY provider's env key, not only the selected one, so a
  // runtime switch in the admin setting finds its env fallback already stored.
  for (const providerId of MANAGED_UNDERLYING_PROVIDERS) {
    const spec = PROVIDER_SPECS[providerId];
    const t = { envKeyName: spec.envKeyName, storageRef: spec.envStorageRef };
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

/** ADR 0990 D2 — a provider's free-tier key: the host-global Secrets Vault ref
 *  first, then the env-seeded row. Each provider reads only its own two refs. */
async function resolveProviderKey(provider: ManagedUnderlying): Promise<{ key: string; source: 'vault' | 'env' } | null> {
  try {
    // Scopeless on purpose: the Vault's host scope. Null under ephemeral mode.
    const vaulted = await resolveSecret(managedTierVaultRef(provider));
    if (vaulted) return { key: vaulted, source: 'vault' };
  } catch (err) {
    log.warn('managed tier vault read failed — trying the env key', {
      provider, error: err instanceof Error ? err.message : String(err),
    });
  }
  const env = await resolveManagedKey(PROVIDER_SPECS[provider].envStorageRef);
  return env ? { key: env, source: 'env' } : null;
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

/** ADR 0821 D2 (architect #6) — the per-TENANT free daily ceiling, summing every
 *  subject bucket the tenant owns. The per-subject cap alone scales the free
 *  allowance with seats (N members ⇒ N× free before plan or packs).
 *  `OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP` unset/0/non-numeric = disabled, which
 *  is today's behaviour. */
function tenantDailyTokenCap(): number {
  const raw = Number(process.env.OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP ?? '0');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export interface ManagedDispatchRequest {
  /** providers.json id, e.g. 'openwop-free'. */
  userFacingProvider: string;
  /** Caller tenant; demo postures may be anon, auth posture requires user. */
  tenantId: string;
  /** ADR 0693 — the ACTING subject, when one exists. See ManagedToolsRoundRequest. */
  actingSubject?: string;
  /** ADR 0821 D4 — the owning feature of this call (`chat`, `chat-widget`, `cms`, …).
   *  Absent ⇒ derived from `runId`'s attribution block, else `unattributed`. */
  featureId?: string;
  /** ADR 0821 D4 — the workflow run this call serves, for attribution only. */
  runId?: string;
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
): Promise<{ target: ManagedTarget; apiKey: string; messages: readonly ChatMessage[]; date: string; meter: ManagedMeter }> {
  await refreshManagedTierSelection();
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
  // ADR 0821 D2 — the consumption order: free daily allowance → plan monthly
  // allowance → purchased balance. Step 1 is bounded by BOTH the per-subject cap
  // (above) AND, when configured, the per-tenant ceiling (architect #6), which
  // sums every bucket the tenant owns through the SAME matcher teardown uses.
  const subjectUsed = usage.inputTokens + usage.outputTokens;
  let freeRemaining = Math.max(0, target.dailyTokenCap - subjectUsed);
  let tenantCeilingBinds = false;
  const tenantCap = tenantDailyTokenCap();
  if (tenantCap > 0) {
    // A single-principal tenant has no participant buckets: its own row IS the sum.
    let tenantUsed = subjectUsed;
    if (!isSinglePrincipalTenant(tenantId)) {
      const { exact, likePattern, likeEscape } = usageBucketMatchersForTenant(tenantId);
      const t = await storageRef.sumManagedUsageForTenant(exact, userFacingProvider, date, { pattern: likePattern, escape: likeEscape });
      tenantUsed = t.inputTokens + t.outputTokens;
    }
    const tenantRemaining = Math.max(0, tenantCap - tenantUsed);
    if (tenantRemaining < freeRemaining) { freeRemaining = tenantRemaining; tenantCeilingBinds = true; }
  }
  // ADR 0821 architect #1 — an operator-service tenant (conformance, showcase) is
  // exempt from LIMITS and CREDITS: never refused by the free allowance and never
  // drawn. The global ceiling below still binds it (operator backstop), and the
  // feature paywall is untouched (it never reads this list).
  const exempt = isBillingExemptTenant(tenantId);
  if (!exempt && freeRemaining <= 0) {
    // Free allowance spent ⇒ steps 2–3. Read lazily: a call inside the free
    // allowance (the common case) costs no allowance or balance read at all.
    // Both reads go through dependency-inversion seams, so core never imports billing.
    const payable = (await planAllowanceRemaining(tenantId)) > 0 || (await managedBalanceAvailable(tenantId)) > 0;
    if (!payable) {
      throw new ManagedProviderError('daily_limit_reached', tenantCeilingBinds
        ? `Your workspace's daily free AI allowance is used up (${tenantCap} tokens). Resets at 00:00 UTC.`
        : `Daily limit reached (${target.dailyTokenCap} tokens). Resets at 00:00 UTC.`);
    }
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
  const apiKey = (await resolveProviderKey(target.provider as ManagedUnderlying))?.key;
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
  return { target, apiKey, messages, date, meter: { freeRemaining, exempt } };
}

/** ADR 0821 D2 — what `prepareManagedDispatch` learned about who pays for the call. */
interface ManagedMeter {
  /** Raw tokens still inside the free daily allowance when the call started. */
  freeRemaining: number;
  /** An `OPENWOP_BILLING_EXEMPT_TENANTS` tenant: never drawn. */
  exempt: boolean;
}

/**
 * ADR 0821 D2 — the token-equivalents a call charges past the free allowance.
 * The part of the call that fit inside `freeRemaining` (raw tokens, the cap
 * rail's unit) is free; the overflow's share of the cache-WEIGHTED draw
 * (ADR 0786 D6) is charged. Pure.
 */
export function chargeableTokens(rawTokens: number, weightedTokens: number, freeRemaining: number): number {
  if (rawTokens <= 0 || weightedTokens <= 0) return 0;
  const overflow = Math.max(0, rawTokens - Math.max(0, freeRemaining));
  if (overflow === 0) return 0;
  if (overflow >= rawTokens) return weightedTokens;
  return Math.ceil((weightedTokens * overflow) / rawTokens);
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
async function recordManagedUsage(
  tenantId: string, userFacingProvider: string, date: string, inTok: number, outTok: number, actingSubject: string | undefined,
  draw: { provider: string; cachedReadTokens?: number; cachedReadWeight: number },
  meter: ManagedMeter,
): Promise<number> {
  if (!storageRef || (inTok <= 0 && outTok <= 0)) return 0;
  // ADR 0990 D5 — Anthropic reports cache reads DISJOINT from input tokens, so
  // the cap rows would never see them. Count them at full weight, as the
  // subset-reporting providers already are.
  const capInTok = draw.provider === 'anthropic' ? inTok + Math.max(0, draw.cachedReadTokens ?? 0) : inTok;
  try {
    // ADR 0693 — charge the same bucket the cap was read from, or the two
    // disagree and a participant is capped on a total they never accrued.
    await storageRef.incrementManagedUsage(managedUsageBucket(tenantId, actingSubject), userFacingProvider, date, capInTok, outTok);
    await storageRef.incrementManagedUsage(GLOBAL_USAGE_TENANT, userFacingProvider, date, capInTok, outTok);
    if (meter.exempt) return 0;
    // ADR 0821 D2 (fixes G1) — only the part of the call PAST the free daily
    // allowance is charged, to the plan's monthly allowance and then the
    // purchased balance (`drawCredits`). ADR 0786 D6: cached prompt tokens draw
    // at the target's weight; the cap bucket above still records full weight
    // (a cost rail should trip early).
    const weighted = prepaidDrawTokens(draw.provider, { inputTokens: inTok, outputTokens: outTok, ...(draw.cachedReadTokens != null ? { cachedReadTokens: draw.cachedReadTokens } : {}) }, draw.cachedReadWeight);
    const charge = chargeableTokens(inTok + outTok, weighted, meter.freeRemaining);
    if (charge <= 0) return 0;
    const drawn = await drawCredits(tenantId, charge);
    return drawn.plan + drawn.balance;
  } catch (err) {
    log.warn('failed to increment managed usage', { tenantId, provider: userFacingProvider, error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

/** ADR 0821 D4 — fold this call into the per-(tenant, day, feature) attribution row.
 *  AFTER the call and best-effort: `recordFeatureSpend` never throws, and the cap
 *  row above is untouched (architect #2). */
async function recordManagedAttribution(
  req: { tenantId: string; featureId?: string; runId?: string },
  inTok: number, outTok: number, chargedTokens: number,
): Promise<void> {
  if (inTok <= 0 && outTok <= 0) return;
  const featureId = await resolveAttributionFeature({
    ...(req.featureId ? { featureId: req.featureId } : {}),
    ...(req.runId ? { runId: req.runId } : {}),
  });
  await recordFeatureSpend({ tenantId: req.tenantId, featureId, inputTokens: inTok, outputTokens: outTok, chargedTokens });
}

export interface ManagedToolsRoundRequest {
  userFacingProvider: string;
  tenantId: string;
  /** ADR 0693 — the ACTING subject, when one exists. Optional on purpose: the
   *  public chat widget is anonymous by design, so an absent subject is a
   *  permanent legal state that charges the tenant (today's behaviour). */
  actingSubject?: string;
  /** ADR 0821 D4 — the owning feature of this call (`chat`, `chat-widget`, `cms`, …).
   *  Absent ⇒ derived from `runId`'s attribution block, else `unattributed`. */
  featureId?: string;
  /** ADR 0821 D4 — the workflow run this call serves, for attribution only. */
  runId?: string;
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
 *  MiniMax- and Anthropic-backed managed tiers support tools here. */
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
  const { target, apiKey, messages, date, meter } = await prepareManagedDispatch(req.userFacingProvider, req.tenantId, req.messages, req.actingSubject);
  const toolsRound = target.provider === 'minimax' ? dispatchMiniMaxToolsRound
    : target.provider === 'anthropic' ? dispatchAnthropicToolsRound
    : target.provider === 'openai' ? dispatchOpenAIToolsRound
    : target.provider === 'google' ? dispatchGoogleToolsRound
    : null;
  if (!toolsRound) {
    throw new ManagedProviderError('managed_unavailable', 'Tool calling is not available on this managed tier.');
  }
  const round = await toolsRound({
    model: target.model,
    apiKey,
    messages,
    tools: req.tools,
    ...(req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  const charged = await recordManagedUsage(req.tenantId, req.userFacingProvider, date, round.inputTokens ?? 0, round.outputTokens ?? 0, req.actingSubject,
    { provider: target.provider, ...(round.cachedReadTokens != null ? { cachedReadTokens: round.cachedReadTokens } : {}), cachedReadWeight: target.cachedReadWeight }, meter);
  logManagedCache('tools-round', req.tenantId, req.userFacingProvider, round.inputTokens, round.cachedReadTokens);
  await recordManagedAttribution(req, round.inputTokens ?? 0, round.outputTokens ?? 0, charged);
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
  const { target, apiKey, messages, date, meter } = await prepareManagedDispatch(
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

  const charged = await recordManagedUsage(req.tenantId, req.userFacingProvider, date, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0, req.actingSubject,
    { provider: target.provider, ...(result.usage?.cachedReadTokens != null ? { cachedReadTokens: result.usage.cachedReadTokens } : {}), cachedReadWeight: target.cachedReadWeight }, meter);
  logManagedCache('chat', req.tenantId, req.userFacingProvider, result.usage?.inputTokens, result.usage?.cachedReadTokens);
  await recordManagedAttribution(req, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0, charged);

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
  await refreshManagedTierSelection();
  const targets = getTargets();
  const selection = effectiveManagedTierSelection();
  const statuses: ManagedProviderStatus[] = [];
  for (const providerId of listManagedProviderIds()) {
    const target = targets[providerId];
    if (!target) {
      statuses.push({
        providerId,
        ready: false,
        // D4 — say WHY: a saved or env provider this host does not support.
        detail: selection && !isManagedUnderlying(selection.provider)
          ? `the free-tier provider "${selection.provider}" (${selection.source}) is not supported; choose one of ${MANAGED_UNDERLYING_PROVIDERS.join(', ')}`
          : 'advertised as managed in providers.json but no server-side dispatch target is configured',
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
    const key = await resolveProviderKey(target.provider as ManagedUnderlying);
    statuses.push(
      key
        ? { providerId, ready: true, detail: '' }
        : {
            providerId,
            ready: false,
            detail: `no server-held key for ${target.provider} — add the ${target.vaultRef} key in Access → Connections (Host-global), or set ${target.envKeyName} and restart`,
          },
    );
  }
  return statuses;
}

/**
 * Resolve the cleartext managed key for the speech path (RFC 0105).
 *
 * Managed speech is MiniMax-only (`MANAGED_SPEECH_PROVIDERS`, ADR 0990 D7), so
 * this is ALWAYS the MiniMax key, whichever provider the chat tier runs on.
 * Resolving it through the selected chat target would send an Anthropic,
 * OpenAI or Google key to MiniMax's T2A endpoint the moment the operator
 * switched. Same ladder as chat (Secrets Vault, then the env-seeded row), so
 * the speech path never reads a raw env var. Returns null when no MiniMax key
 * is configured (caller falls back to the deterministic stub).
 */
export async function resolveManagedSpeechKey(): Promise<string | null> {
  if (!storageRef || !masterKeyPathRef) return null;
  return (await resolveProviderKey('minimax'))?.key ?? null;
}

/** ADR 0990 D3 — one row of the admin dropdown: can this provider serve the free
 *  tier right now? Reports WHERE its key resolves from, never the key. */
export interface ManagedTierProviderOption {
  provider: ManagedUnderlying;
  ready: boolean;
  keySource: 'vault' | 'env' | null;
  vaultRef: string;
  envKeyName: string;
  defaultModel: string;
}

export async function describeManagedTierProviders(): Promise<ManagedTierProviderOption[]> {
  const out: ManagedTierProviderOption[] = [];
  for (const provider of MANAGED_UNDERLYING_PROVIDERS) {
    const spec = PROVIDER_SPECS[provider];
    const key = storageRef && masterKeyPathRef ? await resolveProviderKey(provider) : null;
    out.push({
      provider,
      ready: key != null,
      keySource: key?.source ?? null,
      vaultRef: managedTierVaultRef(provider),
      envKeyName: spec.envKeyName,
      defaultModel: spec.defaultModel,
    });
  }
  return out;
}

export type ManagedTierTestResult =
  | { ok: true; provider: ManagedUnderlying; model: string; latencyMs: number; reply: string }
  | { ok: false; provider: string; model: string; code: string; message: string };

/**
 * ADR 0990 D3 — "Send a test message": one bounded call to a CANDIDATE provider
 * and model, through the real dispatch and the real key ladder, before the
 * owner saves it. This is how a wrong model id is caught before visitors hit
 * it. Charged to the operator's own usage bucket and the global ceiling, never
 * to credits. The result names the provider; the key never leaves this module.
 */
export async function testManagedTierCandidate(input: {
  provider: string; model: string; tenantId: string; actingSubject?: string; signal?: AbortSignal;
}): Promise<ManagedTierTestResult> {
  const { provider, model } = input;
  if (!isManagedUnderlying(provider)) {
    return { ok: false, provider, model, code: 'managed_unknown', message: `"${provider}" is not a supported free-tier provider.` };
  }
  const key = storageRef && masterKeyPathRef ? await resolveProviderKey(provider) : null;
  if (!key) {
    return { ok: false, provider, model, code: 'managed_key_missing', message: `No key for ${provider}. Add ${managedTierVaultRef(provider)} in the Secrets Vault (Host-global).` };
  }
  const started = Date.now();
  try {
    const result = await dispatchChat({
      provider,
      model,
      apiKey: key.key,
      messages: [
        { role: 'system', content: 'You are checking that this connection works.' },
        { role: 'user', content: 'Reply with the single word: ready' },
      ],
      maxTokens: 32,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await recordManagedUsage(input.tenantId, 'openwop-free', todayUtc(), result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0, input.actingSubject,
      { provider, ...(result.usage?.cachedReadTokens != null ? { cachedReadTokens: result.usage.cachedReadTokens } : {}), cachedReadWeight: PROVIDER_SPECS[provider].cachedReadWeight },
      { freeRemaining: 0, exempt: true });
    return { ok: true, provider, model, latencyMs: Date.now() - started, reply: result.completion.slice(0, 200) };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false, provider, model,
      code: typeof code === 'string' ? code : 'provider_error',
      // A provider error never echoes the key, but scrub it anyway: this text
      // reaches a browser.
      message: raw.split(key.key).join('***').slice(0, 300),
    };
  }
}

/** Test affordance — drop in-process caches without touching storage. */
export function _clearManagedCacheForTests(): void {
  decryptCache.clear();
  tierMemo = null;
  tierRefresh = null;
  tierRefreshStartedAt = 0;
}
