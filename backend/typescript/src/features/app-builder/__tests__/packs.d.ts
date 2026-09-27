/** Typed surface for the untyped pack module the regression tests import
 *  (grade data-F1/F6/F8 + ADR 0325) — mirrors the nodes' actual shapes. */
declare module '*feature.app-builder.nodes/index.mjs' {
  interface NodeResult {
    status: string;
    outputs: Record<string, unknown>;
  }
  interface NodeCtx {
    inputs?: Record<string, unknown>;
    config?: Record<string, unknown>;
    // XCH-APPB-4 — callAI may return provider-native structured output
    // (`data`, preferred) and/or text `content` (the safeParse fallback).
    callAI?: (req: Record<string, unknown>) => Promise<{ content?: string; data?: unknown }>;
    // ADR 0358 Phase C — nodes read the live catalog list from the feature
    // surface when the host offers it (CATALOG_TYPES stays the fallback).
    features?: Record<string, Record<string, (args: Record<string, unknown>) => Promise<unknown>>>;
  }
  // XCH-APPB-3 (LLM-EXCHANGE-AUDIT Wave 2) — render gates through the
  // feature surface's `validate` op when present, and reports the verdict.
  export function render(ctx: NodeCtx): Promise<{
    status: string;
    outputs: { screenCount: number; validation: Record<string, unknown>; artifact: { artifactTypeId: string; payload: Record<string, unknown>; title: string } };
  }>;
  export function research(ctx: NodeCtx): Promise<NodeResult>;
  export function deepen(ctx: NodeCtx): Promise<NodeResult>;
  export function audit(ctx: NodeCtx): NodeResult;
  // ADR 0346 4d — the governed repair loop (fixes the tsc gap the 4d PR left:
  // the d.ts wasn't extended with the new exports).
  interface RepairCtx extends NodeCtx {
    features?: Record<string, Record<string, (args: Record<string, unknown>) => Promise<unknown>>>;
  }
  export function capture(ctx: { config?: Record<string, unknown>; inputs?: Record<string, unknown> }): {
    status: string;
    outputs: { artifact?: { artifactTypeId: string; payload: unknown; title: string } };
  };
  export function repair(ctx: RepairCtx): Promise<{
    status: string;
    outputs: { artifact: { artifactTypeId: string; payload: Record<string, unknown>; title: string }; canvasId: string; baseVersion: number };
  }>;
  export function applyDesignRepair(ctx: RepairCtx): Promise<NodeResult>;
  /** ADR 0738 — a narrow producer adapter: it reads one stored App Builder
   * canvas and emits the core Kanban proposal envelope. It never receives a
   * board/tenant writer, keeping the reusable materializer as the owner. */
  export function proposeKanbanWork(ctx: Record<string, unknown>): Promise<NodeResult>;
  export const CATALOG_TYPES: string;
  // XCH-APPB-4 — hoisted response schemas (shared first-call + repair).
  export const RESEARCH_RESPONSE_SCHEMA: Record<string, unknown>;
  export const DEEPEN_RESPONSE_SCHEMA: Record<string, unknown>;
  export const REPAIR_RESPONSE_SCHEMA: Record<string, unknown>;
}
