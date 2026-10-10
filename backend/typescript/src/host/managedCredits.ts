/**
 * Managed AI spend — per-feature attribution (ADR 0821 D4, corrected by architect #2).
 *
 * WHY A SEPARATE STORE. The managed cap row (`storage.incrementManagedUsage` /
 * `getManagedUsage`, keyed `(bucket, provider, date)`) is read on EVERY managed
 * call. Adding a `feature` dimension to that key would turn the hot read into an
 * aggregate and force a primary-key migration in both adapters. So the cap row is
 * untouched and attribution goes HERE: one `DurableCollection` row per
 * `(tenant, UTC day, featureId)`, CAS-folded (the `usage:rollup` precedent,
 * `features/usage-analytics/usageRollupService.ts`), written AFTER the call and
 * best-effort — an attribution write failure logs and never fails the call.
 *
 * The row carries NO subject: it is operator accounting per tenant, so it is not
 * personal data (ADR 0464) and tenant teardown reaches it through `tenantOf`.
 *
 * `featureId` is the owning feature of the surface that spent: `chat` for a plain
 * chat turn, the tool's owning feature for a tool-loop round that processes that
 * tool's result, the caller's feature for a headless call, `chat-widget`,
 * `scheduled-agent-chats`, … A call that names no feature and has no run to derive
 * one from lands on `unattributed`, which is deliberately visible rather than
 * silently folded into `chat`.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { listToggleDefaults } from './featureToggles/registry.js';
import { managedBalanceDraw } from './managedBalanceHook.js';
import { isBillingExemptTenant, PLAN_LIMIT_AI_CREDITS_MONTHLY, resolvePlanLimit } from './planLimitsSeam.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';

const log = createLogger('host.managedCredits');

export const UNATTRIBUTED_FEATURE = 'unattributed';

export interface FeatureSpendRow {
  tenantId: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  featureId: string;
  /** Raw managed tokens (full weight — the same figure the cap row records). */
  inputTokens: number;
  outputTokens: number;
  /** Managed calls / metered events folded into this row. */
  calls: number;
  /** Token-equivalents charged to the plan allowance + purchased balance (ADR 0821 D2/D3).
   *  Zero while the call stayed inside the free daily allowance. */
  chargedTokens: number;
  /** ADR 0821 D3 — non-token platform units metered into this row (`ttsChar`, `image`, …). */
  units?: Record<string, number>;
  updatedAt: string;
}

const featureSpend = new DurableCollection<FeatureSpendRow>(
  'managed:feature-spend',
  (r) => `${r.tenantId}:${r.day}:${r.featureId}`,
  undefined,
  (r) => r.tenantId,
);

/** Same bound as `usageRollupService` / `workflowBudgets`. */
const CAS_ATTEMPTS = 8;

