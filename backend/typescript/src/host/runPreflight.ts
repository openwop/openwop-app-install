/**
 * Run admission preflight D1/D2 (P0) — run admission preflight: the required-parameter check.
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
export type RunPreflightFinding = ParamRequiredFinding;

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

/** D1 — the refusal a failing preflight raises under `enforce`. No row is written. */
export function runPreflightRefusal(findings: readonly RunPreflightFinding[]): OpenwopError {
  const first = findings[0]?.message ?? 'This run cannot start.';
  return new OpenwopError('validation_error', findings.length > 1 ? `${first} (${findings.length - 1} more)` : first, 422, {
    reason: 'run_preflight_failed',
    findings: findings.map((f) => ({ ...f })),
  });
}
