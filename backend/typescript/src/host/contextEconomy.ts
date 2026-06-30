/**
 * ADR 0148 — Context economy (Tier A) configuration source-of-truth.
 *
 * The Tier-A token-efficiency levers (provider prompt caching, tool-surface
 * diet, transcript budget, memory budget, transport economy) are HOST-INTERNAL:
 * they change only what bytes the host feeds its own provider each iteration,
 * never the OpenWOP wire (no event, capability, or `MUST` changes). Several of
 * them live in the provider-dispatch layer, which is deliberately
 * tenant-agnostic — no subject/tenant is threaded in — so a per-tenant feature
 * toggle cannot gate them cleanly. The honest seam is therefore a host-level env
 * master switch with per-lever overrides, mirroring the `codeExecBudget` /
 * `imageGenBudget` host-config idiom.
 *
 * The `context-economy` BackendFeature toggle is registered separately for ADMIN
 * VISIBILITY only (it surfaces the feature in the toggle console); it does NOT
 * gate dispatch-layer behavior. Dispatch reads THIS module.
 *
 * Master: `OPENWOP_CONTEXT_ECONOMY` (default OFF until measured — ADR 0148
 * "off by default until measured"). Each lever defaults to the master value and
 * can be individually overridden:
 *   - `OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE`  (A2 — Phase 1)
 *   - `OPENWOP_CONTEXT_ECONOMY_TOOL_DIET`       (A3 — Phase 2)
 *   - `OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT`      (A1 — Phase 3)
 *   - `OPENWOP_CONTEXT_ECONOMY_MEMORY`          (A4 — Phase 4)
 *   - `OPENWOP_CONTEXT_ECONOMY_TRANSPORT`       (A6/A7 — Phase 5)
 *
 * @see docs/adr/0148-context-economy-token-budgeted-host-assembly.md
 */

/** Parse an env var as a boolean. Accepts 1/true/on/yes (case-insensitive);
 *  anything else (incl. unset) is `undefined` so callers can fall back to the
 *  master value rather than forcing `false`. */
function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '') return false;
  return undefined;
}

export interface ContextEconomyConfig {
  /** Master switch — OR of "any lever on". */
  readonly enabled: boolean;
  /** A2 (Phase 1) — Anthropic prompt caching on the stable system+tools prefix. */
  readonly providerCache: boolean;
  /** A3 (Phase 2) — compact tool descriptors + per-agent sub-allowlist. */
  readonly toolDiet: boolean;
  /** A1 (Phase 3) — token-budgeted transcript (last-k verbatim + rolling summary). */
  readonly transcriptBudget: boolean;
  /** A4 (Phase 4) — memory injection budget / distillation. */
  readonly memoryBudget: boolean;
  /** A6/A7 (Phase 5) — transport economy (gzip + meta strip). */
  readonly transport: boolean;
}

/** Resolve the context-economy config from the environment. Pure (reads
 *  `process.env` only) and cheap — call at each decision site rather than
 *  caching, so an operator env change takes effect without a restart in tests.
 *  Each lever defaults to the master switch; an explicit per-lever env overrides. */
export function contextEconomy(): ContextEconomyConfig {
  const master = envBool('OPENWOP_CONTEXT_ECONOMY') ?? false;
  const lever = (name: string): boolean => envBool(name) ?? master;
  return Object.freeze({
    enabled: master,
    providerCache: lever('OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE'),
    toolDiet: lever('OPENWOP_CONTEXT_ECONOMY_TOOL_DIET'),
    transcriptBudget: lever('OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT'),
    memoryBudget: lever('OPENWOP_CONTEXT_ECONOMY_MEMORY'),
    transport: lever('OPENWOP_CONTEXT_ECONOMY_TRANSPORT'),
  });
}
