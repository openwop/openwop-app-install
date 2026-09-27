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