/** A feature id safe to embed in the row key: no `:` (the key separator), bounded. */
export function normalizeFeatureId(featureId: string | undefined | null): string {
  const f = (featureId ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(f) ? f : UNATTRIBUTED_FEATURE;
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface FeatureSpendInput {
  tenantId: string;
  featureId: string;
  inputTokens?: number;
  outputTokens?: number;
  chargedTokens?: number;
  /** A D3 unit draw (e.g. `{ kind: 'ttsChar', quantity: 412 }`). */
  unit?: { kind: string; quantity: number };
  at?: Date;
}

/**
 * Fold one managed call (or one metered unit event) into the tenant's per-day,
 * per-feature row. BEST-EFFORT: never throws, so it can sit after a call that
 * has already succeeded without ever being the reason it fails.
 */
export async function recordFeatureSpend(input: FeatureSpendInput): Promise<void> {
  if (!input.tenantId) return;
  const featureId = normalizeFeatureId(input.featureId);
  const at = input.at ?? new Date();
  const day = utcDay(at);
  const key = `${input.tenantId}:${day}:${featureId}`;
  try {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, Math.random() * 25));
      const existing = (await featureSpend.get(key)) ?? null;
      const base: FeatureSpendRow = existing ?? {
        tenantId: input.tenantId, day, featureId, inputTokens: 0, outputTokens: 0, calls: 0, chargedTokens: 0, updatedAt: at.toISOString(),
      };
      const units = { ...(base.units ?? {}) };
      if (input.unit && input.unit.quantity > 0) units[input.unit.kind] = (units[input.unit.kind] ?? 0) + input.unit.quantity;
      const next: FeatureSpendRow = {
        ...base,
        inputTokens: base.inputTokens + Math.max(0, Math.floor(input.inputTokens ?? 0)),
        outputTokens: base.outputTokens + Math.max(0, Math.floor(input.outputTokens ?? 0)),
        calls: base.calls + 1,
        chargedTokens: base.chargedTokens + Math.max(0, Math.ceil(input.chargedTokens ?? 0)),
        ...(Object.keys(units).length > 0 ? { units } : {}),
        updatedAt: at.toISOString(),
      };
      if (await featureSpend.compareAndSwap(existing, next)) return;
    }
    log.warn('managed_feature_spend_contention', { key, attempts: CAS_ATTEMPTS });
  } catch (err) {
    log.warn('managed_feature_spend_write_failed', { tenantId: input.tenantId, featureId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** A tenant's per-feature rows, newest day first, optionally from `sinceDay` (inclusive). */
export async function listFeatureSpendForTenant(tenantId: string, sinceDay?: string): Promise<FeatureSpendRow[]> {
  // The prefix scan can over-match a LONGER tenant id that extends this one
  // (`ws:a` vs `ws:a:b`), so the exact tenant is re-checked on the row.
  const rows = (await featureSpend.listByPrefix(`${tenantId}:`)).filter((r) => r.tenantId === tenantId && (!sinceDay || r.day >= sinceDay));
  return rows.sort((a, b) => (a.day === b.day ? (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) : a.day < b.day ? 1 : -1));
}

/** Every tenant's per-feature rows for one UTC day (the operator read). */
export async function listFeatureSpendForDay(day: string): Promise<FeatureSpendRow[]> {
  // `listContainingText` narrows in the database to rows carrying the day string,
  // then the exact predicate decides — never a cross-namespace full decode.
  const rows = await featureSpend.listContainingText(day, (r) => r.day === day);
  return rows.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
}

// ── featureId derivation ─────────────────────────────────────────────────────

/**
 * The owning feature of an agent tool, from its id, or null when it is a core
 * tool (`openwop:knowledge.*`, `openwop:core.*`, …) or unknown. Two id shapes are
 * live: `openwop:feature.<featureId>.<tool>` and `openwop:<featureId>.<tool>`. The
 * second is accepted only when `<featureId>` is a REGISTERED toggle id, so a core
 * namespace can never be mistaken for a feature.
 */
export function featureForToolName(name: string): string | null {
  const m = /^openwop:([a-z0-9-]+)\.([a-z0-9-]+)/.exec(name);
  if (!m) return null;
  if (m[1] === 'feature') return normalizeFeatureId(m[2]);
  return listToggleDefaults().some((t) => t.id === m[1]) ? m[1]! : null;
}

/**
 * The feature a workflow run's managed spend belongs to, from the attribution
 * block its starter stamped on `run.metadata` (`host/runStarter.ts` callers).
 */
export function featureForRunMetadata(metadata: Record<string, unknown> | undefined | null): string {
  const md = metadata ?? {};
  if (md['kind'] === 'scheduled-agent-chat') return 'scheduled-agent-chats';
  if (typeof md['chatSessionId'] === 'string' && md['chatSessionId']) return 'chat';
  if (md['heartbeat'] && typeof md['heartbeat'] === 'object') return 'heartbeat';
  if (md['channel'] && typeof md['channel'] === 'object') return 'channels';
  if (md['schedule'] && typeof md['schedule'] === 'object') return 'scheduler';
  return 'workflows';
}

let storageRef: Pick<Storage, 'getRun'> | null = null;

/** Wired by `configureManagedProvider` so a run-scoped call can be attributed. */
export function configureManagedCredits(input: { storage: Pick<Storage, 'getRun'> }): void {
  storageRef = input.storage;
}

/** The attribution for a managed call: an explicit feature wins; else derive it
 *  from the run (one PK read, after the call); else `unattributed`. Never throws. */
export async function resolveAttributionFeature(input: { featureId?: string; runId?: string }): Promise<string> {
  if (input.featureId) return normalizeFeatureId(input.featureId);
  if (input.runId && storageRef) {
    try {
      const run = await storageRef.getRun(input.runId);
      if (run) return featureForRunMetadata(run.metadata as Record<string, unknown> | undefined);
    } catch { /* attribution is best-effort */ }
  }
  return UNATTRIBUTED_FEATURE;
}

// ── ADR 0821 D1/D2 — credits and the consumption order ───────────────────────
//
// THE UNIT. The ledger stays in TOKEN-EQUIVALENTS (`billing:token-balance`,
// cache-weighted as ADR 0786 D6 made it), so nothing migrates.
// `OPENWOP_BILLING_TOKENS_PER_CREDIT` (default 1000) converts at the edges only:
// a plan's `aiCreditsMonthly` and the D3 rate table are written in credits and
// turned into token-equivalents here; display divides back.
//
// THE ORDER (D2, as corrected by architect #6). A managed call is paid by:
//   1. the free daily allowance — `providers/managedProvider.ts`, bounded by the
//      per-subject cap AND the per-tenant ceiling;
//   2. the plan's monthly allowance — tracked HERE per tenant per UTC month;
//   3. the purchased balance — through `host/managedBalanceHook.ts`.
// Steps 2–3 are `drawCredits`. Step 1 never reaches this module: a call inside
// the free allowance draws nothing.

/** `OPENWOP_BILLING_TOKENS_PER_CREDIT` — token-equivalents per AI credit (default 1000). */
export function tokensPerCredit(): number {
  const n = Number(process.env.OPENWOP_BILLING_TOKENS_PER_CREDIT);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/** Display conversion: token-equivalents → credits, 2 dp. */
export function tokensToCredits(tokens: number): number {
  return Math.round((tokens / tokensPerCredit()) * 100) / 100;
}

interface PlanAllowanceMonth {
  tenantId: string;
  /** UTC month, YYYY-MM. */
  month: string;
  /** Token-equivalents drawn from this month's plan allowance. */
  usedTokens: number;
  updatedAt: string;
}

const planAllowanceMonths = new DurableCollection<PlanAllowanceMonth>(
  'managed:plan-allowance-month',
  (r) => `${r.tenantId}:${r.month}`,
  undefined,
  (r) => r.tenantId,
);

function utcMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The tenant's monthly plan allowance in token-equivalents (0 = none configured). */
export async function planAllowanceTokens(tenantId: string): Promise<number> {
  const credits = await resolvePlanLimit(tenantId, PLAN_LIMIT_AI_CREDITS_MONTHLY);
  return credits === null ? 0 : Math.floor(credits * tokensPerCredit());
}

/** What is left of this UTC month's plan allowance, in token-equivalents. */
export async function planAllowanceRemaining(tenantId: string, at: Date = new Date()): Promise<number> {
  const allowance = await planAllowanceTokens(tenantId);
  if (allowance <= 0) return 0;
  try {
    const row = await planAllowanceMonths.get(`${tenantId}:${utcMonth(at)}`);
    return Math.max(0, allowance - (row?.usedTokens ?? 0));
  } catch {
    // An unreadable counter must not grant spend it cannot account for.
    return 0;
  }
}

/**
 * The tenant's plan allowance for this UTC month, as the billing page's credit
 * meter shows it: `null` when the plan sets no `aiCreditsMonthly` (an allowance
 * that is not configured is not shown as zero). Reads the SAME counter the draw
 * CASes, so the meter can never disagree with what was charged.
 */
export async function describePlanAllowance(tenantId: string, at: Date = new Date()): Promise<{ month: string; allowanceTokens: number; usedTokens: number } | null> {
  const allowanceTokens = await planAllowanceTokens(tenantId);
  if (allowanceTokens <= 0) return null;
  const month = utcMonth(at);
  const row = await planAllowanceMonths.get(`${tenantId}:${month}`);
  return { month, allowanceTokens, usedTokens: Math.min(allowanceTokens, row?.usedTokens ?? 0) };
}

/** CAS-consume up to `tokens` of this month's allowance; returns what was taken. */
async function consumePlanAllowance(tenantId: string, tokens: number, allowance: number, at: Date): Promise<number> {
  const month = utcMonth(at);
  const key = `${tenantId}:${month}`;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, Math.random() * 25));
    const existing = (await planAllowanceMonths.get(key)) ?? null;
    const used = existing?.usedTokens ?? 0;
    const take = Math.min(tokens, Math.max(0, allowance - used));
    if (take <= 0) return 0;
    const next: PlanAllowanceMonth = { tenantId, month, usedTokens: used + take, updatedAt: at.toISOString() };
    if (await planAllowanceMonths.compareAndSwap(existing, next)) return take;
  }
  // Under-draw on contention exhaustion, like `drawFromBalance`: the remainder
  // falls through to the purchased balance rather than being lost or double-taken.
  log.warn('managed_plan_allowance_contention', { key, attempts: CAS_ATTEMPTS });
  return 0;
}

/**
 * Draw `tokens` token-equivalents in D2 order steps 2–3: the plan's monthly
 * allowance first, then the purchased balance. Best-effort and never throws:
 * the call that incurred the spend has already happened (G2, the accepted
 * one-call overshoot), so a ledger hiccup must not turn it into a failure.
 */
export async function drawCredits(tenantId: string, tokens: number, at: Date = new Date()): Promise<{ plan: number; balance: number }> {
  const want = Math.max(0, Math.ceil(tokens));
  if (want === 0) return { plan: 0, balance: 0 };
  let plan = 0;
  try {
    const allowance = await planAllowanceTokens(tenantId);
    if (allowance > 0) plan = await consumePlanAllowance(tenantId, want, allowance, at);
  } catch (err) {
    log.warn('managed_plan_allowance_draw_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
  }
  const balance = want - plan > 0 ? await managedBalanceDraw(tenantId, want - plan) : 0;
  return { plan, balance };
}

// ── ADR 0821 D3 — non-token platform spend, metered into credits ─────────────
//
// TTS characters, operator-gateway images, web-search queries on the host key,
// sandbox seconds and chat-widget conversations are paid by the PLATFORM and
// never touched the token cap or the balance (G3). Each such call site already
// has its own budget check (`aiProviders/mediaBudget.ts`, `host/codeExecBudget.ts`,
// the widget caps); the draw sits beside that check through `meterPlatformUnits`,
// which reaches the balance only via `host/managedBalanceHook.ts` — no feature
// imports billing.
//
// The rate table is operator env, in CREDITS per unit:
//   OPENWOP_BILLING_CREDIT_RATES = {"ttsChar":0.01,"image":4,"videoSecond":2,
//     "webSearch":1,"codeExecSecond":0.05,"widgetConversation":2}
// An UNSET (or non-positive) rate means NO DRAW — today's behaviour. These draws
// skip the free daily TOKEN allowance (each unit has its own free cap at its
// site) and go plan allowance → balance. No refusal is added here: the existing
// per-site caps stay the refusal, so an empty balance never newly breaks TTS.
// The units are still RECORDED (attribution) when no rate is set, so an
// operator can measure before pricing.

export const CREDIT_UNITS = ['ttsChar', 'image', 'videoSecond', 'webSearch', 'codeExecSecond', 'widgetConversation'] as const;
export type CreditUnit = (typeof CREDIT_UNITS)[number];

/** `OPENWOP_BILLING_CREDIT_RATES`, parsed defensively (malformed ⇒ no rates). */
export function creditRates(): Partial<Record<CreditUnit, number>> {
  const raw = process.env.OPENWOP_BILLING_CREDIT_RATES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<CreditUnit, number>> = {};
    for (const u of CREDIT_UNITS) {
      const v = parsed[u];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[u] = v;
    }
    return out;
  } catch {
    log.warn('billing credit-rate config parse failed — no platform units are drawn');
    return {};
  }
}

/**
 * Meter `quantity` units of platform-paid spend for a tenant: record the units on
 * the attribution row and, when the unit has a rate, draw `rate × quantity`
 * credits (plan allowance → balance). Best-effort and never throws — the paid
 * call has already happened. Returns the token-equivalents charged.
 */
export async function meterPlatformUnits(input: {
  tenantId: string;
  unit: CreditUnit;
  quantity: number;
  featureId?: string;
  runId?: string;
}): Promise<number> {
  const quantity = Math.max(0, input.quantity);
  if (!input.tenantId || quantity === 0) return 0;
  let charged = 0;
  try {
    const rate = creditRates()[input.unit];
    if (rate && !isBillingExemptTenant(input.tenantId)) {
      const drawn = await drawCredits(input.tenantId, Math.ceil(rate * quantity * tokensPerCredit()));
      charged = drawn.plan + drawn.balance;
    }
  } catch (err) {
    log.warn('platform_unit_draw_failed', { tenantId: input.tenantId, unit: input.unit, error: err instanceof Error ? err.message : String(err) });
  }
  const featureId = await resolveAttributionFeature({
    ...(input.featureId ? { featureId: input.featureId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  });
  await recordFeatureSpend({ tenantId: input.tenantId, featureId, chargedTokens: charged, unit: { kind: input.unit, quantity } });
  return charged;
}

/** Test-only. */
export async function __clearFeatureSpendForTests(): Promise<void> {
  await featureSpend.__clear();
  await planAllowanceMonths.__clear();
}
