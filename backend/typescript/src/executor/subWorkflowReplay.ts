/**
 * ADR 0964 D1 — what a replay fork does when it SERVES a recorded `core.subWorkflow`
 * success instead of re-dispatching the child.
 *
 * The live node changed run state outside its outputs: `outputMapping` wrote the
 * child's values into the parent's bag. Serving the outputs alone would leave the
 * fork's bag without them. So, in order:
 *  1. the recorded `parentVariableWrites` (every run recorded since D1) → apply;
 *  2. a run recorded before D1 (no field): no `outputMapping`, or a child that did not
 *     complete → nothing to apply;
 *  3. otherwise rebuild the writes from the SOURCE child's durable terminal bag
 *     through this node's `outputMapping`, skipping undefined values;
 *  4. that bag is gone → fail closed (`replay_source_missing`).
 * It NEVER re-dispatches the child: that is the side effect replay exists to stop.
 */
import { readPersistedRunVariables, setRunVariable } from '../host/variablesRuntime.js';

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function applyServedSubWorkflow(
  runId: string,
  config: Record<string, unknown> | undefined,
  outputs: Record<string, unknown>,
): Promise<void> {
  if (isMap(outputs.parentVariableWrites)) {
    for (const [k, v] of Object.entries(outputs.parentVariableWrites)) if (v !== undefined) setRunVariable(runId, k, v);
    return;
  }
  const mapping = isMap(config?.outputMapping) ? config.outputMapping : null;
  if (!mapping || Object.keys(mapping).length === 0 || outputs.childStatus !== 'completed') return;
  const childRunId = typeof outputs.childRunId === 'string' ? outputs.childRunId : '';
  const childBag = childRunId ? await readPersistedRunVariables(childRunId).catch(() => null) : null;
  if (!childBag) {
    throw new Error(`Replay fork: the source sub-workflow run '${childRunId || '?'}' has no recorded variables to re-apply its outputMapping from; a replay never re-dispatches a child.`);
  }
  for (const [parentKey, childKey] of Object.entries(mapping)) {
    if (typeof childKey !== 'string') continue;
    const v = childBag[childKey];
    if (v !== undefined) setRunVariable(runId, parentKey, v);
  }
}
