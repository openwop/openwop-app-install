/**
 * The parent-side mirror of a sub-workflow child's gate is NOT a decision point.
 *
 * When a `core.subWorkflow` child stops at an approval or clarification, the node
 * returns `{status:'suspended', interrupt:{kind: <child's kind>, data:{childRunId,
 * childInterruptNodeId, childStatus}}}` (`bootstrap/nodes.ts`), and the executor opens
 * an ordinary interrupt of that kind on the PARENT. Nothing resolves it from the
 * child's side (a child-to-parent resume cascade is planned, after #5013). Before this guard,
 * any approver could resolve that mirror directly: the executor's native resume
 * marked the node completed with `{output: resumeValue}`, without the child's
 * outcome and without `outputMapping`, so the parent ran on as if the child had
 * finished while the child still waited at its own gate. A person could thereby
 * fabricate the result of a step they were never asked to approve.
 *
 * So every human and MCP resolve lane refuses it, before any claim. The real gate,
 * the child's, stays decidable. The parent remains waiting (stranded until the planned
 * resume cascade resumes it from the child), and cancel still works. That cascade replaces this
 * with a host-only resolver.
 *
 * Precision: the data marker alone could be authored on a `core.interrupt`, so the
 * refusal also requires the named child run to exist with `parentRunId` equal to
 * this interrupt's run.
 */
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';

interface MirrorShape { childRunId?: unknown; childInterruptNodeId?: unknown; childStatus?: unknown }

export async function assertNotSubWorkflowMirror(
  storage: Pick<Storage, 'getRun'>,
  interrupt: { runId: string; data?: unknown },
): Promise<void> {
  const d = (interrupt.data ?? {}) as MirrorShape;
  if (typeof d.childRunId !== 'string' || !d.childRunId || typeof d.childStatus !== 'string' || !('childInterruptNodeId' in d)) return;
  const child = await storage.getRun(d.childRunId);
  if (!child || child.parentRunId !== interrupt.runId) return;
  throw new OpenwopError(
    'conflict',
    'This step is waiting on a sub-workflow\'s own gate. Decide that gate in the sub-workflow run; this one cannot be resolved directly.',
    409,
    { reason: 'subworkflow_child_mirror', childRunId: d.childRunId },
  );
}
