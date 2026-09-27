/**
 * ADR 0476 §3 — the pre-run cost estimate: what the user actually needs at the
 * Run/approve moment is the ORDER OF MAGNITUDE ("is this $0.01 or $10?"), so
 * the estimate is two honest halves and never a quote:
 *
 *  - `historical` — median/p95 of THIS workflow's terminal-run cost stamps
 *    (ADR 0476 §1) within the fleet-stats window; absent until runs exist.
 *  - `static` — a composition floor: AI-dispatching nodes × the default
 *    model's providers.json per-1K rates × a DISCLOSED token assumption.
 *    Absent when the definition has no AI nodes or no priced model resolves.
 *
 * Per-node historical medians (event-log fan-out) were weighed and deferred —
 * ADR 0476 "Alternatives weighed" #3.
 */

import type { Storage } from '../storage/storage.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { aggregateFleetStats } from './workflowFleetStats.js';
import { listProviders, getDefaultModel, getProviderConfig } from '../providers/catalog.js';
import { MANAGED_DEFAULTING_TYPE_IDS } from '../providers/managedProvider.js';

/** Disclosed token assumption per AI node for the static floor. */
export const STATIC_TOKENS_PER_AI_NODE = { input: 1000, output: 1000 } as const;

export interface WorkflowCostEstimate {
  historical?: { medianUsd: number; p95Usd: number; samples: number };
  static?: {
    floorUsd: number;
    aiNodes: number;
    assumptions: {
      tokensPerNode: { input: number; output: number };
      model: string;
      ratePer1k: { input: number; output: number };
    };
  };
}

/** An "AI node" for the static floor: a chat-class typeId, or a node whose
 *  config names a model/provider (the run-create managed-defaulting shape). */
function isAiNode(node: { typeId: string; config?: Record<string, unknown> }): boolean {
  if (MANAGED_DEFAULTING_TYPE_IDS.has(node.typeId)) return true;
  const cfg = node.config ?? {};
  return typeof cfg.model === 'string' || typeof cfg.provider === 'string' || typeof cfg.providerId === 'string';
}

/** The first priced (provider, defaultModel) pair from the catalog SSoT. */
function defaultPricedModel(): { model: string; input: number; output: number } | null {
  for (const p of listProviders()) {
    const defaultId = getDefaultModel(p.id);
    const cfg = getProviderConfig(p.id);
    const models = (cfg?.models ?? []) as ReadonlyArray<{ id: string; cost?: { input: number; output: number } }>;
    const preferred = models.find((m) => m.id === defaultId && m.cost) ?? models.find((m) => m.cost);
    if (preferred?.cost) return { model: preferred.id, input: preferred.cost.input, output: preferred.cost.output };
  }
  return null;
}

export async function estimateWorkflowCost(
  storage: Storage,
  tenantId: string,
  workflowId: string,
  definition: WorkflowDefinition,
): Promise<WorkflowCostEstimate> {
  const out: WorkflowCostEstimate = {};

  // Historical — from the (30s-cached) fleet aggregation: the builder's
  // estimate + the dashboard + the heatmap share ONE scan per tenant per TTL
  // window instead of each running their own 2000-row read (review M2).
  const fleet = await aggregateFleetStats(storage, tenantId);
  const row = fleet.workflows.find((w) => w.workflowId === workflowId);
  if (row && row.costSamples > 0 && row.costUsdMedian !== null && row.costUsdP95 !== null) {
    out.historical = {
      medianUsd: row.costUsdMedian,
      p95Usd: row.costUsdP95,
      samples: row.costSamples,
    };
  }

  // Static floor — AI-node composition × default priced model.
  const st = staticCostFloor(definition);
  if (st) out.static = st;

  return out;
}

/** The static half alone — also computed at ADR 0473 propose time so the
 *  review card can show what approving would roughly cost (no storage read;
 *  synchronous over the catalog SSoT). Null when no AI nodes / no priced model. */
export function staticCostFloor(definition: WorkflowDefinition): NonNullable<WorkflowCostEstimate['static']> | null {
  const aiNodes = definition.nodes.filter(isAiNode).length;
  const priced = aiNodes > 0 ? defaultPricedModel() : null;
  if (aiNodes === 0 || !priced) return null;
  const perNode = (STATIC_TOKENS_PER_AI_NODE.input / 1000) * priced.input
    + (STATIC_TOKENS_PER_AI_NODE.output / 1000) * priced.output;
  return {
    floorUsd: Number((aiNodes * perNode).toFixed(6)),
    aiNodes,
    assumptions: {
      tokensPerNode: { ...STATIC_TOKENS_PER_AI_NODE },
      model: priced.model,
      ratePer1k: { input: priced.input, output: priced.output },
    },
  };
}
