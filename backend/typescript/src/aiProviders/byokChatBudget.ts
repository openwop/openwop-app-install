/**
 * BYOK LLM chat spend governance (ADR 0178) — per-org daily TOKEN budget for the
 * BYOK-direct chat dispatch path (`conversationExchange.dispatchReply`'s BYOK
 * branch), the one dispatch path with no aggregate spend cap today (the managed
 * tier has `managedProvider`'s `dailyTokenCap`; the media path has `mediaBudget`).
 *
 * Structurally identical to `mediaBudget.ts` (ADR 0106): a module-level `Storage`
 * injected at bootstrap, per-`(tenant, provider, UTC-day)` accounting (tenant =
 * workspace = org at root, ADR 0015), upserted via the storage layer, with a
 * DI-seam override resolver so this module never imports `governanceService` (no
 * cross-module edge, no cycle). The net-new half vs. `mediaBudget` is a
 * **soft-warning threshold**: a percentage of the cap that, once crossed, still
 * lets the dispatch succeed but flags a non-blocking warning to the caller.
 *
 * **Default OFF** — a cap of 0 (env unset) disables both the cap CHECK and the
 * usage RECORD, so a host that doesn't configure a BYOK budget pays zero overhead
 * and sees no behaviour change. This module never throws; the caller
 * (`conversationExchange`) maps an over-budget result to its `OpenwopError` so
 * this module stays free of that dependency (no import cycle).
 */
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('aiProviders.byokChatBudget');

const DEFAULT_SOFT_WARNING_PCT = 80;

let storageRef: Storage | null = null;

/** ADR 0178 — the per-org budget OVERRIDE resolver, injected at bootstrap (a DI
 *  seam so this module never imports `governanceService` — no cross-module edge,
 *  no cycle). Returns the tenant's `byokChatBudget` override (or null/absent ⇒
 *  fall to the env default). A present field — INCLUDING `0` — overrides the env
 *  (0 = uncapped for that org). */
export type ByokChatBudgetOverrideResolver = (
  tenantId: string,
) => Promise<{ dailyTokenCap?: number; softWarningPct?: number } | null>;
let overrideResolver: ByokChatBudgetOverrideResolver | null = null;

/** Inject the durable store + (optionally) the per-org override resolver
 *  (called at bootstrap, next to `configureMediaBudget`). */
export function configureByokChatBudget(input: {
  storage: Storage;
  resolveOverride?: ByokChatBudgetOverrideResolver;
}): void {
  storageRef = input.storage;
  overrideResolver = input.resolveOverride ?? null;
}

/** Reset for tests. */
export function _resetByokChatBudgetForTest(): void {
  storageRef = null;
  overrideResolver = null;
}

