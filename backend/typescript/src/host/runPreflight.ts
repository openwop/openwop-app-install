/**
 * Run admission preflight D1/D2 (P0) — run admission preflight: the required-parameter check.
 * D3 (P1) — required features: every feature a run's steps need (transitively,
 * through child definitions, and by explicit declaration) must be on and entitled.
 *
 * A run instantiated from a chain whose declared-required parameter has no value
 * anywhere (not frozen at expansion, no default, not a run input, not a
 * deferred-variable default) starts anyway, spends on its early nodes, and fails
 * or produces junk at the node that needed it (CC-CHAIN-9: shift-digest without
 * `previous`, run 198f9325, inputs `{}`).
 *
 * SHADOW BY DEFAULT (correction to the run admission preflight ADR D1, recorded there). ADR 0504
 * built a run-start refusal for unfilled params, measured it, and withdrew it:
 * the population it would refuse was most of the product. Required params are
 * just as common — MEASURED on e3d757de6a: 150 of 261 chains declare at least one
 * with no default — and many are legitimately supplied at run time (campaign
 * orchestration's `briefId` arrives as a run input). So this check first RECORDS
 * what it would refuse, on `run.metadata.preflightFindings` and the
 * `run_preflight_findings` log line, and refuses only under
 * `OPENWOP_RUN_PREFLIGHT=enforce`, after the shadow population has been read on
 * production. Never flip the default without that measurement.
 *
 * Pure over its inputs: the caller resolves the chain's parameter declaration
 * (`getChain`), so this module imports no loader and cannot cycle.
 */
import { OpenwopError } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';

export type RunPreflightMode = 'off' | 'shadow' | 'enforce';

export interface ParamRequiredFinding {
  kind: 'param_required';
  chainId: string;
  param: string;
  /** The chain's own description of the parameter, when it declares one. */
  description?: string;
  /** A sentence a person can act on. */
  message: string;
}
/** D3 — a feature the run's steps need is off (or outside the plan) for the run's
 *  tenant. `label` is the feature's display name. */
export interface FeatureDisabledFinding {
  kind: 'feature_disabled';
  feature: string;
  label: string;
  /** Why it resolved off: the toggle, the plan entitlement, or an unreadable answer. */
  blockedBy: 'toggle' | 'plan' | 'unresolved';
  /** A sentence a person can act on. */
  message: string;
}
export type RunPreflightFinding = ParamRequiredFinding | FeatureDisabledFinding;

export interface ChainParamDecl {
  required?: readonly string[];
  properties?: Record<string, { default?: unknown; description?: unknown } | undefined>;
}

export function runPreflightMode(env: NodeJS.ProcessEnv = process.env): RunPreflightMode {
  const v = (env.OPENWOP_RUN_PREFLIGHT ?? '').trim().toLowerCase();
  return v === 'off' || v === 'enforce' ? v : 'shadow';
}

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

function own(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

/**
 * D2 — every parameter the chain declares REQUIRED must have a value from one of:
 * the frozen expansion params, the parameter's `default`, the run's inputs (bare
 * name, or the RFC 0124 deferred alias), or a declared variable's default.
 * A definition not expanded from a chain has no declared parameters: no findings.
 */
export function requiredParamFindings(
  definition: WorkflowDefinition,
  inputs: unknown,
  chainParamsFor: (chainId: string) => ChainParamDecl | null,
): ParamRequiredFinding[] {
  const meta = (definition.metadata ?? {}) as Record<string, unknown>;
  const from = meta.expandedFrom as { chainId?: unknown; params?: unknown } | undefined;
  if (!from || typeof from.chainId !== 'string' || !from.chainId) return [];
  const decl = chainParamsFor(from.chainId);
  const required = Array.isArray(decl?.required) ? decl.required : [];
  if (required.length === 0) return [];
  const aliases = (meta.deferredParameterAliases ?? {}) as Record<string, unknown>;
  const variableDefaults = new Map<string, unknown>();
  for (const v of definition.variables ?? []) {
    const d = v as { name?: unknown; defaultValue?: unknown };
    if (typeof d.name === 'string') variableDefaults.set(d.name, d.defaultValue);
  }
  const out: ParamRequiredFinding[] = [];
  for (const param of required) {
    if (typeof param !== 'string' || !param) continue;
    const spec = decl?.properties?.[param];
    if (spec && Object.prototype.hasOwnProperty.call(spec, 'default')) continue;
    if (present(own(from.params, param))) continue;
    if (present(own(inputs, param))) continue;
    const alias = typeof aliases[param] === 'string' ? (aliases[param] as string) : undefined;
    if (alias && (present(own(inputs, alias)) || present(variableDefaults.get(alias)))) continue;
    if (present(variableDefaults.get(param))) continue;
    const description = typeof spec?.description === 'string' && spec.description ? spec.description : undefined;
    out.push({
      kind: 'param_required',
      chainId: from.chainId,
      param,
      ...(description ? { description } : {}),
      message: `This workflow needs "${param}"${description ? ` (${description})` : ''}, and the run was started without it. Fill it in the workflow or pass it when you start the run.`,
    });
  }
  return out;
}

// ── D3 — required features, transitively and explicitly ──────────────────────

/** A feature need: required unless `optional` (the step skips cleanly when it is off). */
export interface FeatureNeed { id: string; optional?: boolean }

/** A node type's declared feature reads beyond its own (`nodeFeatureDecl`). */
export interface NodeFeatureDecl { required: readonly string[]; optional: readonly string[] }

const OWN_FEATURE_NODE = /^feature\.([^.@]+)\.nodes\./;

/** `feature.x.nodes.y@1.2.0` → `feature.x.nodes.y`. */
export function bareTypeId(typeId: string): string {
  const at = typeId.indexOf('@');
  return at < 0 ? typeId : typeId.slice(0, at);
}

/** A chain's `x-requiresFeatures` (strings, or `{id, optional}`), shape-guarded. */
export function parseFeatureNeeds(raw: unknown): FeatureNeed[] {
  if (!Array.isArray(raw)) return [];
  const out: FeatureNeed[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v) out.push({ id: v });
    else if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && (v as { id: string }).id) {
      out.push({ id: (v as { id: string }).id, ...((v as { optional?: unknown }).optional === true ? { optional: true } : {}) });
    }
  }
  return out;
}

