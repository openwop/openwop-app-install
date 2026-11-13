/**
 * CC-CHAIN-5 — a run input that contradicts a chain-bound parameter.
 *
 * A workflow instantiated from a chain (`…/workflows/from-chain`) freezes its
 * `{{params.X}}` into node `inputs` and records the params on
 * `metadata.expandedFrom.params`. Declared node inputs win over run inputs
 * (ADR 0237, `executor/nodeCtxInputs.ts`), so a run started with `inputs.X` set to
 * something else silently acts on the BOUND value while the run record shows the
 * given one. Live on 373d4863a that wrote a messaging kernel onto a different
 * brief than the one the run named. This lists the contradictions so run
 * creation can refuse them.
 *
 * Only a param a node actually declared (an input key equal to the param name,
 * holding the bound value) counts: that is the shadowing case. Scalars only.
 */
interface DefinitionLike {
  metadata?: unknown;
  nodes?: ReadonlyArray<{ inputs?: unknown }>;
}

export interface BoundParamConflict { param: string; bound: unknown; given: unknown }

const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function boundParamConflicts(definition: DefinitionLike, inputs: unknown): BoundParamConflict[] {
  if (!isObj(inputs)) return [];
  const meta = isObj(definition.metadata) ? definition.metadata : undefined;
  const expanded = meta && isObj(meta.expandedFrom) ? meta.expandedFrom : undefined;
  const params = expanded && isObj(expanded.params) ? expanded.params : undefined;
  if (!params) return [];
  const out: BoundParamConflict[] = [];
  for (const [param, bound] of Object.entries(params)) {
    if (!isScalar(bound) || !Object.prototype.hasOwnProperty.call(inputs, param)) continue;
    const given = inputs[param];
    if (given === undefined || given === null || given === bound) continue;
    const declared = (definition.nodes ?? []).some((n) => isObj(n.inputs) && n.inputs[param] === bound);
    if (declared) out.push({ param, bound, given });
  }
  return out;
}
