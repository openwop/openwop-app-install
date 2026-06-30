/**
 * feature.tool-output-compaction.nodes — an explicit mid-graph compaction node
 * (ADR 0099 Phase 3) over the `ctx.features['tool-output-compaction']` surface.
 * role:"action" — the engine records its output, so replay/fork read the recorded
 * result. The compaction kernel lives in the feature (one implementation); this
 * node only delegates. Pure-JS, Node-20 stdlib only.
 */

/** Resolve the compaction surface, or fail with the canonical capability error. */
function ensureSurface(ctx) {
  const s = ctx.features && ctx.features['tool-output-compaction'];
  if (!s || typeof s.compact !== 'function') {
    throw Object.assign(
      new Error(
        "host does not expose ctx.features['tool-output-compaction'] — the tool-output-compaction feature must be composed and enabled (ADR 0099 / ADR 0014)",
      ),
      { code: 'host_capability_missing', capability: 'host.sample.tool-output-compaction' },
    );
  }
  return s;
}

function inputs(ctx) {
  const i = ctx.inputs ?? {};
  const out = { input: typeof i.input === 'string' ? i.input : JSON.stringify(i.input ?? '') };
  if (typeof i.mode === 'string') out.mode = i.mode;
  if (typeof i.head === 'number') out.head = i.head;
  if (typeof i.tail === 'number') out.tail = i.tail;
  if (typeof i.minChars === 'number') out.minChars = i.minChars;
  return out;
}

export async function compact(ctx) {
  const surface = ensureSurface(ctx);
  const out = await surface.compact(inputs(ctx));
  return {
    status: 'success',
    outputs: {
      output: out.output,
      mode: out.mode,
      originalChars: out.originalChars,
      compactedChars: out.compactedChars,
    },
  };
}

export const nodes = {
  'feature.tool-output-compaction.nodes.compact': compact,
};

export default nodes;
