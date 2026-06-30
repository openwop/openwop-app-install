/**
 * ADR 0099 — core IoC seam: transform tool-output content at the typed
 * tool-result boundary (the host tool executor's `{content}` / the provider
 * `tool_result` construction — the point a string is *known* to be tool output).
 *
 * Core holds an identity function pointer; a feature registers a transform at
 * boot (the `registerFeatureSurface` / `setNodePackResolver` inversion pattern).
 * Core never imports the feature. Applied at `agentDispatch` (manifest dispatch)
 * and `bootstrap/nodes` (the chat/workflow LLM-tools node onToolUse return).
 *
 * The transform MUST be pure + total — it is on the model round-trip hot path
 * and MUST NOT throw. Callers also wrap it defensively (fail-open to identity),
 * so the worst case is "no savings," never a broken run.
 */

import type { CompactionDecision } from '../executor/types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.toolResultTransform');

export interface ToolResultTransformContext {
  /** The per-run decision frozen at run-start (absent ⇒ identity). */
  decision?: CompactionDecision;
  /** The tool whose output this is — for future per-tool exemptions/telemetry. */
  toolName?: string;
  /** The run's tenant, when available (absent on the runless dispatch path). */
  tenantId?: string;
}

/**
 * ADR 0099 Phase 4 — observability. Savings are reported as side-channel
 * telemetry (NOT a recorded run event, NOT durable state, NOT the wire), so it
 * is replay-safe: re-running the boundary on replay just re-emits a metric.
 * `emitRawCostAttrs` is NOT used — its allowlist drops non-`openwop.cost.*`
 * keys. The observer is swappable so a host can route savings elsewhere and so
 * tests can assert it; the default logs at INFO — this IS the savings signal the
 * feature exists to surface, at the same granularity as the per-call cost
 * emitter, so it must be visible in a standard `info`-level deployment (a `debug`
 * default left it invisible in prod, defeating the observability goal).
 */
export interface CompactionSaving {
  toolName?: string;
  tenantId?: string;
  charsBefore: number;
  charsAfter: number;
  charsSaved: number;
}
export type CompactionObserver = (saving: CompactionSaving) => void;

const defaultObserver: CompactionObserver = (s) => log.info('tool_output_compacted', { ...s });
let observer: CompactionObserver = defaultObserver;

/** Swap the telemetry sink (host integration / tests). */
export function setCompactionObserver(fn: CompactionObserver): void {
  observer = fn;
}
export function __resetCompactionObserver(): void {
  observer = defaultObserver;
}

export type ToolResultTransform = (content: string, ctx: ToolResultTransformContext) => string;

const IDENTITY: ToolResultTransform = (content) => content;

let current: ToolResultTransform = IDENTITY;

/** Feature registration seam — called once at boot. */
export function registerToolResultTransform(fn: ToolResultTransform): void {
  current = fn;
}

/** Test/reset hook. */
export function __resetToolResultTransform(): void {
  current = IDENTITY;
}

/**
 * Apply the registered transform. Fail-open: any throw (or a missing/`off`
 * decision) returns the original content unchanged.
 */
export function applyToolResultTransform(content: string, ctx: ToolResultTransformContext): string {
  if (!ctx.decision || ctx.decision.mode === 'off') return content;
  // Per-tool exemption (ADR 0099 §residuals): a tool whose output must stay
  // byte-exact is skipped. The exempt list is frozen in the decision (replay-safe).
  if (ctx.toolName && ctx.decision.exemptTools?.includes(ctx.toolName)) return content;
  let out: string;
  try {
    out = current(content, ctx);
  } catch {
    return content;
  }
  // Phase 4 — report savings as side-channel telemetry; never let it throw.
  if (out.length < content.length) {
    try {
      observer({
        ...(ctx.toolName ? { toolName: ctx.toolName } : {}),
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        charsBefore: content.length,
        charsAfter: out.length,
        charsSaved: content.length - out.length,
      });
    } catch {
      /* telemetry must never break a run */
    }
  }
  return out;
}
