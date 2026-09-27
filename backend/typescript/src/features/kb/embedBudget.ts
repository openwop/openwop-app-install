/**
 * ADR 0398 P3 — a per-tenant DAILY embedding-token budget for reindex jobs.
 *
 * Owned by `kb` as a migration-free KV counter (NOT the `media_usage` SQL table, whose
 * columns are hardcoded tts/stt — a correction to the ADR's "add an `embed` kind to
 * mediaBudget": adding an SQL column across the sqlite + postgres adapters is a migration
 * the KB data-model rule avoids). Keyed `${tenantId}:${dateUtc}`. `0` cap ⇒ uncapped
 * (default) — an off-by-default host accumulates nothing. Fail-OPEN on a read error (a
 * budget read must never wedge a reindex), matching `checkMediaBudget`.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';

interface EmbedUsageRow { key: string; tenantId: string; dateUtc: string; tokens: number }
const embedUsage = new DurableCollection<EmbedUsageRow>('kb:embedusage', (r) => r.key);

const dateUtc = (): string => new Date().toISOString().slice(0, 10);
const keyFor = (tenantId: string, d: string): string => `${tenantId}:${d}`;

/** The per-tenant daily embed-token cap (`OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY`). 0 ⇒ uncapped. */
function embedBudgetCap(): number {
  const v = Number(process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface EmbedBudgetCheck { exceeded: boolean; cap: number; used: number; nextTotal: number }

/** Would embedding `addTokens` more exceed today's cap? Uncapped ⇒ never. */
export async function checkEmbedBudget(tenantId: string, addTokens: number): Promise<EmbedBudgetCheck> {
  const cap = embedBudgetCap();
  if (cap <= 0) return { exceeded: false, cap, used: 0, nextTotal: addTokens };
  let used = 0;
  try { used = (await embedUsage.get(keyFor(tenantId, dateUtc())))?.tokens ?? 0; }
  catch { return { exceeded: false, cap, used: 0, nextTotal: addTokens }; } // fail-open
  const nextTotal = used + Math.max(0, addTokens);
  return { exceeded: nextTotal > cap, cap, used, nextTotal };
}

/** Accumulate `tokens` of embed usage AFTER a successful embed batch (real figures). No-op
 *  when uncapped. Best-effort — a write failure never fails a batch that already embedded. */
export async function recordEmbedUsage(tenantId: string, tokens: number): Promise<void> {
  if (embedBudgetCap() <= 0 || tokens <= 0) return;
  try {
    const d = dateUtc();
    const key = keyFor(tenantId, d);
    const prior = (await embedUsage.get(key))?.tokens ?? 0;
    await embedUsage.put({ key, tenantId, dateUtc: d, tokens: prior + Math.floor(tokens) });
    // Only TODAY's counter is ever read (checkEmbedBudget), so prune this tenant's older daily
    // rows opportunistically — otherwise they accrete one/tenant/day forever (retention fix).
    for (const row of await embedUsage.listByPrefix(`${tenantId}:`)) {
      if (row.dateUtc < d) { try { await embedUsage.delete(row.key); } catch { /* best-effort */ } }
    }
  } catch { /* best-effort */ }
}

/** Rough token estimate for a chunk of text (~4 chars/token) — for cost estimation + metering. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
