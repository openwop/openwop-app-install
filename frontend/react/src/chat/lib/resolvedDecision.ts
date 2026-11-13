/**
 * CC-CHAT-2 — the resume value a resolved interrupt's decision record shows.
 *
 * The subscription used to read it ONLY from the gate's `node.completed` output
 * (`nodeOutputs[node]`, wrapped as `{output: <resumeValue>}`). A REJECTED gate
 * fails its node (RFC 0223 `approval_rejected`), so it has no node output, and
 * the record fell back to its default verb: "Approved". The `interrupt.resolved`
 * event carries the decision itself (`decision: 'rejected'`, `action: 'reject'`
 * — the v2 `action` MUST), so a rejection there is a rejection here.
 */
import { isRecord } from './typeGuards.js';

export function resolvedResumeValue(nodeOutput: unknown, payload: Record<string, unknown> | undefined): unknown {
  const fromNode = isRecord(nodeOutput) && 'output' in nodeOutput ? nodeOutput.output : nodeOutput;
  const rejected = payload?.action === 'reject' || payload?.decision === 'rejected';
  if (!rejected) return fromNode;
  return { ...(isRecord(fromNode) ? fromNode : {}), action: 'reject' };
}
