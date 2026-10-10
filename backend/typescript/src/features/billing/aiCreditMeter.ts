/**
 * ADR 0821 D1/D2/D4 — the billing page's AI credit meter: ONE tenant-scoped read
 * that composes the three legs of the D2 consumption order plus the D4
 * per-feature attribution, every figure converted to CREDITS here (server-side,
 * `OPENWOP_BILLING_TOKENS_PER_CREDIT`), so the SPA never learns the exchange rate
 * and cannot compute a different number than the ledger charged.
 *
 * HONEST WHEN UNCONFIGURED. Each leg is `null` when it does not exist on this
 * host, never a fabricated zero:
 *   - `freeDaily` is null when no managed provider is READY (no server key ⇒ no
 *     free allowance, whatever the cap env says);
 *   - `monthly` is null when the plan sets no `aiCreditsMonthly`;
 *   - `topFeatures` is empty when nothing was spent in the window.
 * The purchased balance is always real: it is the ledger row (0 when none).
 *
 * Every leg reads the SAME store its draw writes (`describeOwnManagedUsage` is the
 * cap check's composer, `describePlanAllowance` the D2 CAS counter, `getBalance`
 * the ledger), so the meter cannot drift from what was charged.
 */
import { describeOwnManagedUsage, getManagedProviderStatuses } from '../../providers/managedProvider.js';
import { describePlanAllowance, listFeatureSpendForTenant, tokensToCredits } from '../../host/managedCredits.js';
import { getToggleDefault } from '../../host/featureToggles/registry.js';
import { getBalance } from './billingService.js';

/** The managed provider the free daily allowance belongs to. */
const FREE_PROVIDER = 'openwop-free';
/** The attribution window, matching usage-analytics' managed rollup. */
export const AI_CREDIT_WINDOW_DAYS = 30;
/** How many features the breakdown names; the rest fold into `otherCredits`. */
const TOP_FEATURES = 5;

export interface AiCreditMeter {
  /** Today's free daily allowance (D2 step 1), or null when there is none. */
  freeDaily: { day: string; usedCredits: number; capCredits: number; scope: 'subject' | 'tenant' } | null;
  /** This month's plan allowance (D2 step 2), or null when the plan has none. */
  monthly: { month: string; usedCredits: number; allowanceCredits: number } | null;
  /** Purchased packs (D2 step 3) — the prepaid ledger, in credits. */
  balanceCredits: number;
  /** D4 — managed spend over the window, largest first. `usedCredits` is the
   *  full managed consumption; `chargedCredits` the part drawn from the plan
   *  allowance or the balance (zero while inside the free allowance). */
  windowDays: number;
  topFeatures: Array<{ featureId: string; label?: string; usedCredits: number; chargedCredits: number; calls: number }>;
  /** Credits used by features outside the top list (0 when none). */
  otherCredits: number;
}

/** The feature's registered display label, when the id is a toggle id (attribution
 *  also uses surface ids such as `chat-autotitle` that have no toggle). */
function labelOf(featureId: string): { label?: string } {
  const label = getToggleDefault(featureId)?.label;
  return label ? { label } : {};
}

async function freeAllowanceReady(): Promise<boolean> {
  try {
    return (await getManagedProviderStatuses()).some((s) => s.providerId === FREE_PROVIDER && s.ready);
  } catch {
    return false;
  }
}

export async function describeAiCreditMeter(tenantId: string, actingSubject: string | undefined, now: Date = new Date()): Promise<AiCreditMeter> {
  const since = new Date(now.getTime() - (AI_CREDIT_WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const [ready, plan, balance, rows] = await Promise.all([
    freeAllowanceReady(),
    describePlanAllowance(tenantId, now),
    getBalance(tenantId),
    listFeatureSpendForTenant(tenantId, since),
  ]);
  const own = ready ? await describeOwnManagedUsage(tenantId, actingSubject, FREE_PROVIDER).catch(() => null) : null;

  const byFeature = new Map<string, { featureId: string; tokens: number; charged: number; calls: number }>();
  for (const r of rows) {
    const agg = byFeature.get(r.featureId) ?? { featureId: r.featureId, tokens: 0, charged: 0, calls: 0 };
    agg.tokens += r.inputTokens + r.outputTokens;
    agg.charged += r.chargedTokens;
    agg.calls += r.calls;
    byFeature.set(r.featureId, agg);
  }
  // Rank by what the feature COST the tenant: tokens used, then charged
  // token-equivalents (a metered unit row — TTS, images — has no tokens).
  const ranked = [...byFeature.values()].sort((a, b) => (b.tokens + b.charged) - (a.tokens + a.charged));
  const top = ranked.slice(0, TOP_FEATURES);
  const rest = ranked.slice(TOP_FEATURES);

  return {
    freeDaily: own ? { day: own.day, usedCredits: tokensToCredits(own.tokens), capCredits: tokensToCredits(own.dailyTokenCap), scope: own.scope } : null,
    monthly: plan ? { month: plan.month, usedCredits: tokensToCredits(plan.usedTokens), allowanceCredits: tokensToCredits(plan.allowanceTokens) } : null,
    balanceCredits: tokensToCredits(balance.totalAvailable),
    windowDays: AI_CREDIT_WINDOW_DAYS,
    topFeatures: top.map((f) => ({ featureId: f.featureId, ...labelOf(f.featureId), usedCredits: tokensToCredits(f.tokens), chargedCredits: tokensToCredits(f.charged), calls: f.calls })),
    otherCredits: tokensToCredits(rest.reduce((n, f) => n + f.tokens, 0)),
  };
}