/** The child workflow ids a definition dispatches by id (`core.subWorkflow` /
 *  `core.dispatch` read `config.workflowId`; co-registered sub-chains are
 *  rewritten to it at instantiation). */
export function childWorkflowIds(definition: WorkflowDefinition): string[] {
  const out = new Set<string>();
  for (const n of definition.nodes ?? []) {
    const id = (n.config as Record<string, unknown> | undefined)?.workflowId;
    if (typeof id === 'string' && id && id !== definition.workflowId) out.add(id);
  }
  return [...out];
}

/**
 * D3 — the feature ids a run requires: the union over the run's definition AND
 * every child definition the caller resolved, of
 *  1. each `feature.<id>.nodes.*` node's own feature;
 *  2. each node type's declared required reads (`nodeDecl`);
 *  3. each chain's required `x-requiresFeatures` (`chainDecl`, by
 *     `metadata.expandedFrom.chainId`).
 * Optional reads are never required. Pure; the caller resolves the definitions
 * and the declarations. Sorted, so findings are stable.
 */
export function requiredFeatureIds(
  definitions: readonly WorkflowDefinition[],
  nodeDecl: (typeId: string) => NodeFeatureDecl | undefined,
  chainDecl: (chainId: string) => readonly FeatureNeed[],
): string[] {
  const required = new Set<string>();
  for (const def of definitions) {
    for (const n of def.nodes ?? []) {
      if (typeof n.typeId !== 'string') continue;
      const t = bareTypeId(n.typeId);
      const own = OWN_FEATURE_NODE.exec(t)?.[1];
      if (own) required.add(own);
      for (const id of nodeDecl(t)?.required ?? []) required.add(id);
    }
    const from = ((def.metadata ?? {}) as Record<string, unknown>).expandedFrom as { chainId?: unknown } | undefined;
    if (from && typeof from.chainId === 'string' && from.chainId) {
      for (const need of chainDecl(from.chainId)) if (!need.optional) required.add(need.id);
    }
  }
  return [...required].sort();
}

/** What the caller resolved for one feature id: `null` when it is not a
 *  toggle-gated feature (always-on or unknown), which drops it. */
export interface FeatureAccessAnswer { label: string; enabled: boolean; blockedBy?: 'plan' | 'unresolved' }

/** D3 — one finding per required, toggle-gated feature that is off for the run. */
export function featureDisabledFindings(
  required: readonly string[],
  access: (id: string) => FeatureAccessAnswer | null,
): FeatureDisabledFinding[] {
  const out: FeatureDisabledFinding[] = [];
  for (const id of required) {
    const a = access(id);
    if (!a || a.enabled) continue;
    const blockedBy = a.blockedBy ?? 'toggle';
    out.push({
      kind: 'feature_disabled',
      feature: id,
      label: a.label,
      blockedBy,
      message: blockedBy === 'plan'
        ? `This workflow uses ${a.label}, which this workspace's plan does not include. Add it to the plan, or remove the steps that use it, then start the run again.`
        : blockedBy === 'unresolved'
          ? `This workflow uses ${a.label}, and whether it is on for this workspace could not be checked. Try again in a moment.`
          : `This workflow uses ${a.label}, which is turned off for this workspace. Turn it on, or remove the steps that use it, then start the run again.`,
    });
  }
  return out;
}

/** The log line's compact form of a finding. */
export function findingTag(f: RunPreflightFinding): string {
  return f.kind === 'param_required' ? `${f.kind}:${f.chainId}:${f.param}` : `${f.kind}:${f.feature}:${f.blockedBy}`;
}

/** D1 — the refusal a failing preflight raises under `enforce`. No row is written. */
export function runPreflightRefusal(findings: readonly RunPreflightFinding[]): OpenwopError {
  const first = findings[0]?.message ?? 'This run cannot start.';
  return new OpenwopError('validation_error', findings.length > 1 ? `${first} (${findings.length - 1} more)` : first, 422, {
    reason: 'run_preflight_failed',
    findings: findings.map((f) => ({ ...f })),
  });
}
