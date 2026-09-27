/**
 * Conversation-resolve authorization (ADR 0327 P1).
 *
 * The ONE importable authz boundary for driving a suspended conversation gate:
 * the terminal-run check (ADR 0067 §Security) + the CS-BE-1 caller-visibility
 * gate, moved verbatim out of the orchestrator so the boundary is a module,
 * not an inline block that drifts.
 */

import { OpenwopError, type RunRecord } from '../../types.js';
import { isTerminalRunStatus } from '@openwop/openwop';
import { createLogger } from '../../observability/logger.js';
import { getConversationMeta } from '../conversationStore.js';
import { isVisibleToAsync } from '../conversationVisibility.js';

// Same component name as the orchestrator — the deny log's identity is an ops
// surface (RTV-4 dashboards key on it); the split must not rename it.
const logger = createLogger('host.conversationExchange');

/** Authorize one exchange/close against the run's gate. Throws 409 on a terminal
 *  run and a masked 404 on a visibility deny; returns the run's chat-session
 *  binding (`run.metadata.chatSessionId`, when stamped) for downstream keying. */
export async function authorizeConversationResolve(input: {
  run: RunRecord;
  runId: string;
  conversationId: string;
  callerUserId?: string | undefined;
}): Promise<{ chatSessionId: string | undefined }> {
  const { run, runId, conversationId, callerUserId } = input;
  // Fail closed on a terminal run (ADR 0067 §Security): a completed/failed/
  // cancelled run's gate is gone — neither an exchange nor a close may land.
  // (The token route maps stale tokens already; this guards the node route.)
  if (isTerminalRunStatus(run.status)) {
    throw new OpenwopError('interrupt_already_resolved', `conversation run is ${run.status}; the gate is closed`, 409, { conversationId });
  }

  // CS-BE-1 (conversation-stack audit 2026-07-09) — per-conversation authz.
  // `runs:read` alone let any same-tenant caller who learned a runId drive
  // another user's conversation (context exfil via the victim's stamped
  // actingUserId), and a forged `run.metadata.chatSessionId` at run-create
  // pointed a fresh run at a victim's thread (write injection). Bind BOTH
  // operations (exchange AND close) to the HTTP caller through the ONE
  // membership-aware visibility predicate the chat-session routes use.
  // Legacy/unowned metas stay tenant-visible (conformance + anon/demo flows
  // unchanged); failure masks existence with the route's own 404 vocabulary.
  const chatSessionId = typeof run.metadata?.['chatSessionId'] === 'string' && (run.metadata['chatSessionId'] as string).length > 0
    ? run.metadata['chatSessionId'] as string
    : undefined;
  const callerMeta = await getConversationMeta(run.tenantId, chatSessionId ?? conversationId).catch(() => null);
  const callerMayResolve = await isVisibleToAsync(callerMeta, run.tenantId, callerUserId).catch(() => false);
  if (!callerMayResolve) {
    // Audit the deny (RTV-4 posture): a probe against another user's
    // conversation run should be visible in ops, not silent. Ids only — no
    // content, and the RESPONSE still masks existence below.
    logger.warn('conversation_resolve_denied', {
      tenantId: run.tenantId, runId,
      conversationId: chatSessionId ?? conversationId,
      caller: callerUserId ? 'authenticated' : 'anonymous',
    });
    throw new OpenwopError('interrupt_not_found', 'no open interrupt for this node', 404);
  }
  return { chatSessionId };
}
