/**
 * The ONE rule that turns a node's edge-derived port map + its declared
 * `node.inputs` into the `ctx.inputs` a node implementation actually sees.
 *
 * ── Why this is a module and not two implementations (ADR 0597 §Correction 9) ─
 *
 * `test/strategy-chain-execution.test.ts` used to carry a hand-written mirror of
 * this logic (`buildCtxInputs`). ADR 0597 §1 fixed that mirror once — it had
 * been edge-only, ignoring `node.inputs` entirely, which is what let a chain
 * whose body binding lives on a declared input ship broken under a green suite.
 * But the repaired mirror still only copied the LAST half of the executor's
 * rule: the single-`input` unwrap and the fixture-wins merge. It did NOT copy
 * the RESOLUTION half — `{{inputs.X}}` whole-token lookups against the run's
 * variable bag, `{type:'variable'}` bag references, and `{type:'static'|'literal'}`
 * `PortValue` descriptors.
 *
 * That was faithful only ACCIDENTALLY: non-deferred `expandChain` freezes tokens
 * at expansion time, and no strategy node declares a PortValue descriptor. The
 * first chain node that uses a produced-variable input or a deferred expansion
 * would hand the harness a raw descriptor object and production a resolved
 * value — **a green test over a broken chain**, which is the exact class §1
 * exists to prevent. A test double that models the executor is a SECOND
 * implementation of the executor, and it drifts silently because nothing runs
 * both.
 *
 * So there is one function, and the harness imports it. Pinning the two
 * implementations against each other with a fixture was the cheaper option and
 * is strictly weaker: it freezes today's agreement on the cases someone thought
 * to write down, and leaves the drift surface intact everywhere else.
 *
 * @see executor/executor.ts — the production caller
 * @see docs/adr/0597-strategy-isolation-and-cadence-loop.md §Correction 9
 */

import { interpolateRunInputs, hasInputTokens } from './runInputInterpolation.js';

/** A `node.inputs` value that is EXACTLY one `{{inputs.NAME}}` token. */
const WHOLE_INPUT_TOKEN = /^\{\{\s*inputs\.([a-zA-Z0-9_]+)\s*\}\}$/;

/**
 * Resolve a node's declared `inputs` map against the run's variable bag.
 *
 * ADR 0237 — `expandChain` renames a chain's `{{params.*}}` → `{{inputs.*}}` in
 * BOTH config and inputs (the per-run resolution model); config is interpolated
 * by the caller, so inputs must be too — but with WHOLE-VALUE semantics, not
 * string substitution. A value that is exactly one token resolves to the RAW bag
 * value (object/array/number preserved — string-substituting it would stringify
 * an object to "[object Object]"); mixed text still string-interpolates.
 * Replay-safe: the bag is the same replay-stable source config reads.
 */
export function resolveDeclaredInputs(
  nodeInputs: unknown,
  variableBag: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!nodeInputs || typeof nodeInputs !== 'object' || Array.isArray(nodeInputs)) return out;
  for (const [port, decl] of Object.entries(nodeInputs as Record<string, unknown>)) {
    if (typeof decl === 'string') {
      const whole = WHOLE_INPUT_TOKEN.exec(decl);
      if (whole) {
        out[port] = variableBag?.[whole[1]!]; // raw, type-preserving
      } else {
        out[port] = hasInputTokens(decl) ? interpolateRunInputs(decl, variableBag) : decl;
      }
      continue;
    }
    if (decl && typeof decl === 'object' && !Array.isArray(decl)) {
      const ref = decl as { type?: string; variableName?: string; value?: unknown };
      if (ref.type === 'variable' && typeof ref.variableName === 'string') {
        out[port] = variableBag?.[ref.variableName];
        continue;
      }
      // `'static'` is the canonical schema-compliant tag per
      // `workflow-definition.schema.json §PortValue`. `'literal'` is a
      // back-compat alias accepted by the executor since pre-schema fixtures
      // used it. Both unwrap the `value` field.
      if (ref.type === 'static' || ref.type === 'literal') {
        out[port] = ref.value;
        continue;
      }
    }
    // Unrecognized shape — treat as literal.
    out[port] = decl;
  }
  return out;
}

/**
 * The `config` a node implementation sees, resolved against the run's variable bag.
 *
 * RFC 0124 §Rewrite targets, row 3: a deferred copy binds a WHOLE-VALUE config
 * token to a variable-sourced PortValue, `{type:'variable', variableName}`, the
 * same shape a deferred `node.inputs` entry carries (issue #5897). This resolves a
 * top-level config value of exactly that shape from the bag, and DROPS the key when
 * the bag holds no value, so an unset `provider`/`model` falls through to the ADR
 * 0903 run default instead of reaching the node as a descriptor object.
 *
 * Replay-safe for the same reason inputs are: the bag is seeded once at run
 * creation and a `:fork` copies the source's recorded variables verbatim, so the
 * value is never re-resolved from the copy's current defaults.
 *
 * Then the legacy `{{inputs.NAME}}` string tokens (ADR 0237) interpolate as before.
 * Returns the original object when there is nothing to resolve, so the common case
 * allocates nothing.
 */
export function resolveNodeConfig(
  config: Record<string, unknown> | undefined,
  variableBag: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> {
  const base = config ?? {};
  let out: Record<string, unknown> | undefined;
  for (const [key, val] of Object.entries(base)) {
    const name = variableRefName(val);
    if (name === undefined) continue;
    out ??= { ...base };
    const bound = variableBag?.[name];
    if (bound === undefined) delete out[key];
    else out[key] = bound;
  }
  const resolved = out ?? base;
  return hasInputTokens(resolved) ? interpolateRunInputs(resolved, variableBag) : resolved;
}

/** The variable a value names when it is exactly `{type:'variable', variableName}`. */
function variableRefName(val: unknown): string | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const ref = val as Record<string, unknown>;
  if (ref.type !== 'variable' || typeof ref.variableName !== 'string') return undefined;
  return Object.keys(ref).every((k) => k === 'type' || k === 'variableName') ? ref.variableName : undefined;
}

/**
 * Build the `ctx.inputs` a node implementation receives.
 *
 * Back-compat: many node implementations read `ctx.inputs` as a single payload
 * (e.g. `(ctx.inputs as Record<string,unknown>).prompt`) while the DAG scheduler
 * passes a port-map. For SOURCE nodes (no incoming edges) `inputs.input` is
 * unwrapped back to the original run inputs so nodes that ran under the linear
 * executor keep reading the same shape. For non-source nodes, port-keyed access
 * is the supported path going forward.
 *
 * ADR 0237: the unwrap is computed on the EDGE-derived inputs FIRST, and the
 * resolved declared inputs merge on top. Folding them in before the unwrap would
 * add keys that suppress the single-`input` unwrap and change `ctx.inputs` shape
 * under any source node that also declares inputs. A node with NO declared
 * inputs is byte-identical to the pre-ADR behaviour.
 */
export function buildNodeCtxInputs(
  inputsByPort: Record<string, unknown>,
  resolvedDeclaredInputs: Record<string, unknown>,
): unknown {
  const baseInputs: unknown =
    Object.keys(inputsByPort).length === 1 && 'input' in inputsByPort
      ? inputsByPort.input
      : inputsByPort;
  if (Object.keys(resolvedDeclaredInputs).length === 0) return baseInputs;
  return baseInputs && typeof baseInputs === 'object' && !Array.isArray(baseInputs)
    ? { ...(baseInputs as Record<string, unknown>), ...resolvedDeclaredInputs } // fixture wins on conflict
    : resolvedDeclaredInputs;
}