function envCap(): number {
  const raw = process.env['OPENWOP_BYOK_DAILY_TOKEN_CAP'];
  if (!raw) return 0;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** UTC calendar day (YYYY-MM-DD) — the roll-up window, mirroring managed/media usage. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Resolve a tenant's EFFECTIVE daily BYOK budget: the per-org override (when set)
 *  wins over the env default, field by field. A present override field (incl. 0)
 *  is authoritative; an absent one falls through to env (cap) / the default
 *  (`softWarningPct`). Fail-soft — a resolver error logs and falls back to the env
 *  default (a governance-read outage must not block a BYOK call the user is paying
 *  for). */
export async function resolveByokBudget(
  tenantId: string,
): Promise<{ dailyTokenCap: number; softWarningPct: number }> {
  const env = { dailyTokenCap: envCap(), softWarningPct: DEFAULT_SOFT_WARNING_PCT };
  if (!overrideResolver || !tenantId) return env;
  let override: { dailyTokenCap?: number; softWarningPct?: number } | null = null;
  try {
    override = await overrideResolver(tenantId);
  } catch (err) {
    log.warn('byok_chat_budget_override_read_failed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return env;
  }
  return {
    dailyTokenCap:
      override?.dailyTokenCap != null ? Math.max(0, Math.floor(override.dailyTokenCap)) : env.dailyTokenCap,
    softWarningPct:
      override?.softWarningPct != null
        ? Math.min(100, Math.max(0, override.softWarningPct))
        : env.softWarningPct,
  };
}

export interface ByokChatBudgetCheck {
  /** The next BYOK dispatch would cross the cap (already at/over it). */
  exceeded: boolean;
  /** Tokens (input + output) already accumulated today for this provider. */
  used: number;
  /** The configured cap (0 ⇒ uncapped). */
  cap: number;
  /** `used` as a percentage of `cap` (0 when uncapped). */
  usedPct: number;
  /** `usedPct >= softWarningPct` (never when uncapped). */
  warn: boolean;
  /** ADR 0396 P3 — the PERSONAL lane's verdict (absent when no acting user or
   *  no personal lane is wired/set). A personal cap only LOWERS effective
   *  spend: the caller blocks when EITHER lane exceeds — never raises the org
   *  backstop. */
  personal?: { exceeded: boolean; used: number; cap: number; usedPct: number; warn: boolean };
}

/** ADR 0396 P3 — the personal-budget lane, injected by the settings feature at
 *  registration (the same DI inversion as `resolveOverride`: core never imports
 *  a feature). `resolveCap` returns the user's SELF-SET daily token cap (0/null
 *  ⇒ no personal cap — off by default per user); usage is per-(tenant,user,day),
 *  ALL providers combined (the personal lane caps the user's total spend). */
export interface PersonalByokBudgetLane {
  resolveCap(tenantId: string, userId: string): Promise<{ dailyTokenCap: number; softWarningPct: number } | null>;
  getUsed(tenantId: string, userId: string, dayUtc: string): Promise<number>;
  record(tenantId: string, userId: string, dayUtc: string, inputTokens: number, outputTokens: number): Promise<void>;
}
let personalLane: PersonalByokBudgetLane | null = null;
export function configurePersonalByokBudget(lane: PersonalByokBudgetLane | null): void {
  personalLane = lane;
}

/**
 * Has the tenant reached its daily BYOK token budget for `provider`? Returns
 * `{ exceeded:false, warn:false }` immediately when uncapped (cap 0) or no store
 * is configured. Fail-OPEN on a storage read error (a usage-read outage must not
 * block a BYOK call the user is paying for) — logged for visibility. Never throws.
 */
export async function checkByokChatBudget(
  tenantId: string,
  provider: string,
  actingUserId?: string,
): Promise<ByokChatBudgetCheck> {
  const { dailyTokenCap: cap, softWarningPct } = await resolveByokBudget(tenantId);
  let org: ByokChatBudgetCheck = { exceeded: false, used: 0, cap, usedPct: 0, warn: false };
  if (cap > 0 && storageRef && tenantId && provider) {
    try {
      const usage = await storageRef.getByokChatUsage(tenantId, provider, todayUtc());
      const used = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      const usedPct = Math.round((used / cap) * 100);
      org = { exceeded: used >= cap, used, cap, usedPct, warn: usedPct >= softWarningPct };
    } catch (err) {
      log.warn('byok_chat_budget_read_failed', {
        tenantId,
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
      // fail-open on the org lane; the personal lane below is independent
    }
  }
  // ADR 0396 P3 — the personal lane (self-service; effective cap =
  // min(orgCap, personalCap) by "block when either exceeds"). Fail-open on a
  // lane read error (0178's proven posture — a prefs outage must not block a
  // call the user pays for).
  if (personalLane && actingUserId && tenantId) {
    try {
      const personalCap = await personalLane.resolveCap(tenantId, actingUserId);
      if (personalCap && personalCap.dailyTokenCap > 0) {
        const used = await personalLane.getUsed(tenantId, actingUserId, todayUtc());
        const usedPct = Math.round((used / personalCap.dailyTokenCap) * 100);
        org = {
          ...org,
          personal: {
            exceeded: used >= personalCap.dailyTokenCap,
            used,
            cap: personalCap.dailyTokenCap,
            usedPct,
            warn: usedPct >= personalCap.softWarningPct,
          },
        };
      }
    } catch (err) {
      log.warn('byok_personal_budget_read_failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return org;
}

/**
 * Record BYOK token usage AFTER a successful dispatch (real figures, like
 * `recordTurnUsage`/`emitCost`). Best-effort: a write failure is logged, never
 * thrown (it must not fail a call that already succeeded). No-op when no store is
 * configured or both counts are ≤ 0.
 */
export async function recordByokChatUsage(
  tenantId: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
  actingUserId?: string,
): Promise<void> {
  if (!storageRef || !tenantId || !provider) return;
  const inTok = Math.max(0, Math.floor(inputTokens || 0));
  const outTok = Math.max(0, Math.floor(outputTokens || 0));
  if (inTok <= 0 && outTok <= 0) return;
  try {
    await storageRef.incrementByokChatUsage(tenantId, provider, todayUtc(), inTok, outTok);
  } catch (err) {
    log.warn('byok_chat_usage_record_failed', {
      tenantId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // ADR 0396 P3 — the personal counter rides along (best-effort, same posture).
  if (personalLane && actingUserId) {
    try {
      await personalLane.record(tenantId, actingUserId, todayUtc(), inTok, outTok);
    } catch (err) {
      log.warn('byok_personal_usage_record_failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
