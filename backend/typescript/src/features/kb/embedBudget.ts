/**
 * ADR 0398 P3 — a per-tenant DAILY embedding-token budget for reindex jobs.
 *
 * Owned by `kb` as a migration-free KV counter (NOT the `media_usage` SQL table, whose
 * columns are hardcoded tts/stt — a correction to the ADR's "add an `embed` kind to
 * mediaBudget": adding an SQL column across the sqlite + postgres adapters is a migration
 * the KB data-model rule avoids). Keyed `${tenantId}:${dateUtc}`. `0` cap ⇒ uncapped
 * (default) — an off-by-default host accumulates nothing. The advisory capacity read remains fail-open; actual paid dispatch requires a
 * durable reservation and fails closed when storage is unavailable.
 */
import { currentEffectContext, assertEffectAllowed } from '../../host/runEffectContext.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { parseHostEmbedderConfig, registerHostEmbeddingAdmission } from '../../host/headlessAi.js';
import { VERTEX_EMBEDDING_MAX_DIMS } from '../../host/vertexEmbedder.js';
import { effectiveEmbedDims } from '../../aiProviders/localEmbedding.js';

interface EmbedUsageRow { key: string; tenantId: string; dateUtc: string; tokens: number }
const embedUsage = new DurableCollection<EmbedUsageRow>('kb:embedusage', (r) => r.key);

const dateUtc = (): string => new Date().toISOString().slice(0, 10);
const keyFor = (tenantId: string, d: string): string => `${tenantId}:${d}`;

/** The per-tenant daily embed-token cap (`OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY`). 0 ⇒ uncapped. */
export function embedBudgetCap(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY);
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

/** Reserve BEFORE dispatch under the existing daily counter. Failed, malformed
 * or uncertain provider attempts keep the reservation. A lost CAS acknowledgement
 * refuses dispatch rather than guessing which writer advanced the counter. */
export async function reserveEmbedBudget(tenantId: string, addTokens: number): Promise<EmbedBudgetCheck & { unavailable?: true }> {
  const cap = embedBudgetCap();
  // A headless paid call has no invocation-log discharge. Classified KB
  // nodes are served before execution; unclassified callers must refuse a
  // replay attempt before mutating even the daily counter.
  if (currentEffectContext()?.replaying) {
    try { assertEffectAllowed('network-egress', 'KB paid embedding/context attempt'); }
    catch { return { exceeded: true, cap, used: 0, nextTotal: 0, unavailable: true }; }
  }
  const amount = Math.ceil(Math.max(0, addTokens));
  if (!Number.isFinite(amount)) return { exceeded: true, cap, used: 0, nextTotal: 0, unavailable: true };
  if (cap <= 0) return { exceeded: false, cap, used: 0, nextTotal: amount };
  const d = dateUtc(); const key = keyFor(tenantId, d);
  let used = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const prior = await embedUsage.get(key);
      used = prior?.tokens ?? 0;
      if (!Number.isSafeInteger(used) || used < 0) return { exceeded: true, cap, used: 0, nextTotal: amount, unavailable: true };
      const nextTotal = used + amount;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > cap) return { exceeded: true, cap, used, nextTotal };
      if (!await embedUsage.compareAndSwap(prior, { key, tenantId, dateUtc: d, tokens: nextTotal })) continue;
      // Retention is best effort; admission is already durably reserved.
      try {
        for (const row of await embedUsage.listByPrefix(`${tenantId}:`)) {
          if (row.dateUtc < d) await embedUsage.delete(row.key);
        }
      } catch { /* a retained counter cannot authorize another provider call */ }
      return { exceeded: false, cap, used, nextTotal };
    } catch {
      return { exceeded: true, cap, used, nextTotal: used + amount, unavailable: true };
    }
  }
  return { exceeded: true, cap, used, nextTotal: used + amount, unavailable: true };
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

/** Bind the shared operator transport to this ONE counter, rather than adding
 * a second host budget or importing the feature from the host layer. */
export function registerKbEmbeddingBudget(): void {
  registerHostEmbeddingAdmission(async (tenantId, text) => !(await reserveEmbedBudget(tenantId, estimateTokens(text))).exceeded);
}

/**
 * ADR 0904 D1 (architect A3) — the operator host embedder is the operator's money, spent
 * on behalf of EVERY eligible tenant, and switching it on changes the signature of every
 * collection that made no embedder choice. With the cap at its default (0 = uncapped)
 * that is an unbounded bill, so the host REFUSES TO BOOT with the arm set and no cap.
 * Also refuses a value it cannot serve (a typo must not read as "off"). Called from the
 * kb feature's registration, i.e. inside `createApp`.
 */
export function assertHostEmbedderBootConfig(env: NodeJS.ProcessEnv = process.env): void {
  const cfg = parseHostEmbedderConfig(env); // throws on an unsupported value
  if (!cfg) return;
  if (embedBudgetCap(env) <= 0) {
    throw new Error(`OPENWOP_KB_HOST_EMBEDDER=${env.OPENWOP_KB_HOST_EMBEDDER} needs a daily embedding cap: set OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY to a positive per-tenant token budget (ADR 0904 D1). Refusing to boot with operator-funded embeddings uncapped.`);
  }
  const dims = effectiveEmbedDims();
  if (dims > VERTEX_EMBEDDING_MAX_DIMS) {
    throw new Error(`OPENWOP_KB_HOST_EMBEDDER: the vector width ${dims} exceeds what ${cfg.model} serves (${VERTEX_EMBEDDING_MAX_DIMS}).`);
  }
}
