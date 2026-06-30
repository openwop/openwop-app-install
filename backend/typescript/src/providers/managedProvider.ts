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
import type { Storage } from '../storage/storage.js';
import { managedAnonSignInRequired } from '../host/deployPosture.js';
import { listManagedProviderIds } from './catalog.js';
import { dispatchChat, type ChatMessage, type ProviderId } from './dispatch.js';
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
export async function bootstrapManagedProvider(): Promise<void> {
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
): Promise<{ target: ManagedTarget; apiKey: string; messages: readonly ChatMessage[]; date: string }> {
  const target = getTargets()[userFacingProvider];
  if (!target) throw new ManagedProviderError('managed_unknown', `No managed target configured for provider "${userFacingProvider}".`);
  if (managedAnonSignInRequired() && tenantId.startsWith('anon:')) throw new ManagedProviderError('sign_in_required', 'Sign in to use the free tier.');
  if (!storageRef) throw new ManagedProviderError('managed_unavailable', 'Free tier not configured on this server.');

  const date = todayUtc();
  const usage = await storageRef.getManagedUsage(tenantId, userFacingProvider, date);
  if (usage.inputTokens + usage.outputTokens >= target.dailyTokenCap) {
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
  const messages = hasSystem ? reqMessages : [{ role: 'system' as const, content: target.defaultSystemPrompt }, ...reqMessages];
  return { target, apiKey, messages, date };
}

/** Best-effort managed usage increment (per-tenant + reserved global bucket) —
 *  never fails the call on a write error (the safer skew is a free turn). */
async function recordManagedUsage(tenantId: string, userFacingProvider: string, date: string, inTok: number, outTok: number): Promise<void> {
  if (!storageRef || (inTok <= 0 && outTok <= 0)) return;
  try {
    await storageRef.incrementManagedUsage(tenantId, userFacingProvider, date, inTok, outTok);
    await storageRef.incrementManagedUsage(GLOBAL_USAGE_TENANT, userFacingProvider, date, inTok, outTok);
  } catch (err) {
    log.warn('failed to increment managed usage', { tenantId, provider: userFacingProvider, error: err instanceof Error ? err.message : String(err) });
  }
}

export interface ManagedToolsRoundRequest {
  userFacingProvider: string;
  tenantId: string;
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
}

/** ONE managed (free-tier) tool-calling round — the same caps + server key +
 *  provider hiding as `dispatchManagedChat`, but a single tool round (the
 *  observe→act loop is the caller's). The underlying provider is never exposed.
 *  Only the MiniMax-backed managed tier supports tools here. */
export async function dispatchManagedToolsRound(req: ManagedToolsRoundRequest): Promise<ManagedToolsRoundResult> {
  const { target, apiKey, messages, date } = await prepareManagedDispatch(req.userFacingProvider, req.tenantId, req.messages);
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
  await recordManagedUsage(req.tenantId, req.userFacingProvider, date, round.inputTokens ?? 0, round.outputTokens ?? 0);
  return {
    text: round.text,
    toolUses: round.toolUses,
    ...(round.inputTokens != null ? { inputTokens: round.inputTokens } : {}),
    ...(round.outputTokens != null ? { outputTokens: round.outputTokens } : {}),
  };
}

export async function dispatchManagedChat(
  req: ManagedDispatchRequest,
): Promise<ManagedDispatchResult> {
  const { target, apiKey, messages, date } = await prepareManagedDispatch(
    req.userFacingProvider, req.tenantId, req.messages,
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

  await recordManagedUsage(req.tenantId, req.userFacingProvider, date, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0);

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
