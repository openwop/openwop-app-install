/**
 * Managed prepaid-balance hook (ADR 0176 Phase 2) — a dependency-inversion seam so the
 * core managed provider can consult a prepaid AI-token BALANCE without importing the
 * `billing` feature (core must not depend on a feature, ADR 0001). The billing feature
 * REGISTERS a provider at boot; the managed provider reads through this seam.
 *
 * Semantics (ADR 0176): balance is checked BEFORE the managed daily-cap — a tenant with
 * purchased credit is not blocked by the free-tier cap (their balance covers usage); on
 * consumption the balance is drawn down first, the daily-cap remains the operator backstop.
 */

export interface ManagedBalanceProvider {
  /** Tokens the tenant has available in its prepaid balance (0 if none). */
  available: (tenantId: string) => Promise<number>;
  /** Draw down `tokens` from the tenant's balance (best-effort; returns tokens drawn). */
  draw: (tenantId: string, tokens: number) => Promise<number>;
}

let provider: ManagedBalanceProvider | null = null;

/** Wire the balance provider (billing feature, at boot). Idempotent — last wins. */
export function setManagedBalanceProvider(p: ManagedBalanceProvider | null): void {
  provider = p;
}

/** Tokens available in the tenant's prepaid balance (0 when no provider is wired). */
export async function managedBalanceAvailable(tenantId: string): Promise<number> {
  if (!provider) return 0;
  try { return await provider.available(tenantId); } catch { return 0; }
}

/** Draw down consumed tokens from the tenant's balance (no-op when unwired). */
export async function managedBalanceDraw(tenantId: string, tokens: number): Promise<void> {
  if (!provider || tokens <= 0) return;
  try { await provider.draw(tenantId, tokens); } catch { /* best-effort — never break a call */ }
}

