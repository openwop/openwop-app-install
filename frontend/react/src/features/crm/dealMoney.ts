/**
 * R2 CC-SP-3 — the ONE deal-money renderer. `Deal.currency` was on the wire
 * (agent-settable) while every surface rendered amounts unitless and summed
 * them mixed-currency-blind. Rules:
 *  - an amount WITH a currency renders via Intl currency formatting;
 *  - an amount WITHOUT one renders as a bare localized number (we must not
 *    invent a unit the data does not carry);
 *  - sums group BY currency and are rendered one group per currency — never a
 *    single blind total across currencies.
 */
import { formatCurrency, formatNumber } from '../../i18n/format.js';

export function formatDealAmount(amount: number, currency?: string | null): string {
  if (!currency) return formatNumber(amount);
  try {
    return formatCurrency(amount, currency);
  } catch {
    // An agent can write any string; an invalid ISO code must not crash the tab.
    return `${formatNumber(amount)}\u00a0${currency}`;
  }
}

/** Group amounts by currency (null key = unitless) and render each group. */
export function formatGroupedSums(rows: Array<{ amount?: number | undefined; currency?: string | null | undefined }>): string {
  const groups = new Map<string | null, number>();
  for (const r of rows) {
    if (r.amount === undefined) continue;
    // Agent-written codes arrive in any case; 'usd' and 'USD' are ONE group.
    const key = r.currency ? r.currency.toUpperCase() : null;
    groups.set(key, (groups.get(key) ?? 0) + r.amount);
  }
  if (groups.size === 0) return formatNumber(0);
  return [...groups.entries()]
    .sort(([a], [b]) => (a ?? '').localeCompare(b ?? ''))
    .map(([cur, sum]) => formatDealAmount(sum, cur))
    .join(' + ');
}
